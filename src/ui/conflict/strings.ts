// UI layer (U35 / conflict): Japanese UI text for the conflict-resolution modal,
// centralised (FR-115, 技術方針 5.5「i18n 抽象なし方針」).
//
// Every user-visible string the modal, list, policy controls, guide and error
// banner show lives here as a plain constant. No component hardcodes a literal
// inline (教訓 5.19: 表示文言・分岐識別子は定数を経由する). A future localisation
// unit (FR-7.2) forks this single module — there is no i18n abstraction layer.

/** Modal chrome: title, paused-confirmation banner, list/section headings. */
export const CONFLICT_STRINGS = {
  /** Modal title. */
  title: '空間的な重なりの解決',
  /**
   * The paused-confirmation banner (FR-62): tells the user the edit is held
   * because terminal features overlap, so they know confirmation is suspended.
   */
  pausedBanner:
    '末端地物どうしの重なりが見つかったため、編集の確定を一時停止しています。各重なりで残す地物を選んでから適用してください。',
  /** List section heading. */
  listHeading: '重なりの一覧',
  /** Column header: in-story time. */
  colTime: '作中時間',
  /** Column header: the two terminal feature names. */
  colFeatures: '重なっている末端地物',
  /** Column header: conflict kind. */
  colKind: '種類',
  /** Column header: resolution state. */
  colState: '状態',
  /** The single conflict-kind label in scope (FR-26: terminal overlap only). */
  kindTerminalOverlap: '末端地物の重なり',
  /** Resolution state: not yet chosen. */
  stateUnresolved: '未指定',
  /** Resolution state: a priority feature was chosen. */
  stateResolved: '指定済み',
  /** Remaining-unresolved counter prefix (受け入れ基準 2: 未指定件数が一目で分かる). */
  remainingPrefix: '未指定',
  /** Remaining-unresolved counter suffix. */
  remainingSuffix: '件',
  /** All conflicts resolved message. */
  allResolved: 'すべての重なりに方針を指定しました。適用できます。',
  /**
   * 冒頭の文の **言い換え**（増分 8E / 設計書 §E.1 の V13・§H.1）。冒頭の文そのものは
   * 変えない（文言の総点検は 8E の後半でまとめて行う）。「末端地物」が初見では読めない
   * ので、用語集の説明文をそのまま添える。
   */
  pausedBannerParaphrase:
    '末端地物は「国境を持つ面」のことです。実際に形を持ち、隣と重なれない面なので、重なった部分をどちらに付けるかを決めてください。',
} as const;

/**
 * 解決を適用したあとに状態行へ出す文（増分 8E / 設計書 §E.1 の V13 ⑦）。
 * 「何をしたか」を過去形で言い切り、どの年の話かを添える（§H.5）。
 */
export const RESOLVED_STRINGS = {
  /** 「アルラーク国とバアカの重なりを解消しました（1200年）」。 */
  one: (a: string, b: string, at: string): string => `${a}と${b}の重なりを解消しました（${at}）`,
  /** 2 件以上を一度に解消したとき。名前は最初の 1 件だけ出し、残りは件数で言う。 */
  many: (a: string, b: string, rest: number, at: string): string =>
    `${a}と${b}ほか ${String(rest)} 件の重なりを解消しました（${at}）`,
  /**
   * 板の［キャンセル］で重なりの解決をやめたとき。止まっていた編集は記録されない
   * （何が起きたか → どうなったか）。成功でも失敗でもないので中立の色で出す。
   */
  cancelled: '重なりの解決をやめました。止まっていた編集は記録していません。',
} as const;

/** Resolution-policy control labels (FR-63: choose the priority feature). */
export const POLICY_STRINGS = {
  /** Prompt above the two priority choices. */
  prompt: '残す地物を選択',
  /** Radio/label prefix for the priority (kept-whole) feature. */
  priorityPrefix: '優先',
  /** Description of what happens to the non-priority feature. */
  adjustNote: 'もう一方は重なり分が差し引かれます。',
} as const;

/** Minimap preview labels and region descriptions (FR-63 描き分け). */
export const PREVIEW_STRINGS = {
  /** Accessible label of the minimap canvas region. */
  ariaLabel: '重なりのプレビュー地図',
  /** Legend: the priority (kept-whole) feature. */
  legendPriority: '優先（そのまま残す）',
  /** Legend: the adjusted (trimmed) feature's remaining area. */
  legendRemaining: '調整後に残る領域',
  /** Legend: the overlap area that is removed from the adjusted feature. */
  legendOverlap: '重なり（削られる領域）',
  /** Shown before a priority is chosen. */
  chooseFirst: '残す地物を選ぶと、削られる領域が表示されます。',
  /**
   * 凡例: 残す側を選ぶ前の灰色（増分 8E / N-17）。選ぶ前のミニマップは両方の面を同じ灰色で
   * 描くので、その色が何なのかを凡例に足す（選んだあとは出さない）。
   */
  legendNeutral: '残す側を選ぶ前の面',
} as const;

/** Action buttons (FR-63 / 受け入れ基準 5・7). */
export const ACTION_STRINGS = {
  /** Apply (confirm) button. Disabled until every conflict has a policy. */
  apply: '適用',
  /** Cancel button: abandons the paused edit, discards all draft state. */
  cancel: 'キャンセル',
  /** Title shown on the disabled apply button explaining why. */
  applyDisabledHint: 'すべての重なりに方針を指定すると適用できます。',
  /**
   * Retry button shown in the rejection banner (FR-115 行き止まり解消): re-enters
   * the resolving phase so the user can pick different policies and apply again,
   * WITHOUT abandoning the paused edit (cancel) — the rejected drafts are spent
   * (教訓 5.2) so the user starts the re-pick fresh.
   */
  retry: '選択し直す',
} as const;

/**
 * First-time guide (FR-118). Japanese only (FR-115).
 *
 * **形は共有の器（`shell/GuidePanel`）が持つ**（増分 6）。ここは「重なり解決の使い方」
 * という中身だけを持ち、初回起動のガイド（`shell/strings.ts` の `FIRST_RUN_GUIDE`）と
 * 同じ器を通る ―― 器を写して 2 枚にすると、閉じ方だけが 1 枚で違う、が必ず起きる
 * （教訓 5.44）。
 */
export const GUIDE_STRINGS = {
  /** Guide heading. */
  heading: 'この画面の使い方',
  /** Step-by-step body lines (read in order). */
  steps: [
    '重なりが見つかったため、確定を保留しています。',
    '各重なりで、残す側の末端地物を選びます。',
    'もう一方は、重なり分が自動で削られます。',
    'すべての重なりを選ぶと「適用」できます。',
    'ミニマップで、どこがどれだけ重なっているかを確認できます。',
  ] as readonly string[],
  /** Dismiss-and-suppress button. */
  dismiss: '今後表示しない',
  /** Close-without-suppress button (keep showing next time). */
  close: '閉じる',
  /** Re-show the guide control label (when suppressed). */
  reshow: '使い方を表示',
} as const;

/**
 * Map a U13 rejection message to the user-facing banner. The orchestrator
 * already supplies a Japanese `message`; the UI shows it verbatim and, for an
 * internal-inconsistency rejection, ensures the「開発者へ報告してください」hint is
 * present (FR-115 / FR-117). The hint is appended only when the message does not
 * already carry it, so we never duplicate it (the U13 internal message includes
 * it already).
 */
export const REPORT_HINT = 'お手数ですが開発者へ報告してください。';

/** Ensure a developer-report hint is present exactly once on an internal-error message. */
export function withReportHint(message: string): string {
  return message.includes('開発者へ報告') ? message : `${message}\n${REPORT_HINT}`;
}

/** 画面に出す言葉（教訓 5.19: 文言は定数を経由する）。 */
export const PARTICIPANT_NAME_STRINGS = {
  /** 「名前のない面（1500年に作成）」。 */
  unnamedWithYear: (kindWord: string, createdLabel: string): string =>
    `名前のない${kindWord}（${createdLabel}に作成）`,
  /** 作成の年が分からないとき（履歴に見つからない＝通常は起きない）。 */
  unnamed: (kindWord: string): string => `名前のない${kindWord}`,
  /** 同じ名前の地物を見分けるために作成の年を添える「州（900年に作成）」。 */
  namedWithYear: (name: string, createdLabel: string): string => `${name}（${createdLabel}に作成）`,
} as const;

/** 名前の無い地物を呼ぶ「何であるか」の語（`participant-name.ts` の `UNNAMED_KIND_WORD` / `UNKNOWN_KIND_WORD`）。 */
export const PARTICIPANT_KIND_TEXT = {
  kindPoint: '点',
  kindLine: '線',
  kindLeaf: '面',
  kindAggregate: '面',
  /** 種類の分からない地物（どこにも見つからない）を呼ぶ語。 */
  unknownKind: '地物',
} as const;

/** 重なりの一覧の 1 行（`model.ts` / `ConflictResolutionModal.tsx`）。 */
export const CONFLICT_ROW_TEXT = {
  timeSince: (from: string): string => `${from}から`,
  timeBetween: (from: string, until: string): string => `${from}から${until}になるまで`,
  timeSpanSeparator: '、',
  /** 2 件の名前のあいだ（前の空白も値に含む。後ろの空白は部品の側の {' '}）。 */
  participantSeparator: ' ／',
} as const;
