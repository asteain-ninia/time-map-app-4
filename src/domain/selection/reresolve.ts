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

import type { VertexOwnerLookup } from './contracts';
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

// --- Display re-validation (選択 heal の対称性: time / root / control ↔ 選択) --

/**
 * Re-validate the vertex selection against the CURRENT display resolution — the
 * symmetric sibling of {@link revalidateForTime} on the display axis (選択 heal の
 * 対称性完成, 教訓 5.5 / 5.6 / 5.11). Any change to a display-resolution input
 * (domain root, current time, or displayControl depth/focus) can make selected
 * vertices vanish from the display's owner lookup (display-resolution-cache
 * `vertexOwners` — ONLY the frame's grabbable features own vertices): the owning
 * leaf rolls up into an aggregate (Omit), or the hierarchy itself changes at a new
 * time / after an edit / undo. The property panel would then classify the
 * still-selected vertices as CONTEXT_KIND.Unknown「選択頂点の所有地物を特定でき
 * ません」. We re-resolve the selection instead of leaving it dangling.
 *
 * PER-VERTEX re-resolution through the injected {@link VertexOwnerLookup} — the SAME
 * contract the panel's context classification and the hit-test owner map use (単一
 * 真実源, 教訓 5.29); the composition root backs it with resolveDisplayFor's
 * `owners`. Per-vertex (NOT a whole-owner verdict check) because a SHARED vertex can
 * survive through a DIFFERENT owner: with 隣接 features A / B sharing vertex v
 * (first-wins owner A), a display change that omits A while B stays Real keeps v
 * drawn and selectable via B — so v is KEPT and the selection's owner is REWRITTEN
 * to the surviving resolved owner (never a blanket clear, 教訓 5.11):
 *
 *   1. Every selected vertex is resolved through the lookup; unresolvable vertices
 *      (owned by nothing drawn this frame) are pruned.
 *   2. Survivors are grouped by their resolved owner. FR-81 (one owner per vertex
 *      set) picks ONE group deterministically: the CURRENT owner's group when it
 *      still owns any survivor, else the group of the FIRST surviving vertex in
 *      selection iteration order (the same first-wins spirit as the owner map).
 *   3. `vertexOwner` is rewritten to the kept group's owner (it may differ from the
 *      pre-heal owner — the shared-vertex case above).
 *
 * ACTIVE-FEATURE EXCEPTION: the ACTIVE feature's edit handles (and thus its
 * vertices) are drawn even when it is aggregation-omitted (draw ⊇ hit,
 * active-feature-handles.ts), so a vertex selection OWNED BY the active feature is
 * never pruned by a display change. The active feature itself is left untouched: a
 * display change never alters feature EXISTENCE (that is the time regime's job).
 *
 * The transient is PRESERVED (unlike the time / structure paths): display control is
 * a non-interfering axis (FR-42 非干渉) — a display re-validation must not abort an
 * in-progress gesture. Idempotent: when every vertex still resolves to the current
 * owner the SAME reference is returned (no redundant notification / redraw), and the
 * lookup is never consulted for an empty / active-owned selection.
 */
export function revalidateForDisplay(
  state: SelectionState,
  ownerLookup: VertexOwnerLookup,
): SelectionState {
  // No vertex selection ⇒ nothing to heal (the injected lookup is NOT consulted, so
  // the common empty/active-only case costs nothing).
  if (state.vertexOwner === null) return state;
  // The active feature keeps its handles (its vertices stay grabbable) even when
  // omitted, so a vertex selection owned by it survives a display change.
  if (state.vertexOwner === state.activeFeature) return state;

  // Step 1+2: resolve every vertex, group survivors by their CURRENT display owner.
  // Map iteration preserves insertion order, so the first-resolved group is the
  // deterministic fallback pick below.
  const byOwner = new Map<FeatureId, Set<VertexId>>();
  for (const vid of state.vertexIds) {
    const owner = ownerLookup.ownerOf(vid);
    if (owner === null) continue; // owned by nothing drawn this frame → prune
    const group = byOwner.get(owner);
    if (group === undefined) byOwner.set(owner, new Set([vid]));
    else group.add(vid);
  }

  // Nothing survives → drop the dangling set; activeFeature + transient stay intact.
  if (byOwner.size === 0) return withoutVertexSet(state);

  // Step 2 (deterministic single-owner pick, FR-81) + Step 3 (owner rewrite).
  const previous = state.vertexOwner;
  const keptOwner = byOwner.has(previous)
    ? previous
    : (byOwner.keys().next().value as FeatureId);
  const kept = byOwner.get(keptOwner) as Set<VertexId>;

  // Idempotent no-op: same owner and no vertex pruned → same reference.
  if (keptOwner === previous && kept.size === state.vertexIds.size) return state;
  return withVertexSet(state, keptOwner, kept);
}
