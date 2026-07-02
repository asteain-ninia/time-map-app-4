// U27 — 穴あけによる新地物生成 (drill) UI strings (FR-45 / FR-92 / FR-115, NFR 5.7).
//
// All user-facing drill text lives here as a single source so the controller / hook
// select by key and the copy is testable (教訓 5.19 / 5.26 同一文言を UI とテストで
// 共有). No component embeds a bare literal inline. The DOMAIN rejection文言
// (drillRejectMessage in domain/drill/messages.ts) is used DIRECTLY at the reject site
// to avoid a second definition (二重定義回避); only the flow chrome text lives here.

export const DRILL_STRINGS = {
  /** Guide: pick the target末端 face to drill a hole in (no face selected yet). */
  guideSelectTarget: '穴をあける末端地物をクリックで選択してください。',
  /** Guide while placing the region's vertices (target chosen). */
  guideDrawRegion: 'くり抜く領域の頂点をクリックで追加してください（3 点以上で確定できます）。',
  /** Guide while entering the new feature's properties (region confirmed). */
  guideEnterProperties: '生成される新しい地物のプロパティを入力してください。',
  /** Confirm the drafted region (advance to新地物プロパティ入力). */
  confirmRegion: '穴あけを確定',
  /** 最後の頂点を取り消す (FR-78). */
  undoVertex: '最後の頂点を取り消す',
  /** Cancel the whole drill operation. */
  cancel: 'キャンセル',
  /** 非集約新地物プロパティ入力 heading (re-uses U23 form; FR-97). */
  newFeatureProps: '新規地物のプロパティ',
  /** ConflictPaused status (FR-62). */
  conflictPaused: '空間競合の解決待ちです。',
  /** LEAF gate refusal (集約 body クリック時): a non-leaf cannot be drilled. */
  notLeaf: '集約地物には穴あけできません。末端地物を選んでください。',
  /** The target vanished mid-draft (time move / delete). */
  targetGone: '対象面が見つかりませんでした。',
} as const;

export type DrillStringKey = keyof typeof DRILL_STRINGS;

/** The developer-report hint appended to internal-error messages (FR-117). */
export const DRILL_REPORT_HINT = 'お手数ですが開発者へ報告してください。';

/**
 * Ensure the「開発者へ報告」hint is present exactly once on an internal-error message
 * (FR-115 / FR-117). Mirrors knife/add so a guarded internal error on the drill save
 * path is surfaced with the SAME guidance, not a raw message.
 */
export function withReportHint(message: string): string {
  return message.includes('開発者へ報告') ? message : `${message}\n${DRILL_REPORT_HINT}`;
}
