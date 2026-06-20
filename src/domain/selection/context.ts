// U22 selection — vertex-selection CONTEXT analysis (FR-81, 教訓 5.10).
//
// The context is derived from the RAW vertex-selection set: each vertex ID is
// reverse-looked-up to its owning feature, and the owner set is classified into
// FOUR mutually exclusive states (受け入れ基準 4 / 5):
//
//   - Empty   : the vertex set is empty.
//   - Single  : every vertex resolves to ONE owning feature → that feature is
//               the context (FR-81: only when a single feature owns all of them).
//   - Multi   : vertices span more than one owning feature.
//   - Unknown : at least one vertex's owner cannot be resolved (dangling ID).
//
// CRUCIAL (教訓 5.10): the classification evaluates the raw owner of EVERY
// vertex — it does not trust a pre-derived helper. An unknown owner is NOT
// silently dropped (which would let a dangling vertex masquerade as Single); it
// forces the Unknown branch. Each branch maps one-to-one to a downstream
// consumer rule (the property panel reference + visual-feedback category).

import type { FeatureId, VertexId } from '../ids';

import type { VertexOwnerLookup } from './contracts';

export const CONTEXT_KIND = {
  /** No vertices selected. */
  Empty: 'empty',
  /** All selected vertices owned by one feature → that feature is the context. */
  Single: 'single',
  /** Selected vertices span multiple owning features. */
  Multi: 'multi',
  /** At least one selected vertex's owner cannot be resolved. */
  Unknown: 'unknown',
} as const;

export type ContextKind = (typeof CONTEXT_KIND)[keyof typeof CONTEXT_KIND];

/**
 * The classified vertex-selection context (FR-81). A discriminated union so the
 * single-owner feature is ONLY accessible in the `Single` branch — a consumer
 * cannot read an owner out of a Multi/Unknown/Empty state by accident
 * (受け入れ基準 5: each classification distinct).
 */
export type VertexContext =
  | { readonly kind: typeof CONTEXT_KIND.Empty }
  | {
      readonly kind: typeof CONTEXT_KIND.Single;
      readonly ownerFeatureId: FeatureId;
      /** The owned vertices (the whole selection set, for the panel). */
      readonly vertexIds: ReadonlySet<VertexId>;
    }
  | {
      readonly kind: typeof CONTEXT_KIND.Multi;
      /** The distinct owning features (>= 2). */
      readonly ownerFeatureIds: ReadonlySet<FeatureId>;
    }
  | { readonly kind: typeof CONTEXT_KIND.Unknown };

export const EMPTY_CONTEXT: VertexContext = { kind: CONTEXT_KIND.Empty };

/**
 * Classify the vertex-selection set into a context (FR-81 / 教訓 5.10).
 *
 * Evaluates the RAW set: resolves the owner of every vertex through `lookup`. A
 * single unresolved owner forces `Unknown`; otherwise the distinct owners decide
 * Single vs. Multi. The empty set short-circuits to `Empty` BEFORE any lookup,
 * because emptiness is a real state, not "no owners" (教訓 5.18).
 */
export function analyzeVertexContext(
  vertexIds: ReadonlySet<VertexId>,
  lookup: VertexOwnerLookup,
): VertexContext {
  // 教訓 5.18: decide emptiness on the set itself, not via a downstream count.
  if (vertexIds.size === 0) {
    return EMPTY_CONTEXT;
  }

  const owners = new Set<FeatureId>();
  for (const vid of vertexIds) {
    const owner = lookup.ownerOf(vid);
    // 教訓 5.10: an unresolved owner is its own branch, never dropped — a
    // dangling vertex must not let the rest look like a single clean owner.
    if (owner === null) {
      return { kind: CONTEXT_KIND.Unknown };
    }
    owners.add(owner);
  }

  // owners is non-empty here (set was non-empty and every owner resolved).
  if (owners.size === 1) {
    // Exactly one owner: safe to read the single value.
    const [only] = owners;
    // `only` is defined because size === 1.
    return {
      kind: CONTEXT_KIND.Single,
      ownerFeatureId: only as FeatureId,
      vertexIds: new Set(vertexIds),
    };
  }

  return { kind: CONTEXT_KIND.Multi, ownerFeatureIds: owners };
}

// --- Property-panel reference (受け入れ基準 4): one rule per classification --
//
// The property panel reads the ACTIVE feature first (FR-79); only when there is
// no active feature does it fall back to the vertex-selection context (FR-81).
// This resolver maps the (activeFeature, context) pair to the ONE feature the
// panel should show, with a distinct value for each classification so the
// mapping is one-to-one (受け入れ基準 5).

export const PANEL_TARGET_KIND = {
  /** Show the active feature's properties (FR-79 takes priority). */
  ActiveFeature: 'activeFeature',
  /** No active feature, single-owner context → show that feature (FR-81). */
  ContextFeature: 'contextFeature',
  /** No active feature, and the context is empty/multi/unknown → show nothing. */
  None: 'none',
} as const;

export type PanelTargetKind =
  (typeof PANEL_TARGET_KIND)[keyof typeof PANEL_TARGET_KIND];

export type PanelTarget =
  | { readonly kind: typeof PANEL_TARGET_KIND.ActiveFeature; readonly featureId: FeatureId }
  | { readonly kind: typeof PANEL_TARGET_KIND.ContextFeature; readonly featureId: FeatureId }
  | { readonly kind: typeof PANEL_TARGET_KIND.None };

/**
 * Resolve which feature the property panel shows (FR-79 / FR-81). Active feature
 * wins; otherwise a single-owner context feature; otherwise nothing. Each of the
 * four context classifications maps to exactly one outcome here (受け入れ基準 4).
 */
export function resolvePanelTarget(
  activeFeature: FeatureId | null,
  context: VertexContext,
): PanelTarget {
  if (activeFeature !== null) {
    return { kind: PANEL_TARGET_KIND.ActiveFeature, featureId: activeFeature };
  }
  switch (context.kind) {
    case CONTEXT_KIND.Single:
      return {
        kind: PANEL_TARGET_KIND.ContextFeature,
        featureId: context.ownerFeatureId,
      };
    case CONTEXT_KIND.Empty:
    case CONTEXT_KIND.Multi:
    case CONTEXT_KIND.Unknown:
      return { kind: PANEL_TARGET_KIND.None };
    default: {
      const _never: never = context;
      return _never;
    }
  }
}
