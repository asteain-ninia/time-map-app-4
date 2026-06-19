// Survey-mode Japanese UI text (U37, FR-115 / FR-117, 技術方針 5.5).
//
// All user-visible survey text lives here as plain constants (no i18n
// abstraction, per the shell's policy). The shell (U20) references these by key;
// no component hardcodes a literal inline (教訓 5.19).

/** Survey mode + control labels. */
export const SURVEY_STRINGS = {
  /** The survey-mode toggle button label (補助モード, FR-14). */
  modeLabel: '測量モード',
  /** The clear-all button label (FR-15). */
  clearLabel: '測量結果をクリア',
  /** Panel heading for the measurement readout. */
  panelTitle: '測量',
  /** Equirectangular distance row label (FR-14). */
  equirectangularLabel: '正距円筒距離',
  /** Great-circle distance row label (FR-14). */
  greatCircleLabel: '大円距離',
  /** Distance unit suffix. */
  unitKm: 'km',
  /** Start-point lat/lon section label (FR-16). */
  startPointLabel: '始点',
  /** End-point lat/lon section label (FR-16). */
  endPointLabel: '終点',
  /** Guidance shown when idle (no start point yet). */
  guideIdle: '地図上をクリックして測量の始点を指定してください。',
  /** Guidance shown after the first click (awaiting the end point). */
  guideAwaitingEnd: 'もう一度クリックして終点を指定してください（Escでキャンセル）。',
  /** Shown for an internal inconsistency (FR-117). */
  internalError: '内部エラーが発生しました。開発者へ報告してください。',
} as const;

/** Format a distance (km) for display, e.g. `1,234.56 km`. */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km)) {
    return SURVEY_STRINGS.internalError;
  }
  const rounded = km.toLocaleString('ja-JP', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${rounded} ${SURVEY_STRINGS.unitKm}`;
}
