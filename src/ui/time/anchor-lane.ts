// UI layer (U21 / 時刻レール): 錨レーンの純粋ロジック（設計書 §F.2 の 7 規則）。
//
// **描く図形の数をデータ量から切り離す**のがこの module の役目である。裁定 2 は
// 「(a) 印を出すのは選択中の地物だけ (b) 1 地物でも印が極めて多い前提で」と課しており、
// 設計は「1 地物が 5 万錨」を想定してよいと読む（§F.2）。素直に錨 1 本＝図形 1 個で
// 描くと 5 万個の図形になるので、**画素の列ごとに件数を数え、1 本なら印・2 本以上なら
// 密度帯**に畳む。図形の数は軸の画素数（1600 幅なら 1568）で頭打ちになる。
//
// **費用の置き場所を 2 つに分ける**（規則 3 と規則 4）。
//   - 選択が変わったとき … 系列を引き、U02 の正規化を 1 回だけ通して {@link AnchorLaneSource}
//     を作る。まとめ役の子（実データで 86 件）はここで親の系列から選り分ける
//     （選り分けそのものは増分 2 で錨表に入れた `anchorRowsOf` が行う）。
//   - 表示範囲・幅が変わったとき … {@link aggregateAnchorLane} の 1 パスだけを走らせる。
//     **正規化はこの経路に 1 回も出てこない** ―― `normalize` はグレゴリオ暦なら O(1) だが
//     月の長さを 12 回足す定数費用があり、5 万錨 × 表示範囲の変化ごとに走らせると
//     受け入れ条件（再集計 16ms 以内）を素通しできない。
//
// **現在時刻が動いただけでは再集計しない**（規則 4）。再生ヘッドの位置を描き直すだけで
// よいので、再生中に毎フレーム 5 万錨を数え直すことは無い。
//
// 純粋（framework-free）なので node のテストで固定できる（教訓 5.41）。

import type { Calendar } from '../../domain/time/calendar';
import { denormalize, normalize, type Normalized } from '../../domain/time/normalized';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';

import {
  MIN_VIEW_DAYS,
  ZOOM_STEP,
  viewSpanDays,
  zoomView,
  type TimeBarView,
} from './timebar';

/** 存続している期間 1 本（U02 正規化の日数）。`endDay` が null なら継続中。 */
export interface LaneRun {
  readonly startDay: number;
  readonly endDay: number | null;
}

/**
 * レーンの素材。**選択が変わったときだけ**作り直す（規則 4 の再集計の契機には乗らない）。
 * `starts` は昇順（系列の不変条件 INV-1 が保証する）で、二分探索の前提でもある。
 */
export interface AnchorLaneSource {
  /** 錨の開始（U02 正規化の日数）。昇順。 */
  readonly starts: Float64Array;
  /** 存続している期間。空白の期間は「区間と区間のあいだ」として残る（FR-60）。 */
  readonly runs: readonly LaneRun[];
}

/** 錨を 1 本も持たないレーン（選択が無いとき）。 */
export const EMPTY_LANE_SOURCE: AnchorLaneSource = {
  starts: new Float64Array(0),
  runs: [],
};

/**
 * 素材を組む。**U02 の正規化を通るのはここだけ**で、以降の集計・当たり判定・ジャンプは
 * すべて日数の整数で行う。
 *
 * **前提: `starts` は昇順**（系列の不変条件 INV-1「厳密に増加する開始時刻」）。ここで
 * 並べ替え直さないのは、呼び出し側が同じ添字で錨そのもの（`AnchorEntry`）を持って
 * いるからである ―― 日数だけを並べ替えると添字の対応が黙って壊れ、`[` `]` のジャンプが
 * 別の錨へ飛ぶ。選り分け（まとめ役の子）で間引いても順序は保たれる。
 */
export function laneSourceOf(
  starts: readonly TimePoint[],
  runs: readonly { readonly start: TimePoint; readonly end: TimePoint | null }[],
  calendar: Calendar,
): AnchorLaneSource {
  const days = new Float64Array(starts.length);
  for (let i = 0; i < starts.length; i += 1) {
    const p = starts[i];
    days[i] = p === undefined ? 0 : (normalize(p, calendar) as number);
  }
  return {
    starts: days,
    runs: runs.map((r) => ({
      startDay: normalize(r.start, calendar) as number,
      endDay: r.end === null ? null : (normalize(r.end, calendar) as number),
    })),
  };
}

/** 1 パス集計の結果。図形の数は {@link AnchorLaneAggregate.shapeCount} で観測できる。 */
export interface AnchorLaneAggregate {
  /** 画素の列ごとの件数。長さは {@link width}。 */
  readonly counts: Uint32Array;
  /** 軸の画素数。 */
  readonly width: number;
  /** 視野に入った錨の本数。 */
  readonly inView: number;
  /** いちばん混んでいる列の件数（濃さと高さの基準）。 */
  readonly maxCount: number;
  /** 件数 1 の列の数（＝菱形の印の数）。 */
  readonly markCount: number;
  /** 件数 2 以上の列の数（＝密度帯の縦棒の数）。 */
  readonly denseCount: number;
  /** 描く図形の数。**軸の画素数を超えない**（受け入れ条件）。 */
  readonly shapeCount: number;
}

const EMPTY_COUNTS = new Uint32Array(0);

/** 空の集計（幅が 0、または錨が 1 本も無いとき）。 */
export const EMPTY_LANE_AGGREGATE: AnchorLaneAggregate = {
  counts: EMPTY_COUNTS,
  width: 0,
  inView: 0,
  maxCount: 0,
  markCount: 0,
  denseCount: 0,
  shapeCount: 0,
};

/**
 * 規則 3 の 1 パス集計。`Uint32Array` 1 本へ数え込むだけで、図形は 1 つも作らない。
 *
 * `scratch` を渡すと使い回す（幅が同じなら確保し直さない）。**渡さなければ毎回確保する**
 * ので、テストからは素直に呼べる。呼び出し側（レーンの hook）は自分の ref を渡して
 * 5 万錨の再集計で GC を起こさないようにする。
 */
export function aggregateAnchorLane(
  source: AnchorLaneSource,
  view: TimeBarView,
  scratch?: Uint32Array,
): AnchorLaneAggregate {
  const width = Math.max(0, Math.floor(view.pixelLength));
  const span = viewSpanDays(view);
  if (width <= 0 || span <= 0) return EMPTY_LANE_AGGREGATE;

  const counts =
    scratch !== undefined && scratch.length === width ? scratch : new Uint32Array(width);
  counts.fill(0);

  const min = view.min as number;
  const scale = width / span;
  const starts = source.starts;
  let inView = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const x = ((starts[i] as number) - min) * scale;
    if (x < 0 || x >= width) continue;
    const column = x | 0;
    counts[column] = (counts[column] as number) + 1;
    inView += 1;
  }

  let maxCount = 0;
  let markCount = 0;
  let denseCount = 0;
  for (let i = 0; i < width; i += 1) {
    const c = counts[i] as number;
    if (c === 0) continue;
    if (c === 1) markCount += 1;
    else denseCount += 1;
    if (c > maxCount) maxCount = c;
  }

  return {
    counts,
    width,
    inView,
    maxCount,
    markCount,
    denseCount,
    shapeCount: markCount + denseCount,
  };
}

/** 件数 1 の列の画素位置（左端からの px）。観測口 `getAnchorMarkPositions()` が読む。 */
export function markColumnsOf(aggregate: AnchorLaneAggregate): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < aggregate.width; i += 1) {
    if (aggregate.counts[i] === 1) out.push(i);
  }
  return out;
}

// --- 当たり判定と前後ジャンプ（規則 6 の逃げ道 3 つ） -----------------------

/** レーンを押した／触れたときの答え。 */
export const LANE_HIT = {
  /** 錨が届かない。 */
  None: 'none',
  /** ちょうど 1 本。 */
  Single: 'single',
  /** 2 本以上。**個別の錨は返さない**（規則 2）。 */
  Dense: 'dense',
} as const;

export type LaneHitKind = (typeof LANE_HIT)[keyof typeof LANE_HIT];

export interface LaneHit {
  readonly kind: LaneHitKind;
  /** 届いた錨の本数。 */
  readonly count: number;
  /** 届いた範囲の最初の錨の添字（`starts` の添字）。届かなければ -1。 */
  readonly firstIndex: number;
  /** 同じく最後の錨の添字。届かなければ -1。 */
  readonly lastIndex: number;
}

const NO_HIT: LaneHit = { kind: LANE_HIT.None, count: 0, firstIndex: -1, lastIndex: -1 };

/** ヒットの許容（px）。§F.2「±4px 以内の錨を返す」。 */
export const LANE_HIT_TOLERANCE_PX = 4;

/** `starts` のうち `day` 以上の最初の添字（lower bound）。無ければ length。 */
export function lowerBound(starts: Float64Array, day: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `starts` のうち `day` より大きい最初の添字（upper bound）。無ければ length。 */
export function upperBound(starts: Float64Array, day: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 画素位置 → 日数（端は視野の外へ出さない）。 */
export function pixelToDay(px: number, view: TimeBarView): number {
  const span = viewSpanDays(view);
  if (view.pixelLength <= 0 || span <= 0) return view.min as number;
  const f = px / view.pixelLength;
  return (view.min as number) + f * span;
}

/** 日数 → 画素位置（視野の外でもそのまま返す。描画側が捨てる）。 */
export function dayToPixel(day: number, view: TimeBarView): number {
  const span = viewSpanDays(view);
  if (span <= 0) return 0;
  return ((day - (view.min as number)) / span) * view.pixelLength;
}

/**
 * 画素位置の時刻。**年に丸める**（設計書 §O の B-4 / 増分 2 の中身 1c）。1px が数年に
 * 当たる軸では位置から出した月日に意味が無く、編集時刻は現在時刻に一本化されているので、
 * 丸めずに置くと月日つきの錨が保存ファイルに増える。**位置が時刻になる場所はここ 1 つ**
 * にして、下流のどの消費者も自衛しなくてよい形にする（教訓 5.29）。
 */
export function yearAtPixel(
  px: number,
  view: TimeBarView,
  calendar: Calendar,
): TimePoint {
  const day = Math.round(pixelToDay(px, view));
  return timePointYear(denormalize(day as Normalized, calendar).year);
}

/**
 * `px` の前後 {@link LANE_HIT_TOLERANCE_PX} に入る錨を **二分探索** で数える
 * （§F.2 のヒットテスト）。5 万錨でも O(log n) で、受け入れ条件の 1ms を素直に満たす。
 */
export function laneHitTest(
  source: AnchorLaneSource,
  view: TimeBarView,
  px: number,
  tolerancePx: number = LANE_HIT_TOLERANCE_PX,
): LaneHit {
  if (source.starts.length === 0) return NO_HIT;
  const min = view.min as number;
  const max = view.max as number;

  // ①**押した画素列そのものに 1 本だけなら、その錨を返す**（2026-09-07 の手直し）。
  //
  // 旧版はいきなり ±4px で数えていたので、**隣の印が 4px 未満のところにあると
  // 「2 本以上」になり、印を狙って押しても飛ばずに 1 段拡大した**（実機で再現）。
  // 描いてあるのは画素の列なので、**列の中に 1 本しか無いなら、それが押されたもの**
  // である（描画と当たり判定を同じ単位で見る＝教訓 5.29）。
  const columnDays = view.pixelLength > 0 ? viewSpanDays(view) / view.pixelLength : 0;
  if (columnDays > 0) {
    const column = Math.floor(px);
    const colLo = Math.max(min, pixelToDay(column, view));
    const colHi = Math.min(max, pixelToDay(column + 1, view));
    if (colHi > colLo) {
      // **列も半開区間 [colLo, colHi) で数える**（2026-09-07 の最終手直し）。
      // 集計（`aggregateAnchorLane`）は画素の列を半開区間で割り当てるので、`upperBound`
      // で右端を含めると **時間軸の上限ちょうどに始まる錨**（集計は数えない）に
      // 当たり判定だけが当たっていた ―― 印が 1 つも描かれていない列で「1 本ある」と
      // 言うことになる。
      const cFirst = lowerBound(source.starts, colLo);
      const cLast = lowerBound(source.starts, colHi) - 1;
      if (cLast === cFirst && cFirst >= 0 && cFirst < source.starts.length) {
        return { kind: LANE_HIT.Single, count: 1, firstIndex: cFirst, lastIndex: cFirst };
      }
    }
  }

  // ②それ以外は ±`tolerancePx` で数える。**視野の外の錨は数えない** ―― 集計（描画）は
  // 半開区間 [min, max) で右端を捨てるのに、当たり判定だけが視野の外の錨に当たると、
  // **見えていない錨へ飛ぶ**（描画 ⊇ ヒットが破れる）。
  const lo = Math.max(min, pixelToDay(px - tolerancePx, view));
  const hi = Math.min(max, pixelToDay(px + tolerancePx, view));
  if (hi <= lo) return NO_HIT;
  const first = lowerBound(source.starts, lo);
  // 右端は集計と同じ半開（`max` ちょうどの錨は視野の外）。
  const last = lowerBound(source.starts, hi) - 1;
  if (last < first) return NO_HIT;
  const count = last - first + 1;
  return {
    kind: count === 1 ? LANE_HIT.Single : LANE_HIT.Dense,
    count,
    firstIndex: first,
    lastIndex: last,
  };
}

/**
 * 1 つ前の錨の添字（`day` より **前** に始まる最後の錨）。端では -1。
 * 二分探索なので対数時間（受け入れ条件「`[` `]` のジャンプが対数時間」）。
 */
export function previousAnchorIndex(starts: Float64Array, day: number): number {
  return lowerBound(starts, day) - 1;
}

/** 1 つ次の錨の添字（`day` より **後** に始まる最初の錨）。端では -1。 */
export function nextAnchorIndex(starts: Float64Array, day: number): number {
  const i = upperBound(starts, day);
  return i >= starts.length ? -1 : i;
}

// --- 逃げ道 1（1 段拡大）と逃げ道 2（束の吹き出し） -------------------------

/**
 * 1 段の拡大率。**「その範囲へ 1 段」**（§F.2 規則 6-1）は「押すたびに軸が狭まり、
 * やがて件数 1 の印にほどける」ことなので、1 回で列の幅まで飛ばさず一定の率で寄せる。
 * 4 倍だと 1 万年の軸は 7 回で 1 年強まで下りる。
 */
export const LANE_ZOOM_FACTOR = 4;

/**
 * 押した画素列へ 1 段拡大した表示範囲を返す。**その列の時間範囲より狭くはしない**
 * （それ以上寄せても列の中身は変わらないので、寄せ続ける意味がない）。
 */
export function zoomLaneStep(
  view: TimeBarView,
  focusPx: number,
  calendar: Calendar,
): TimeBarView {
  const span = viewSpanDays(view);
  if (span <= 0 || view.pixelLength <= 0) return view;
  const columnSpan = span / view.pixelLength;
  const target = Math.max(span / LANE_ZOOM_FACTOR, columnSpan, MIN_VIEW_DAYS);
  if (target >= span) return view;
  // 拡大の実体は `timebar.zoomView` 1 本に通す（教訓 5.29 単一の判定）。刻みは
  // `ZOOM_STEP` の指数なので、目標の幅から刻み数を割り出して渡す。
  const notches = Math.log(target / span) / Math.log(ZOOM_STEP);
  return zoomView(view, notches, focusPx, calendar);
}

/** 密集した列を押したときの行き先。 */
export const LANE_DENSE_ACTION = {
  /** まだほどける ⇒ 1 段拡大する（逃げ道 1）。 */
  Zoom: 'zoom',
  /** これ以上ほどけない ⇒ 束の吹き出しを出す（逃げ道 2）。 */
  Bundle: 'bundle',
} as const;

export type LaneDenseAction =
  (typeof LANE_DENSE_ACTION)[keyof typeof LANE_DENSE_ACTION];

/**
 * 密集した列を押したときに拡大でほどけるか（§F.2 規則 6）。
 *
 * **「十分に拡大しても同じ画素に重なるとき（1 年に複数の錨があるとき）」が束の出番**である
 * ―― 条文のこの括弧が判定そのものになる。錨の開始は年で記録する（U-14）ので、**届いた
 * 錨がぜんぶ同じ年なら、それ以上拡大しても「年としては同じ」ものが並ぶだけ**で、
 * ほどいた先に読み分ける手がかりが無い。そこで一覧（束の吹き出し）へ切り替える。
 *
 * **「同じ日か」で見てはいけない。** 系列の不変条件 INV-1 は開始時刻が厳密に増加すること
 * を保証するので、同じ日の錨は 2 本と存在し得ない ―― 日で見ると束は**永久に出ない**
 * （＝逃げ道 2 が死んだ枝になる）。表示範囲が下限まで寄っているときも束にする。
 */
export function laneDenseAction(
  source: AnchorLaneSource,
  view: TimeBarView,
  hit: LaneHit,
  calendar: Calendar,
): LaneDenseAction {
  if (hit.kind !== LANE_HIT.Dense) return LANE_DENSE_ACTION.Zoom;
  const first = source.starts[hit.firstIndex];
  const last = source.starts[hit.lastIndex];
  if (first === undefined || last === undefined) return LANE_DENSE_ACTION.Zoom;
  if (viewSpanDays(view) <= MIN_VIEW_DAYS) return LANE_DENSE_ACTION.Bundle;
  const firstYear = denormalize(Math.round(first) as Normalized, calendar).year;
  const lastYear = denormalize(Math.round(last) as Normalized, calendar).year;
  return firstYear === lastYear ? LANE_DENSE_ACTION.Bundle : LANE_DENSE_ACTION.Zoom;
}

// --- 存続している期間の帯 ---------------------------------------------------

/** 画面に出す帯 1 本（px）。視野の外は切り落とす。 */
export interface LaneSegment {
  readonly startPx: number;
  readonly endPx: number;
  /**
   * その帯が **終わっているか**（終了が打たれていて、その位置が表示範囲の中にある）。
   * 終端の印を立てるのに使う（司令塔の決定 (12)：「この年に終わったことにする」を
   * 押したあと、終端がレーンで見える）。
   */
  readonly closed: boolean;
}

/**
 * 存続している期間を画素の区間に直す。**空白の期間（穴）は区間と区間のあいだとして
 * 残る**（FR-60 の条文どおり）。継続中（`endDay === null`）は右端まで伸ばす。
 */
export function runSegments(
  source: AnchorLaneSource,
  view: TimeBarView,
): readonly LaneSegment[] {
  const out: LaneSegment[] = [];
  if (view.pixelLength <= 0 || viewSpanDays(view) <= 0) return out;
  for (const run of source.runs) {
    const rawStart = dayToPixel(run.startDay, view);
    const rawEnd =
      run.endDay === null ? view.pixelLength : dayToPixel(run.endDay, view);
    const startPx = Math.max(0, Math.min(view.pixelLength, rawStart));
    const endPx = Math.max(0, Math.min(view.pixelLength, rawEnd));
    if (endPx <= startPx) continue;
    // 「終わっている」帯かどうかを持たせる（司令塔の決定 (12)）。終端の印を
    // 錨の菱形と区別できる形で立てるために、描く側が必要とする。
    out.push({ startPx, endPx, closed: run.endDay !== null && rawEnd <= view.pixelLength });
  }
  return out;
}

/**
 * 密度帯の高さの割合（0〜1）。件数が増えるほど高く・濃くする。**対数**で伸ばすのは、
 * 1 対 50000 の比を線形で描くと 2 件と 20 件が見分けられなくなるためである。
 */
export function densityRatio(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 1) return count > 0 ? 1 : 0;
  return Math.min(1, Math.log(count) / Math.log(maxCount));
}
