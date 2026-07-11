// UI/session state layer: the display-owner dependency contract (選択 heal の対称性).
//
// 単一の真実源 (開発ガイド §4, 教訓 5.29): "which drawn feature OWNS vertex V under
// the current display resolution (root, time, depth N + focus M)?" is a U34/U08
// display-resolution judgment owned by the render pipeline (resolveDisplayFor's
// `owners` map — the exact vertex→feature map the click hit-test grabs from). This
// store MUST NOT re-implement depth/focus verdict logic or owner claiming (spec 依存:
// 表示解決を注入可能な依存として受け取り、再実装しない). It is the DISPLAY-axis
// sibling of the time-existence contract in existence.ts.
//
// WHY IT EXISTS (選択 heal の対称性完成): the store re-validates the vertex selection
// through U22's revalidateForDisplay whenever ANY display-resolution input changes —
// a displayControl setter (depth / focus), a time change (setCurrentTime / timeline
// re-derive), or a domain swap (applyCommandResult / applyUndoRedoResult) — exactly
// as it re-validates existence on every time change (revalidateForTime, 教訓 5.5 /
// 5.6). Without it, selected vertices whose display owner stops being drawn linger
// unresolvable and the property panel shows「選択頂点の所有地物を特定できません」
// (CONTEXT_KIND.Unknown). The store calls this injected port opaquely.
//
// The composition root wires the real resolver bound to the LIVE domain root via the
// SAME resolveDisplayFor bundle the renderer / hit-test share (単一真実源 —「掴める」
// ==「描画/ヒット対象」). When NOT injected the store SKIPS the display re-validation
// entirely (an honest absence — no fabricated "always owned" truth), keeping
// framework-free tests unaffected. Tests inject fakes to prove the store contains no
// independent display-resolution logic.

import type { VertexOwnerLookup } from '../../domain/selection';
import type { TimePoint } from '../../domain/time/time-point';

import type { DisplayControl } from './session';

/**
 * The display owner-lookup effective at `(time, control)` over the LIVE domain root:
 * `ownerOf(vertexId)` returns the feature that OWNS the vertex among the features
 * drawn with their own real shape this frame (resolveDisplayFor's `owners`), or null
 * when nothing drawn owns it. MUST be LAZY — the underlying resolution should run
 * only if `ownerOf` is actually called — so a heal over an empty selection costs
 * nothing. Opaque to the store.
 */
export type DisplayOwnersAt = (
  time: TimePoint,
  control: DisplayControl,
) => VertexOwnerLookup;

/**
 * The injected display-owner port the store needs to re-validate the vertex
 * selection on a display-resolution input change (選択 heal の対称性). Grouping it in
 * one value keeps the dependency explicit at the composition root and trivially
 * fakeable in tests (mirror of {@link ExistenceResolver}).
 */
export interface DisplayGrabbabilityResolver {
  readonly displayOwnersAt: DisplayOwnersAt;
}
