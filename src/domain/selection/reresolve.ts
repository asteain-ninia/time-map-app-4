// U22 selection — re-resolution after structure changes & time changes.
//
// 教訓 5.11: after merge / split / move / delete, the selection is NOT blanket-
// cleared. The command's CommandResult reports survived / created / deleted IDs,
// and the selection is re-resolved from it: deleted IDs drop out; the "next
// element to operate on" stays selected. 教訓 5.5: when the current time changes
// and a selected feature no longer exists at that time, the selection is dropped.
//
// Pure functions over SelectionState (NFR 5.8). They are the canonical
// re-resolution logic; the thin store calls into these so the rule lives in one
// place (単一の真実源, 教訓 5.29).

import type { CommandResult } from '../command/result';
import type { DomainId, FeatureId, VertexId } from '../ids';

import {
  EMPTY_SELECTION,
  withActiveFeature,
  withVertexSet,
  withoutVertexSet,
  type SelectionState,
} from './state';

// --- Structure-change re-resolution (教訓 5.11) -----------------------------

/**
 * Re-resolve a NEXT-target preference after a structure change. A merge keeps
 * the merged result selected; a split keeps a chosen piece selected; etc. The
 * caller (the command's owning unit) supplies which created/survived element is
 * the "next to operate on", because only it knows the operation's intent
 * (教訓 5.11: re-resolve from the result, not a fixed clear).
 */
export interface NextTargetPreference {
  /** Prefer this feature as the active feature after the change, if it exists. */
  readonly featureId?: FeatureId;
  /** Prefer these vertices (with their owner) as the vertex set, if they exist. */
  readonly vertexSelection?: {
    readonly ownerFeatureId: FeatureId;
    readonly vertexIds: ReadonlySet<VertexId>;
  };
}

function survivesResult(id: DomainId, result: CommandResult): boolean {
  // Survives iff it existed before (survived) or was created — these are the only
  // two states in which an element is present AFTER the command (教訓 5.11).
  //
  // We deliberately do NOT consult `result.touched`: per the CommandResult
  // contract (command/result.ts: `touched === created ∪ survived ∪ deleted`,
  // pairwise-disjoint change sets), `touched` adds nothing here except — were the
  // contract ever violated — touched-but-uncategorised IDs that have no defined
  // post-command existence. Trusting `touched` to mean "present" would silently
  // mask such a contract break and let a non-survived/created element "survive".
  return result.survived.has(id) || result.created.has(id);
}

/**
 * Re-resolve selection after a structure-changing command (教訓 5.11).
 *
 * Step 1: drop any selected element the command DELETED.
 * Step 2: if a `preference` is given and its targets still exist after the
 *         command, promote them so the "next element to operate on" stays
 *         selected (e.g. the merged feature, a kept split half).
 *
 * The transient interaction is always discarded (a structure change ends any
 * in-flight gesture, 教訓 5.2).
 */
export function reresolveAfterStructureChange(
  state: SelectionState,
  result: CommandResult,
  preference: NextTargetPreference = {},
): SelectionState {
  // Step 1: prune deleted IDs from the current selection.
  let next = state;

  if (next.activeFeature !== null && result.deleted.has(next.activeFeature)) {
    next = withActiveFeature(next, null);
  }

  if (next.vertexOwner !== null) {
    if (result.deleted.has(next.vertexOwner)) {
      next = withoutVertexSet(next);
    } else {
      const kept = new Set<VertexId>();
      for (const vid of next.vertexIds) {
        if (!result.deleted.has(vid)) kept.add(vid);
      }
      next = withVertexSet(next, next.vertexOwner, kept);
    }
  }

  // Step 2: promote the caller's next-target preference if it survived.
  if (
    preference.featureId !== undefined &&
    survivesResult(preference.featureId, result)
  ) {
    next = withActiveFeature(next, preference.featureId);
  }

  if (preference.vertexSelection !== undefined) {
    const pref = preference.vertexSelection;
    if (survivesResult(pref.ownerFeatureId, result)) {
      const kept = new Set<VertexId>();
      for (const vid of pref.vertexIds) {
        if (survivesResult(vid, result)) kept.add(vid);
      }
      if (kept.size > 0) {
        next = withVertexSet(next, pref.ownerFeatureId, kept);
      }
    }
  }

  // Always discard transient — a structure change ends any in-flight gesture.
  return next.transient.phase === EMPTY_SELECTION.transient.phase
    ? next
    : { ...next, transient: EMPTY_SELECTION.transient };
}

// --- Time-change re-validation (教訓 5.5) -----------------------------------

/**
 * Predicates the time re-validation needs: does a feature / vertex exist at a
 * time? Injected (単一の真实源) — the selection unit never resolves time itself
 * (spec 依存). A caller backs this with the U09 anchor-series existence logic.
 */
export interface ExistenceAtTime<T> {
  featureExistsAt(featureId: FeatureId, time: T): boolean;
  vertexExistsAt(ownerFeatureId: FeatureId, vertexId: VertexId, time: T): boolean;
}

/**
 * Re-validate the selection against a NEW current time (教訓 5.5). Any selected
 * feature/vertex that does not exist at `time` is dropped. Runs on EVERY
 * time-change path (no per-path gate, 教訓 5.6): the caller funnels every time
 * change through this one function. The transient is discarded (a time jump ends
 * any in-flight gesture).
 */
export function revalidateForTime<T>(
  state: SelectionState,
  time: T,
  existence: ExistenceAtTime<T>,
): SelectionState {
  let next = state;

  if (
    next.activeFeature !== null &&
    !existence.featureExistsAt(next.activeFeature, time)
  ) {
    next = withActiveFeature(next, null);
  }

  if (next.vertexOwner !== null) {
    const owner = next.vertexOwner;
    if (!existence.featureExistsAt(owner, time)) {
      next = withoutVertexSet(next);
    } else {
      const kept = new Set<VertexId>();
      for (const vid of next.vertexIds) {
        if (existence.vertexExistsAt(owner, vid, time)) kept.add(vid);
      }
      // Rebuild ONLY when a vertex was actually dropped. `kept ⊆ vertexIds`, so an
      // equal size means nothing was pruned — return `next` UNCHANGED (same reference)
      // rather than allocating an identical set. This makes revalidateForTime IDEMPOTENT
      // on a fully-present selection, so a reference-equality check by a caller (第10波
      // #5: applyCommandResult only re-sets the selection when revalidation changed it)
      // is exact and the common no-op path fires no redundant store notification / redraw.
      if (kept.size !== next.vertexIds.size) {
        next = withVertexSet(next, owner, kept);
      }
    }
  }

  return next.transient.phase === EMPTY_SELECTION.transient.phase
    ? next
    : { ...next, transient: EMPTY_SELECTION.transient };
}

// --- Display-control re-validation (選択 heal の対称性: time ↔ displayControl) --

/**
 * Whether a feature exposes its OWN grabbable vertices under the CURRENT display
 * control (global depth N + individual focus M). True iff the feature is drawn with
 * its OWN real shape this frame — a leaf at/above the depth threshold, or a point /
 * line (always drawn directly) — rather than rolled up into an aggregate (its area
 * derived, no own grabbable vertices) or omitted entirely.
 *
 * Injected (単一の真実源): the selection unit never resolves display verdicts
 * itself (spec 依存 — the mirror of {@link ExistenceAtTime} for the time axis). The
 * composition root backs this with the SAME `resolveDisplayFor(...).grabbable` set
 * the renderer draws and the live hit-test grabs, so「掴める（再検証上）」==「描画/
 * ヒット対象」— no second truth source that could drift (教訓 5.29).
 */
export interface DisplayGrabbability {
  ownerExposesVertices(featureId: FeatureId): boolean;
}

/**
 * Re-validate the vertex selection against a DISPLAY-CONTROL change — the symmetric
 * sibling of {@link revalidateForTime} on the display axis (選択 heal の対称性完成,
 * 教訓 5.5 / 5.6 / 5.11). A depth/focus change can make the vertex-selection OWNER
 * stop exposing its own grabbable vertices (its leaf is rolled up into an aggregate,
 * or omitted). The owner then vanishes from the display's owner lookup
 * (display-resolution-cache `vertexOwners` restricts owners to the frame's grabbable
 * features), so the property panel classifies the still-selected vertices as
 * CONTEXT_KIND.Unknown and shows「選択頂点の所有地物を特定できません」. We prune the
 * now-dangling vertex selection so it does not linger — the SAME discipline the time
 * regime uses: drop what is no longer resolvable, keep everything else, NEVER a
 * blanket clear (教訓 5.11).
 *
 * WHOLE-OWNER, not per-vertex (unlike {@link revalidateForTime}): display verdicts
 * are chosen per FEATURE (Real / Aggregate / Omit), so either ALL of an owner's
 * vertices are grabbable (it draws its own shape) or NONE are — there is no
 * partial-vertex display state. So the check is on the owner alone; a surviving
 * owner keeps its whole vertex set.
 *
 * ACTIVE-FEATURE EXCEPTION: the ACTIVE feature's edit handles (and thus its
 * vertices) are drawn even when it is aggregation-omitted (draw ⊇ hit,
 * active-feature-handles.ts), so a vertex selection OWNED BY the active feature is
 * never pruned by a display change. The active feature itself is left untouched: a
 * display change never alters feature EXISTENCE (that is the time regime's job), and
 * its handles persist — matching the time convention, which drops the active feature
 * ONLY when it ceases to exist, not merely when it stops drawing its own shape.
 *
 * The transient is PRESERVED (unlike the time / structure paths): display control is
 * a non-interfering axis (FR-42 非干渉) — a depth/focus change must not abort an
 * in-progress gesture. Idempotent: when nothing is pruned the SAME reference is
 * returned, so the store fires no redundant notification / redraw.
 */
export function revalidateForDisplay(
  state: SelectionState,
  grabbability: DisplayGrabbability,
): SelectionState {
  // No vertex selection ⇒ nothing to heal (and the injected resolver is NOT called,
  // so an unchanged display with only an active feature / empty selection costs
  // nothing — the common case).
  if (state.vertexOwner === null) return state;
  // The active feature keeps its handles (its vertices stay grabbable) even when
  // omitted, so a vertex selection owned by it survives a display change.
  if (state.vertexOwner === state.activeFeature) return state;
  // The owner still draws its own grabbable vertices ⇒ keep the whole selection.
  if (grabbability.ownerExposesVertices(state.vertexOwner)) return state;
  // The owner no longer exposes grabbable vertices (rolled up / omitted) — drop the
  // now-dangling set. The active feature + transient are left intact (NOT a blanket
  // clear, 教訓 5.11).
  return withoutVertexSet(state);
}
