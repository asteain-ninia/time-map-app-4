// UI layer (U32 / property panel): 「この保存はどの年に、どう効くのか」を押す前に決める
// 純粋ロジック（設計書 §D.3 の表 / 実装計画 増分 2 の中身 2）。
//
// **本増分の中核は「編集時刻は常に現在時刻である」**（設計書 §D.3、裁定 §N-2 の (A)）。
// これまで素性の保存は「選んでいる錨の開始時刻」に効いていたので、画面の真ん中に
// 「1200年」と出ていても保存すると 0 年の錨が黙って書き換わった。**「1500 年から国名が
// 変わった」を記録する手段が画面に 1 つも無かった**（現状分析 C2(a)）。
//
// 危険は裏返しにある: 上書きのつもりが新しい錨を増やしてしまう。だから**確定の前に、
// どちらになるかを必ず文字で見せる**（§N-2 の (A) が条件にしている）。この module は
// その 4 状態を決めるだけで、描画も dispatch もしない（純粋なので node のテストで固定できる）。
//
// 年の扱いについて 2 つ決めている。
//   1. **「年ちょうど」は粒度ではなく値で見る。** TimePoint の粒度は構造上の区別
//      （年だけ / 年月 / 年月日）なので、1573年1月1日 は粒度こそ年月日だが「年ちょうど」
//      である。錨を選ぶと現在時刻はその錨の開始時刻（実データ・テスト fixture ともに
//      年月日で書かれうる）へ同期するので、粒度で判定すると**正しい年にいるのに保存が
//      できなくなる**（教訓 5.19 の裏面: 値ではなく型で分岐すると意味を取り違える）。
//   2. **保存に渡す時刻は年へ丸める。** 実データの錨 689 本はすべて年だけで始まる。
//      年ちょうどの時刻から作る錨に月日を焼き付けない（U-14「月日を勝手に補わない」）。

import type { AnchorSeries } from '../../domain/anchor-series';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import { complete, timePointYear, type TimePoint } from '../../domain/time/time-point';

import { formatTimePoint, formatYear } from '../timeline/time-display';

/** 保存の行き先 4 状態（設計書 §D.3 の表）。典型的な分岐識別子（教訓 5.19）。 */
export const EDIT_PLAN_KIND = {
  /** 現在時刻ちょうどに錨がある ⇒ その錨のスナップショットを差し替える。 */
  Overwrite: 'overwrite',
  /** 錨は無いが、その時刻に地物は存在する ⇒ 新しい錨が 1 本増える。 */
  NewAnchor: 'newAnchor',
  /** その時刻に地物が存在しない ⇒ 保存できない。 */
  FeatureAbsent: 'featureAbsent',
  /** 現在時刻が年ちょうどでない ⇒ 保存できない（年に丸めれば押せる）。 */
  NotYearAligned: 'notYearAligned',
} as const;

export type EditPlanKind = (typeof EDIT_PLAN_KIND)[keyof typeof EDIT_PLAN_KIND];

/**
 * 新しい錨を 1 本作ったときに保存ファイルが増える量の見積り材料（設計書 §A.3 / §D.3 の
 * 「ファイルが約 306 KB 増えます」）。**錨 1 本はその履歴のスナップショットを丸ごと 1 部
 * 持つ**ので、まとめ役の子を 1 つ直しただけでも、その親が抱える下位ぜんぶの形が複製される。
 * 費用を知らずに記録を作れるのはよくない、という理由で画面に出す（脅しではない）。
 */
export interface AnchorSnapshotSize {
  /** その履歴の実効スナップショットが持つ地物の数。 */
  readonly featureCount: number;
  /** 同じスナップショットが持つ頂点の数。 */
  readonly vertexCount: number;
}

/**
 * 1 頂点・1 地物あたりの保存バイト数の目安。実データ
 * （derle-world-full-2026-08-16.gimoza）を scripts/measure-anchor-growth.ts で
 * 実測して決めた係数で、**桁を合わせるための概算**である（正確な値を出すには実際に
 * ZIP を作るしかなく、押す前に見せる用途には重すぎる）。
 */
export const BYTES_PER_SNAPSHOT_VERTEX = 75;
export const BYTES_PER_SNAPSHOT_FEATURE = 728;

/** 錨 1 本ぶんの保存量の概算（バイト）。 */
export function estimateAnchorBytes(size: AnchorSnapshotSize): number {
  return (
    size.vertexCount * BYTES_PER_SNAPSHOT_VERTEX +
    size.featureCount * BYTES_PER_SNAPSHOT_FEATURE
  );
}

/** 概算バイト数を「約 306 KB」の形にする。1 KB 未満は言い切る。 */
export function formatApproximateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '不明';
  if (bytes < 1024) return '1 KB 未満';
  if (bytes < 1024 * 1024) return `約 ${Math.round(bytes / 1024).toLocaleString('ja-JP')} KB`;
  return `約 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface EditPlanInput {
  /** いま地図が描いている時刻（＝これから編集時刻になるもの）。 */
  readonly currentTime: TimePoint;
  /**
   * その地物の編集が効く錨の系列。まとめ役の子（実データで 86 件）は自分の系列を
   * 持たず、親の系列に書かれるので、**呼び出し側が親の系列を渡す**（設計書 §C.6）。
   * 解決できないときは null。
   */
  readonly series: AnchorSeries | null;
  /** 現在時刻にその地物が解決できるか（＝地図に出ているか）。 */
  readonly featurePresent: boolean;
  readonly calendar: Calendar;
  /** 新しい錨を作るときに増える量の材料。無ければ概算を出さない（数字を捏造しない）。 */
  readonly snapshotSize?: AnchorSnapshotSize | null;
}

export interface EditPlan {
  readonly kind: EditPlanKind;
  /** 保存ボタンを押せるか。 */
  readonly savable: boolean;
  /**
   * 保存に渡す編集時刻。**年へ丸めてある**（U-14）。押せないときは null なので、
   * 呼び出し側は「時刻が無いなら dispatch しない」を型で守れる（教訓 5.18）。
   */
  readonly editTime: TimePoint | null;
  /** バッジの左（いまの時刻の見出し）。 */
  readonly badgeTime: string;
  /** バッジの右（何が起きるか）。 */
  readonly badgeNote: string;
  /** 保存ボタンの文言。**押す前に行き先が読める**（§N-2 の (A) の条件）。 */
  readonly saveLabel: string;
  /** 押せない理由（押せるときは null）。状態行ではなく**脇に常時**出す。 */
  readonly reason: string | null;
  /** 「年に丸める」で飛ぶ先（年ちょうどでないときだけ）。 */
  readonly roundedTime: TimePoint | null;
  /** 新しい錨で増える量の概算（新設のときだけ・材料があるときだけ）。 */
  readonly estimatedBytes: number | null;
}

/**
 * 「年ちょうど」か。**粒度ではなく値で見る**（module 冒頭の 1.）。月日を既定へ補完した
 * 結果が 1 月 1 日なら、その時刻は年の始まりを指している。
 */
export function isYearAligned(point: TimePoint): boolean {
  const c = complete(point);
  return c.month === 1 && c.day === 1;
}

/** その系列に「開始がちょうど at」の錨があるか。比較は U02 の単一経路を使う。 */
export function hasAnchorStartingAt(
  series: AnchorSeries | null,
  at: TimePoint,
  calendar: Calendar,
): boolean {
  if (series === null) return false;
  return series.entries.some((e) => compare(e.start, at, calendar) === 0);
}

/** 画面に出す言葉（1 か所に集める、NFR 5.7 / 教訓 5.29）。 */
export const EDIT_PLAN_STRINGS = {
  /** バッジの区切り。 */
  badgeSeparator: '｜',
  noteOverwrite: (year: string): string => `${year}の錨を直します`,
  noteNewAnchor: '錨を新しく作ります',
  noteNewAnchorWithCost: (bytes: string): string =>
    `錨を新しく作ります（ファイルが${bytes}増えます）`,
  noteFeatureAbsent: 'この年にはまだありません',
  noteNotYearAligned: '月日の付いた年には記録を作れません',
  saveLabelOverwrite: (year: string): string => `${year}の錨を上書き保存`,
  saveLabelNewAnchor: (year: string): string => `${year}に錨を作って保存`,
  /** 押せないときのボタン文言（行き先を約束しない）。 */
  saveLabelDisabled: '保存',
  reasonFeatureAbsent: (year: string): string =>
    `${year}にはこの地物がまだありません。存在する年へ移ると保存できます。`,
  reasonNotYearAligned: (full: string, year: string): string =>
    `いまは${full}です。錨の開始は年だけで記録するので、${year}へ丸めてから保存してください。`,
  /** 年に丸めるボタン。 */
  roundToYearLabel: (year: string): string => `${year}に丸める`,
  /** この年に錨を作る（Ctrl+K）。 */
  createAnchorHereLabel: (year: string): string => `${year}に錨を作る`,
  createAnchorHereDisabledReason: (year: string): string => `${year}にはすでに錨があります。`,
} as const;

/** 保存の行き先を決める（設計書 §D.3 の表そのもの）。 */
export function decideEditPlan(input: EditPlanInput): EditPlan {
  const { currentTime, series, featurePresent, calendar } = input;
  const yearLabel = formatYear(currentTime.year);

  // (1) 年ちょうどでない — レール由来の時刻は年へ丸めてあるので通常は起きないが、
  // 月/日の 1 歩送りと直接ジャンプは今も細かい粒度を作れる。**保険として残す**
  // （設計書 §D.3 の表の 4 行目 / §O の B-4）。
  if (!isYearAligned(currentTime)) {
    return {
      kind: EDIT_PLAN_KIND.NotYearAligned,
      savable: false,
      editTime: null,
      badgeTime: formatTimePoint(currentTime),
      badgeNote: EDIT_PLAN_STRINGS.noteNotYearAligned,
      saveLabel: EDIT_PLAN_STRINGS.saveLabelDisabled,
      reason: EDIT_PLAN_STRINGS.reasonNotYearAligned(formatTimePoint(currentTime), yearLabel),
      roundedTime: timePointYear(currentTime.year),
      estimatedBytes: null,
    };
  }

  const editTime = timePointYear(currentTime.year);

  // (2) その年に地物がいない。
  if (!featurePresent) {
    return {
      kind: EDIT_PLAN_KIND.FeatureAbsent,
      savable: false,
      editTime: null,
      badgeTime: yearLabel,
      badgeNote: EDIT_PLAN_STRINGS.noteFeatureAbsent,
      saveLabel: EDIT_PLAN_STRINGS.saveLabelDisabled,
      reason: EDIT_PLAN_STRINGS.reasonFeatureAbsent(yearLabel),
      roundedTime: null,
      estimatedBytes: null,
    };
  }

  // (3) その年ちょうどに錨がある ⇒ 上書き。
  if (hasAnchorStartingAt(series, editTime, calendar)) {
    return {
      kind: EDIT_PLAN_KIND.Overwrite,
      savable: true,
      editTime,
      badgeTime: yearLabel,
      badgeNote: EDIT_PLAN_STRINGS.noteOverwrite(yearLabel),
      saveLabel: EDIT_PLAN_STRINGS.saveLabelOverwrite(yearLabel),
      reason: null,
      roundedTime: null,
      estimatedBytes: null,
    };
  }

  // (4) 錨が無い ⇒ その年に 1 本作る。増える量の概算を添える（§A.3 の「費用」）。
  const size = input.snapshotSize ?? null;
  const estimatedBytes = size === null ? null : estimateAnchorBytes(size);
  return {
    kind: EDIT_PLAN_KIND.NewAnchor,
    savable: true,
    editTime,
    badgeTime: yearLabel,
    badgeNote:
      estimatedBytes === null
        ? EDIT_PLAN_STRINGS.noteNewAnchor
        : EDIT_PLAN_STRINGS.noteNewAnchorWithCost(formatApproximateBytes(estimatedBytes)),
    saveLabel: EDIT_PLAN_STRINGS.saveLabelNewAnchor(yearLabel),
    reason: null,
    roundedTime: null,
    estimatedBytes,
  };
}
