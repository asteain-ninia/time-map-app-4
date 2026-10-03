// U31 deletion — 「その時刻に効いている全系列の束」で掃除する（所有者の裁定 2026-09-07「直す」）。
//
// **何が壊れていたか**: U31 の削除は錨を 1 枚ずつ掃除していた（DeletionState は全系列の錨を
// 平らに並べたもの）。記録の置き場を直して（司令塔の決定 (1)）子が自分の系列を持つように
// なると、まとめ役の錨の中には子が 1 件も居ない。錨 1 枚だけを見ると「下位領域を全部失った
// まとめ役」に見えるので、**何を消しても**そのまとめ役が連鎖剪定されていた。実際に起きた
// のは「まとめ役 P を消す → P から外へ移した子の行き先のまとめ役 Q まで消え、子の上位領域が
// 『なし』になる」である（連邦化で作ったまとめ役でも同じ）。
//
// **直し方**: 錨ごとに、その錨の始まる時刻に **全系列で効いている錨の地物**を束ねた「束」へ
// 載せる（DeletionState.bundling）。掃除と連鎖剪定は束の上で判定し、書き戻すのは
// その錨自身の地物だけ。こうすると Q の錨の束には Q を親とする子が居るので Q は残り、
// 子を本当に全部失ったまとめ役だけが消える（教訓 5.6: 結果状態で判定する、の判定範囲を
// 「錨 1 枚」から「その時刻の世界」へ正した）。
//
// 教訓 5.21「削除は参照掃除と連鎖剪定まで行う。片方向・単一時点だけの掃除は dangling 参照を
// 残す」の適用: 自分の系列を持つ子が消える親を指していても、子の錨には親が居ないので
// 以前は掃除されなかった（保存前検査が「消えた親を指す parentId」で保存を止める形）。
// 束の上で掃除するので、子の parentId も同じ操作で外れる。
//
// 純粋: 入力を変更せず新しい histories を返す。

import { createAnchorSnapshot, type Anchor, type AnchorSnapshot } from '../anchor';
import { resolveAt, type AnchorEntry } from '../anchor-series';
import { materializeOwnSeries, residentFeatureIds } from '../affiliation/materialize';
import type { Feature } from '../feature';
import type { DomainId, FeatureId } from '../ids';
import type { FeatureHistory } from '../persistence/serialize';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import { createVertexStore, type Vertex } from '../vertex';

import { createDeleteFeatureCommand, isNoOpDeletion } from './command';
import {
  createDeletionState,
  type DeletionBundleSlot,
  type DeletionState,
} from './state';

/** 平らにした錨 1 枚が、どの系列のどの錨から来たか。 */
export interface HistoryAnchorOrigin {
  readonly historyIndex: number;
  readonly entryIndex: number;
}

/** 系列の並びから組んだ削除の見方（束つき）と、錨ごとの出どころ。 */
export interface BundledDeletionState {
  readonly state: DeletionState;
  readonly origins: readonly HistoryAnchorOrigin[];
}

function timeKey(t: TimePoint): string {
  return JSON.stringify(t);
}

/**
 * 系列の並びから、錨を「その時刻の全系列の束」に載せた削除の見方を組む（純粋）。
 *
 * 束は **相異なる開始時刻ごとに 1 つ**: その時刻に効いている各系列の錨の地物を系列の順に
 * 連結し、頂点も同じ順に重ねる（後の系列が勝つ ―― 画面の束ね方と同じ）。錨 (h, e) は、
 * e が自分の開始時刻に系列 h で効いている錨なら、その時刻の束の「h の範囲」に載る。
 * 同じ時刻に始まる錨は同じ束を共有するので、掃除も判定も束ごとに 1 回で済む
 * （錨ごとに束を作ると、実データ 689 系列で数十秒かかった）。
 *
 * 錨は区間 [start, end) に効くが、束は **始まりの時刻**で組む。錨 1 枚は丸ごと書き換えるか
 * 残すかしか選べないので、書き戻しはその錨が始まる時点の世界の掃除の結果で行う。ただし
 * **まとめ役の連鎖剪定だけは区間の途中も見る**（増分 7 の手直し 2 回目 / 反証 #3・GPT #3）:
 * 区間の途中にある全系列の境目の時刻ごとの束を `interior` で引けるようにし、区間のどこかで
 * 子が居るまとめ役は剪定しない（`sweep-state.ts`）。途中の束は必要になったときだけ組む。
 * 自分の開始時刻に効いていない錨（同じ開始の錨が 2 つある壊れた系列など）は束に載せず、
 * 錨 1 枚で掃除する。
 */
export function deletionStateFromHistories(
  histories: readonly FeatureHistory[],
  calendar: Calendar,
): BundledDeletionState {
  interface Bundle {
    readonly index: number;
    readonly row: readonly (AnchorEntry | undefined)[];
    /** 系列ごとの、束の地物列の中の範囲（効いていない系列は undefined）。 */
    readonly ranges: readonly ({ readonly from: number; readonly to: number } | undefined)[];
  }
  const bundleByTime = new Map<string, Bundle>();
  const bundles: AnchorSnapshot[] = [];
  /** その時刻に効いている全系列の錨の地物を系列の順に連結した写し（区間の途中の束）。 */
  const interiorByTime = new Map<string, AnchorSnapshot>();
  const snapshotAt = (t: TimePoint): AnchorSnapshot => {
    const key = timeKey(t);
    const known = bundleByTime.get(key);
    if (known !== undefined) return bundles[known.index]!;
    const cached = interiorByTime.get(key);
    if (cached !== undefined) return cached;
    const features: Feature[] = [];
    const vertices: Vertex[] = [];
    for (const h of histories) {
      const r = resolveAt(h.series, t, calendar);
      if (r.kind !== 'present') continue;
      features.push(...r.entry.anchor.snapshot.features);
      for (const v of r.entry.anchor.snapshot.vertices.byId.values()) vertices.push(v);
    }
    const snapshot = createAnchorSnapshot(features, createVertexStore(vertices));
    interiorByTime.set(key, snapshot);
    return snapshot;
  };
  const bundleAt = (t: TimePoint): Bundle => {
    const key = timeKey(t);
    const cached = bundleByTime.get(key);
    if (cached !== undefined) return cached;
    const row = histories.map((h) => {
      const r = resolveAt(h.series, t, calendar);
      return r.kind === 'present' ? r.entry : undefined;
    });
    const features: Feature[] = [];
    const vertices: Vertex[] = [];
    const ranges = row.map((entry) => {
      if (entry === undefined) return undefined;
      const from = features.length;
      features.push(...entry.anchor.snapshot.features);
      for (const v of entry.anchor.snapshot.vertices.byId.values()) vertices.push(v);
      return { from, to: features.length };
    });
    const bundle: Bundle = { index: bundles.length, row, ranges };
    bundles.push(createAnchorSnapshot(features, createVertexStore(vertices)));
    bundleByTime.set(key, bundle);
    return bundle;
  };

  const anchors: Anchor[] = [];
  const slots: (DeletionBundleSlot | undefined)[] = [];
  const origins: HistoryAnchorOrigin[] = [];
  /** 錨ごとの区間 [始まり, 実際の終わり)（`interior` が途中の境目を探すのに使う）。 */
  const spans: { readonly start: TimePoint; readonly end: TimePoint | null }[] = [];
  histories.forEach((history, historyIndex) => {
    const entries = history.series.entries;
    entries.forEach((entry, entryIndex) => {
      const bundle = bundleAt(entry.start);
      const range = bundle.ranges[historyIndex];
      const onBundle = bundle.row[historyIndex] === entry && range !== undefined;
      anchors.push(entry.anchor);
      slots.push(onBundle ? { bundle: bundle.index, from: range.from, to: range.to } : undefined);
      origins.push({ historyIndex, entryIndex });
      const next = entries[entryIndex + 1];
      const end =
        entry.end === null
          ? (next?.start ?? null)
          : next !== undefined && compare(next.start, entry.end, calendar) < 0
            ? next.start
            : entry.end;
      spans.push({ start: entry.start, end });
    });
  });

  // 全系列の境目の時刻（始まりと終わり）を昇順に 1 度だけ並べる（必要になってから）。
  let boundaries: readonly TimePoint[] | null = null;
  const allBoundaries = (): readonly TimePoint[] => {
    if (boundaries !== null) return boundaries;
    const byKey = new Map<string, TimePoint>();
    for (const h of histories) {
      for (const e of h.series.entries) {
        byKey.set(timeKey(e.start), e.start);
        if (e.end !== null) byKey.set(timeKey(e.end), e.end);
      }
    }
    boundaries = [...byKey.values()].sort((a, b) => compare(a, b, calendar));
    return boundaries;
  };
  const interiorMemo = new Map<number, readonly AnchorSnapshot[]>();
  const interior = (anchorIndex: number): readonly AnchorSnapshot[] => {
    const hit = interiorMemo.get(anchorIndex);
    if (hit !== undefined) return hit;
    const span = spans[anchorIndex];
    if (span === undefined) return [];
    const out: AnchorSnapshot[] = [];
    for (const t of allBoundaries()) {
      if (compare(t, span.start, calendar) <= 0) continue;
      if (span.end !== null && compare(t, span.end, calendar) >= 0) break;
      out.push(snapshotAt(t));
    }
    interiorMemo.set(anchorIndex, out);
    return out;
  };
  return { state: createDeletionState(anchors, { bundles, slots, interior }), origins };
}

/** {@link deleteFeatureFromHistories} の結果: 消した後の系列と、地物の生死。 */
export interface HistoryDeletionOutcome {
  readonly histories: readonly FeatureHistory[];
  /** 全部の年から居なくなった系列の持ち主（対象＋連鎖で消えたまとめ役）。 */
  readonly deleted: ReadonlySet<DomainId>;
  /** 消した後も系列を持って生き残った地物（居候から独立した子を含む）。 */
  readonly survived: ReadonlySet<DomainId>;
}

/**
 * `targetId` を全部の年から消した後の系列を組む（純粋）。対象がどこにも居なければ `null`
 * （取り消しの段を積まない ―― 教訓 5.24）。
 *
 * 1. 対象の錨に居候している子・孫を、全部の年ぶん自分の系列へ起こす（決定 (1)。60 州が
 *    丸ごと消えた件の直し）。
 * 2. 錨をその開始時刻の束（全系列）に載せて平らにし、U31 の削除（掃除＋連鎖剪定）を 1 回だけ走らせる。
 * 3. 掃除した錨を元の系列・元の位置へ書き戻す（開始・終了は変えない）。全部の錨が空に
 *    なった系列は落とす（持ち主の居ない空の系列を残さない）。
 */
export function deleteFeatureFromHistories(
  histories: readonly FeatureHistory[],
  targetId: FeatureId,
  calendar: Calendar,
): HistoryDeletionOutcome | null {
  const prepared = materializeOwnSeries(
    histories,
    residentFeatureIds(histories, targetId),
    calendar,
  ).histories;

  const { state: before, origins } = deletionStateFromHistories(prepared, calendar);
  if (isNoOpDeletion(before, targetId)) return null;

  const outcome = createDeleteFeatureCommand(before, targetId).execute(before);
  const afterAnchors = outcome.state.anchors;

  const rebuiltEntries = prepared.map((h) => h.series.entries.map((e) => e));
  afterAnchors.forEach((anchor, flatIndex) => {
    const origin = origins[flatIndex];
    if (origin === undefined) return;
    const slot = rebuiltEntries[origin.historyIndex];
    const entry = slot?.[origin.entryIndex];
    if (slot === undefined || entry === undefined) return;
    slot[origin.entryIndex] = { anchor, start: entry.start, end: entry.end };
  });

  const out: FeatureHistory[] = [];
  prepared.forEach((history, historyIndex) => {
    const entries = rebuiltEntries[historyIndex];
    if (entries === undefined) return;
    if (entries.every((e) => e.anchor.snapshot.features.length === 0)) return;
    out.push({ featureId: history.featureId, series: { entries } });
  });

  // 母集合は「起こした後」の系列の持ち主。居候から独立した子は消えたのではなく生き残る。
  const baselineIds = new Set<FeatureId>(prepared.map((h) => h.featureId));
  const finalIds = new Set<FeatureId>(out.map((h) => h.featureId));
  const deleted = new Set<DomainId>();
  const survived = new Set<DomainId>();
  for (const id of baselineIds) {
    if (finalIds.has(id)) survived.add(id);
    else deleted.add(id);
  }
  return { histories: out, deleted, survived };
}
