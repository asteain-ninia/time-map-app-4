// UI layer (U32 / property panel): selection-status → display decision (FR-83).
//
// This is the SINGLE pure judgment (教訓 5.29) the whole property panel shares:
// guidance text, edit-ability and edit-target decision all read its result, so
// no case can drift to a separate判定. It evaluates the RAW selection ID sets
// (active feature id + the owner set of the vertex selection) — NOT a single
// pre-derived helper — to cover all five cases (教訓 5.10): active /
// context-single / multi / unknown / empty. Each case maps one-to-one to a
// message + edit condition (受け入れ基準 1).
//
// It is framework-free and side-effect-free (NFR 5.8): inputs are the raw
// selection values U22 owns; output is a discriminated decision. The React
// panel renders from it and never re-derives the branch itself.

import type { FeatureId, VertexId } from '../../domain/ids';
import {
  CONTEXT_KIND,
  type VertexContext,
  type VertexOwnerLookup,
  analyzeVertexContext,
} from '../../domain/selection';

import { PROPERTY_STRINGS } from './messages';

/** The five mutually-exclusive display outcomes (FR-83). */
export const DISPLAY_KIND = {
  /** Active feature present → edit that feature (FR-83 第一優先). */
  ActiveFeature: 'activeFeature',
  /** No active feature; single-owner context → edit that feature. */
  ContextFeature: 'contextFeature',
  /** No active feature; vertices span multiple features → guidance, no edit. */
  Multiple: 'multiple',
  /** No active feature; an owner cannot be resolved → guidance, no edit. */
  Unknown: 'unknown',
  /** Nothing selected → guidance, no edit. */
  Empty: 'empty',
} as const;

export type DisplayKind = (typeof DISPLAY_KIND)[keyof typeof DISPLAY_KIND];

/**
 * The display decision. `editable` is true ONLY for the two cases that resolve a
 * single edit-target feature; the three guidance cases carry a message and no
 * target. The discriminant makes a target unreadable in a guidance case
 * (受け入れ基準 1: 一対一対応).
 */
export type DisplayDecision =
  | {
      readonly kind: typeof DISPLAY_KIND.ActiveFeature;
      readonly targetFeatureId: FeatureId;
      readonly editable: true;
    }
  | {
      readonly kind: typeof DISPLAY_KIND.ContextFeature;
      readonly targetFeatureId: FeatureId;
      readonly editable: true;
    }
  | {
      readonly kind: typeof DISPLAY_KIND.Multiple;
      readonly message: string;
      readonly editable: false;
    }
  | {
      readonly kind: typeof DISPLAY_KIND.Unknown;
      readonly message: string;
      readonly editable: false;
    }
  | {
      readonly kind: typeof DISPLAY_KIND.Empty;
      readonly message: string;
      readonly editable: false;
    };

/**
 * The raw selection inputs this judgment evaluates (教訓 5.10). These mirror
 * U22's truth: the active feature id (0/1) and the raw vertex-selection set with
 * its owner lookup. The judgment classifies the owner set ITSELF rather than
 * trusting a single derived flag, so a dangling vertex (unknown owner) cannot
 * masquerade as a clean single owner.
 */
export interface RawSelectionInput {
  /** The active feature id, or null (FR-79). */
  readonly activeFeatureId: FeatureId | null;
  /** The raw selected vertex set (FR-80). */
  readonly vertexIds: ReadonlySet<VertexId>;
  /** Reverse owner lookup for each vertex (FR-81). */
  readonly ownerLookup: VertexOwnerLookup;
}

/**
 * Decide what the property panel shows. Evaluates the raw inputs in priority
 * order (active feature → vertex context classification), covering every case
 * (教訓 5.10). The vertex context is classified from the raw set via U22's
 * {@link analyzeVertexContext} (the single classifier), then mapped one-to-one
 * to a display kind here.
 */
export function decideDisplay(input: RawSelectionInput): DisplayDecision {
  // FR-83 第一優先: an active feature always wins, regardless of vertices.
  if (input.activeFeatureId !== null) {
    return {
      kind: DISPLAY_KIND.ActiveFeature,
      targetFeatureId: input.activeFeatureId,
      editable: true,
    };
  }

  // No active feature: classify the RAW vertex set (教訓 5.10). The classifier
  // resolves the owner of EVERY vertex, so unknown/multi are never collapsed.
  const context: VertexContext = analyzeVertexContext(
    input.vertexIds,
    input.ownerLookup,
  );

  switch (context.kind) {
    case CONTEXT_KIND.Single:
      return {
        kind: DISPLAY_KIND.ContextFeature,
        targetFeatureId: context.ownerFeatureId,
        editable: true,
      };
    case CONTEXT_KIND.Multi:
      return {
        kind: DISPLAY_KIND.Multiple,
        message: PROPERTY_STRINGS.multipleFeatures,
        editable: false,
      };
    case CONTEXT_KIND.Unknown:
      return {
        kind: DISPLAY_KIND.Unknown,
        message: PROPERTY_STRINGS.unknownOwner,
        editable: false,
      };
    case CONTEXT_KIND.Empty:
      return {
        kind: DISPLAY_KIND.Empty,
        message: PROPERTY_STRINGS.emptySelection,
        editable: false,
      };
    default: {
      const _never: never = context;
      return _never;
    }
  }
}

/**
 * The target feature id of a decision, or null for the guidance cases. A thin
 * accessor over the discriminated union so consumers do not re-branch on `kind`.
 */
export function targetFeatureIdOf(decision: DisplayDecision): FeatureId | null {
  return decision.kind === DISPLAY_KIND.ActiveFeature ||
    decision.kind === DISPLAY_KIND.ContextFeature
    ? decision.targetFeatureId
    : null;
}
