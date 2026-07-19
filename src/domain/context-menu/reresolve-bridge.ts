// U36 context menu — structure-change → selection re-resolution BRIDGE
// (受け入れ基準 12, spec §4.6, 教訓 5.6 / 5.11).
//
// A right-click dispatched flow (削除 U31 / 分割 U26 / 結合 U30 / 所属変更 U28 /
// 共有解除 U11) is a STRUCTURE CHANGE: target ids / shapes may change. The
// completed selection must NOT be blanket-cleared; it is re-resolved FROM the
// flow's CommandResult (残存/新規/削除 ID) via U22's
// `reresolveAfterStructureChange` (教訓 5.11). U36 does not own that re-resolution
// — it BRIDGES the result: from the dispatched intent + the flow's result it
// derives the {@link NextTargetPreference} ("the next element to operate on")
// that U22 promotes, so the right-click path reaches the SAME re-resolution the
// UI-button path does (教訓 5.6, no simplified side-path).
//
// This is the PURE bridge value; the shell calls
// `reresolveAfterStructureChange(selection, result, preference)` with it. Keeping
// it pure lets the intent → preference mapping be exhaustively unit-tested under
// Vitest (NFR 5.8).
//
// LAYER: pure `domain`. No React / Electron import.

import type { CommandResult } from '../command/result';
import type { NextTargetPreference } from '../selection/reresolve';

import { FLOW_KIND, type DispatchIntent } from './contracts';

/**
 * Derive the U22 next-target preference for the selection re-resolution that
 * follows a dispatched flow's completion (受け入れ基準 12). The preference names
 * the element the user should keep operating on after the structure change; U22's
 * {@link reresolveAfterStructureChange} promotes it ONLY if it survives the
 * result (deleted ids drop out automatically there — see {@link CommandResult}).
 *
 * Per flow (spec §4.6):
 *   - Delete: the target was removed. No surviving "next" element is named — the
 *     caller passes the empty preference so re-resolution merely prunes the
 *     deleted target (no blanket clear; 教訓 5.11).
 *   - EditProperties: not a structure change — no re-resolution is needed; an
 *     empty preference is returned for uniformity (caller may skip the call).
 *   - Split: the split source becomes ≥2 pieces. Without knowing which piece the
 *     user wants, prefer the source feature id; if it survived as one piece it
 *     stays selected, otherwise re-resolution prunes it. U26 may refine this by
 *     supplying its own preference; this bridge gives the right-click default.
 *   - ChangeAffiliation: the feature itself survives (only its hierarchy edges
 *     change). Prefer it so it stays selected.
 *   - Merge: the seed feature is consumed into the merged result. Prefer the seed
 *     id; if U30 reports it survived (i.e. the merge kept the seed's id) it stays
 *     selected, otherwise re-resolution prunes it and the shell re-selects the
 *     created merged feature from the result's `created` set (the shell knows the
 *     new id; the bridge cannot name an id it did not mint).
 *   - Unshare: owner-qualified — the OWNER gets fresh same-coordinate copies (new ids),
 *     the other citers keep the original. The new ids are NOT in the intent, so this
 *     bridge cannot name them; the LAUNCHER (live-unshare) owns the remap of the owner's
 *     selection onto the new ids. The bridge returns the empty preference (re-resolution
 *     merely prunes, never blanket-clears).
 *
 * The mapping never re-implements re-resolution (that is U22's job, 教訓 5.29);
 * it only chooses WHICH surviving element is the next target.
 */
export function nextTargetPreferenceFor(intent: DispatchIntent): NextTargetPreference {
  switch (intent.kind) {
    case FLOW_KIND.Delete:
      // Target removed; name no next element (re-resolution prunes the deleted id).
      return {};
    case FLOW_KIND.DeleteVertex:
      // The selected vertices are removed; the vertex-delete funnel (runEditDelete) owns
      // its own re-resolution (keeps the feature active, clears the vertex set), so the
      // bridge names nothing (re-resolution prunes the deleted vertex ids, 教訓 5.11).
      return {};
    case FLOW_KIND.EditProperties:
      // Not a structure change — nothing to promote.
      return {};
    case FLOW_KIND.HideFeature:
      // FR-113 個別非表示 is a DISPLAY-only op: it produces no CommandResult and never
      // routes through reresolveAfterStructureChange (launchMenuItem calls the store's
      // setFeatureHidden directly). This arm exists only for exhaustiveness — nothing to
      // promote (the selection is untouched by hiding a feature).
      return {};
    case FLOW_KIND.Split:
      // Prefer the split source; survives iff it remained one of the pieces.
      return { featureId: intent.featureId };
    case FLOW_KIND.ChangeAffiliation:
      // The feature itself survives an affiliation change.
      return { featureId: intent.featureId };
    case FLOW_KIND.Merge:
      // Prefer the seed; if consumed, re-resolution prunes it and the shell picks
      // the created merged feature from result.created (an id the bridge can't name).
      return { featureId: intent.seedFeatureId };
    case FLOW_KIND.Unshare:
      // Owner-qualified unshare gives the OWNER fresh same-coordinate copies (new ids the
      // bridge cannot name from the intent alone — the intent carries the ORIGINAL ids,
      // which now belong to the OTHER citers). The LAUNCHER (live-unshare) owns the remap:
      // it knows the minted ids and re-resolves the owner's selection onto them. So the
      // bridge names nothing here (re-resolution merely prunes, never blanket-clears).
      return {};
    default: {
      const _never: never = intent;
      return _never;
    }
  }
}

/**
 * The full bridge value the shell hands to U22 after a flow completes
 * (受け入れ基準 12): the flow's {@link CommandResult} (forwarded verbatim — U36
 * does not synthesize survived/created/deleted sets) and the derived
 * {@link NextTargetPreference}. The shell calls
 * `reresolveAfterStructureChange(selection, result, preference)` with these two.
 */
export interface ReresolveBridge {
  readonly result: CommandResult;
  readonly preference: NextTargetPreference;
}

/**
 * Build the {@link ReresolveBridge} from a dispatched intent and the flow's
 * command result. Pure: it forwards the result and derives the preference
 * ({@link nextTargetPreferenceFor}). This is the single helper the right-click
 * path uses to feed U22, so the right-click and button paths re-resolve
 * identically (教訓 5.6).
 */
export function bridgeReresolve(
  intent: DispatchIntent,
  result: CommandResult,
): ReresolveBridge {
  return { result, preference: nextTargetPreferenceFor(intent) };
}
