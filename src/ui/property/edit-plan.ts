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
//   2. **年へ丸めるのは「新しい錨を作る」ときだけ。** 実データの錨 689 本はすべて
//      年だけで始まるので、新しく作る錨に月日を焼き付けない（U-14「月日を勝手に
//      補わない」）。**逆に、既にある錨の開始とちょうど同じ時刻にいるなら、その錨の
//      粒度が年月日でも上書きを許す。** 丸めてから一致を見ると、月日つきの開始を
//      持つ錨だけが永久に編集できなくなる（設計 B1 / GPT#1 / 反証 F9）。

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
 * 1 頂点・1 地物あたりの **圧縮前（manifest = JSON）** のバイト数の目安。実データ
 * （derle-world-full-2026-08-16.gimoza）を scripts/measure-anchor-growth.ts で
 * 実測して決めた係数で、**桁を合わせるための概算**である（正確な値を出すには実際に
 * ZIP を作るしかなく、押す前に見せる用途には重すぎる）。
 *
 * **どちら向きに外れるか**（2026-09-04 の実測）: 錨 689 本の「概算 ÷ 実測」は中央値
 * 1.10・最小 0.98・最大 1.54 で、**97.8 % の錨で概算が実測を上回る**（＝小さい錨では
 * 多めに出る）。判断材料になる大きな錨ではほぼ一致し、デーレ共和国の錨 1 本で 0.99、
 * 50 回編集の実増分に当てても 0.99 だった。利用者を脅かす方向へ大きく外れることはない。
 */
export const BYTES_PER_SNAPSHOT_VERTEX = 75;
export const BYTES_PER_SNAPSHOT_FEATURE = 728;

/**
 * 圧縮前の量から **実ファイル（.gimoza = ZIP）の増分** を見積もる比。実測で
 * 「デーレ共和国の錨 1 本 = 中身 270.0 KiB / 実ファイル 約 60.4 KiB」（0.224）、
 * 50 本ぶんの実増分でも 0.224 だった。スナップショットは前の錨とほとんど同じ内容なので
 * ZIP がよく効く。**画面に出すのはこちら**である — 利用者が気にするのは保存ファイルの
 * 大きさであって、その中の JSON の大きさではない（設計書 §N-13 の書き直し）。
 */
export const COMPRESSED_SHARE_OF_SNAPSHOT = 0.224;

/** 錨 1 本ぶんの保存量の概算（バイト、**圧縮前**）。 */
export function estimateAnchorBytes(size: AnchorSnapshotSize): number {
  return (
    size.vertexCount * BYTES_PER_SNAPSHOT_VERTEX +
    size.featureCount * BYTES_PER_SNAPSHOT_FEATURE
  );
}

/** 錨 1 本ぶんで **保存ファイルが実際に増える量** の概算（バイト）。 */
export function estimateAnchorFileBytes(size: AnchorSnapshotSize): number {
  return Math.round(estimateAnchorBytes(size) * COMPRESSED_SHARE_OF_SNAPSHOT);
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
  /**
   * 新しい錨で **保存ファイルが増える量** の概算（新設のときだけ・材料があるときだけ）。
   * 圧縮前の JSON の量ではない（設計書 §N-13）。
   */
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
  // **二分探索で探す**（2026-09-07、増分 6 の実測）。系列の開始時刻は厳密に増加する
  // （U09 の不変条件 INV-1）ので、端から舐める必要はない。
  //
  // ここは **時刻が動くたびに** 走る（編集時刻バッジの行き先を決める）。5 万錨の
  // 地物を選んだまま 1 年送ると、`compare` が 5 万回 ―― しかも 1 回ごとに U02 の
  // 正規化を 2 度通る ―― 走り、1 コマが 3ms → 30ms になっていた。増分 6 でレールの
  // 読み取り行にも同じバッジを出したので、**同じ走査が 2 か所**になっている。
  const entries = series.entries;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid];
    if (entry === undefined) return false;
    const order = compare(entry.start, at, calendar);
    if (order === 0) return true;
    if (order < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** 画面に出す言葉（1 か所に集める、NFR 5.7 / 教訓 5.29）。 */
export const EDIT_PLAN_STRINGS = {
  /** バッジの区切り。 */
  badgeSeparator: '｜',
  noteOverwrite: (year: string): string => `${year}の錨を直します`,
  noteNewAnchor: '錨を新しく作ります',
  /**
   * **実ファイルの増分**で言う（設計書 §N-13 の書き直し）。旧版は圧縮前の JSON の量を
   * 「ファイルが約 270 KB 増えます」と出していたので、実際の 4 倍以上に見えていた。
   */
  noteNewAnchorWithCost: (bytes: string): string =>
    `錨を新しく作ります（保存ファイルが${bytes}増えます）`,
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
  /** 対象の地物が決まっていない（鍵盤から押したときに起きる）。 */
  createAnchorHereNoTarget: '記録を作る地物が選ばれていません。地図か一覧で 1 つ選んでください。',
  /** 「読むだけ」のとき（教訓 5.13 の一括無効化に、鍵盤経路でも文字を付ける）。 */
  createAnchorHereViewOnly: 'いまは「読むだけ」です。鍵を開けると記録を作れます。',
  /**
   * 引き継ぎの予告（A1）。**押す前に、後ろのどの記録まで同じ値が入るかを見せる。**
   * 数が多いときは先頭 2 件＋残りの本数にする（ボタンの文字が窓からはみ出さない）。
   */
  carryForwardSuffix: (years: readonly string[]): string => {
    if (years.length === 0) return '';
    if (years.length <= 2) return `（${years.join('・')}の記録にも同じ値を入れます）`;
    const head = years.slice(0, 2).join('・');
    return `（${head}ほか ${String(years.length - 2)} 件の記録にも同じ値を入れます）`;
  },
  /**
   * 保存したあと、その姿がいつまで続くか（A1 の「この姿は 1500 年まで」）。
   * **この先ずっと続くときは出さない**（素性欄は幅 280px・縦も狭いので、いつも同じことを
   * 言う行で保存列を太らせない。行き先そのものはボタンの文言が言っている）。
   */
  effectRangeUntil: (year: string): string => `この姿は${year}まで続きます。`,
  /** 値が変わっていないのに保存を押させない（A6 / GPT#6）。 */
  noChangeNote: '値が変わっていません。',
  noChangeNoteWithCreateAnchor: (year: string): string =>
    `値が変わっていません。この年に錨だけ作るなら［${year}に錨を作る］を押してください。`,
} as const;

/** 保存の「効く範囲」の表示（A1）。純粋なので単体で固定できる。 */
export interface SaveEffect {
  /** 保存ボタンの文言（引き継ぎがあるときは行き先を添える）。 */
  readonly saveLabel: string;
  /**
   * ボタンの上に出す 1 行。**「この姿がいつまで続くか」が具体的な年で言えるときだけ**
   * 出す。押せないとき・この先ずっと続くときは null（何も出さない）。
   */
  readonly effectRange: string | null;
}

/**
 * 保存の行き先に「引き継ぎの範囲」を重ねる（A1。設計書 §D.3 の「危険と打ち消し方」）。
 *
 * `carriedYears` は **この保存が書き換える後ろの錨の年**、`nextDivergingYear` は
 * **引き継ぎが済んだあと、その姿でなくなる最初の年**（無ければ null）。どちらも
 * ドメインの `carryForwardTargets` / `nextDivergingEntry` から来る（画面が独自に
 * 数え直さない、教訓 5.29）。
 */
export function saveEffectOf(
  plan: EditPlan,
  carriedYears: readonly string[],
  nextDivergingYear: string | null,
): SaveEffect {
  if (!plan.savable) return { saveLabel: plan.saveLabel, effectRange: null };
  return {
    saveLabel: `${plan.saveLabel}${EDIT_PLAN_STRINGS.carryForwardSuffix(carriedYears)}`,
    effectRange:
      nextDivergingYear === null
        ? null
        : EDIT_PLAN_STRINGS.effectRangeUntil(nextDivergingYear),
  };
}

/** 保存の行き先を決める（設計書 §D.3 の表そのもの）。 */
export function decideEditPlan(input: EditPlanInput): EditPlan {
  const { currentTime, series, featurePresent, calendar } = input;
  const aligned = isYearAligned(currentTime);
  const yearLabel = formatYear(currentTime.year);
  const fullLabel = formatTimePoint(currentTime);
  // バッジの左は「いまどの時刻にいるか」なので、年ちょうどでないときは月日まで出す。
  const timeLabel = aligned ? yearLabel : fullLabel;

  // (1) その時刻に地物がいない。**年ちょうどかどうかより先に見る**: 地物が居ないなら
  // 年へ丸めても保存できないので、「月日の付いた年には作れません」より
  // 「この年にはまだありません」のほうが利用者にとって本当の理由である。
  if (!featurePresent) {
    return {
      kind: EDIT_PLAN_KIND.FeatureAbsent,
      savable: false,
      editTime: null,
      badgeTime: timeLabel,
      badgeNote: EDIT_PLAN_STRINGS.noteFeatureAbsent,
      saveLabel: EDIT_PLAN_STRINGS.saveLabelDisabled,
      reason: EDIT_PLAN_STRINGS.reasonFeatureAbsent(timeLabel),
      roundedTime: null,
      estimatedBytes: null,
    };
  }

  // (2) **現在時刻ちょうどに錨がある ⇒ 粒度を問わず上書き。**
  //
  // 年ちょうどを要求するのは **新しい錨を作る側だけ**である（U-14「月日を勝手に
  // 補わない」は、月日を *焼き付ける* ことの禁止であって、既にある月日つきの錨を
  // *直せなくする* ことではない）。存続期間エディタは月日つきの開始を実際に作れるし、
  // 錨を選べば現在時刻はその開始へ同期するので、ここを年ちょうどで弾くと
  // **その錨だけ永久に編集できない**（設計 B1 / GPT#1 / 反証 F9）。
  // 渡す時刻は丸めずそのまま。applyPastEdit は開始の一致で錨を引き当てるので、
  // 既存の錨の月日はそのまま保たれる。
  if (hasAnchorStartingAt(series, currentTime, calendar)) {
    return {
      kind: EDIT_PLAN_KIND.Overwrite,
      savable: true,
      // 年ちょうどなら今までどおり年へ丸める（比較は U02 が正規化するので、丸めても
      // 同じ錨に当たる）。年ちょうどでないときだけ、そのままの時刻で錨を引き当てる。
      editTime: aligned ? timePointYear(currentTime.year) : currentTime,
      badgeTime: timeLabel,
      badgeNote: EDIT_PLAN_STRINGS.noteOverwrite(timeLabel),
      saveLabel: EDIT_PLAN_STRINGS.saveLabelOverwrite(timeLabel),
      reason: null,
      roundedTime: null,
      estimatedBytes: null,
    };
  }

  // (3) 年ちょうどでない — レール由来の時刻は年へ丸めてあるので通常は起きないが、
  // 月/日の 1 歩送りと直接ジャンプは今も細かい粒度を作れる。**新設の保険として残す**
  // （設計書 §D.3 の表の 4 行目 / §O の B-4）。
  if (!aligned) {
    return {
      kind: EDIT_PLAN_KIND.NotYearAligned,
      savable: false,
      editTime: null,
      badgeTime: fullLabel,
      badgeNote: EDIT_PLAN_STRINGS.noteNotYearAligned,
      saveLabel: EDIT_PLAN_STRINGS.saveLabelDisabled,
      reason: EDIT_PLAN_STRINGS.reasonNotYearAligned(fullLabel, yearLabel),
      roundedTime: timePointYear(currentTime.year),
      estimatedBytes: null,
    };
  }

  // (4) 錨が無い ⇒ その年に 1 本作る。増える量の概算を添える（§A.3 の「費用」）。
  const size = input.snapshotSize ?? null;
  const estimatedBytes = size === null ? null : estimateAnchorFileBytes(size);
  return {
    kind: EDIT_PLAN_KIND.NewAnchor,
    savable: true,
    editTime: timePointYear(currentTime.year),
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
