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

/** First-time guide (FR-118). Japanese only (FR-115). */
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
