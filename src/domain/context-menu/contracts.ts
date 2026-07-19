// U36 context menu — layer-crossing contracts (教訓 5.19 / 5.33 / 5.34).
//
// This unit is a COORDINATION unit (spec §1): it provides an alternate launch
// path (right-click) for five existing flows (U11 unshare / U26 split / U28
// affiliation / U30 merge / U31 delete) plus "open property edit". It does NOT
// re-implement any of those flows. To keep the wiring honest, the launch
// intents are expressed as branded discriminated unions over the domain's IDs,
// so a target ID handed to the wrong flow is a compile error (教訓 5.19), and
// both sides (this unit + the shell that calls the real flow launchers) test
// against THESE types so the layers never rely on accidental structural
// agreement (教訓 5.33 / 5.34).
//
// LAYER: pure `domain`. No React / Electron / Canvas import. The shell (UI)
// imports these intents and calls each dependency's real launcher with the
// payload here (spec §4 二層化). The actual flow body, precondition validation,
// consistency process (U13) and history (U12) belong to the dependency units —
// this unit only produces the intent value (spec §2.2).

import type { FeatureId, VertexId } from '../ids';
import { FEATURE_KIND, type FeatureKind } from '../feature';

// --- Tool kind (FR-96: メニュー内容はツール種類でも動的変化) ----------------
//
// FR-96 lists "ツール種類に応じて内容が動的に変化する" as an input to the menu
// composition. The active tool is owned by the mode/tool unit (ToolId). For the
// PURE composition we only need the CLASS of tool that changes the offered set,
// routed through a constant (教訓 5.19) — never a bare string compared in the
// composer. `null` == no specific tool active (the default offered set).

export const MENU_TOOL_KIND = {
  /** No special tool active — the default offered set (point/line/area). */
  Select: 'select',
  /** A shape-editing tool (vertex/ring editing) is active. */
  ShapeEdit: 'shapeEdit',
  /** The knife (split) tool is active. */
  Knife: 'knife',
} as const;

export type MenuToolKind = (typeof MENU_TOOL_KIND)[keyof typeof MENU_TOOL_KIND];

// --- Object kind the menu targets (derived from the feature, 教訓 5.19) ------
//
// The composer must出し分け on point / line / leaf(面=末端) / aggregate(集約).
// We reuse the domain's `FeatureKind` rather than inventing a parallel set, so
// "面情報 = 末端地物 (leaf)" and "集約地物 (aggregate)" are decided by the same
// truth the feature model uses (教訓 5.19 / 5.25). Re-exported for consumers.
export { FEATURE_KIND };
export type { FeatureKind };

// --- Flow dispatch intents (one per dependency launcher) ---------------------
//
// Each menu item, when chosen, produces ONE of these intents. The shell maps an
// intent to the dependency's real launcher (U11/U26/U28/U30/U31) or to "open the
// property editor for this target". The intent carries ONLY the target/start
// state the dependency needs; everything else (confirm dialogs, validation,
// consistency, history, selection re-resolution) is the dependency's job
// (spec §2.2 / §4.6).

export const FLOW_KIND = {
  /** U31 delete flow — the WHOLE target feature (point/line/leaf/aggregate). FR-85.
   *  Offered ONLY when no vertex is selected (a body/empty right-click), so its intent
   *  and the wired EditDelete behaviour agree (地物削除). */
  Delete: 'delete',
  /** FR-88 頂点削除 — delete the SELECTED vertices of their owner (reshapes / may drop the
   *  feature below threshold). Offered when a vertex selection exists (a vertex
   *  right-click or a carried-forward marquee), so 削除 never silently deletes the whole
   *  feature when the user targeted vertices (data-loss guard). */
  DeleteVertex: 'deleteVertex',
  /** Open the property-edit UI for the target feature. */
  EditProperties: 'editProperties',
  /** U11 unshare — the shared vertices to detach. FR-33. */
  Unshare: 'unshare',
  /** U26 split (knife) — the LEAF feature to split. FR-44 (末端地物限定). */
  Split: 'split',
  /** U28 affiliation-change — the target feature. FR-46. */
  ChangeAffiliation: 'changeAffiliation',
  /** U30 merge — the LEAF feature seeded as the FIRST merge target. FR-50. */
  Merge: 'merge',
  /**
   * U41 個別非表示 (FR-113) — force-hide the target feature from the display/hit/search
   * 母集合. DISPLAY-only (session state), so it carries only the target id and, unlike
   * every flow above, is offered even in 表示専用モード (the shell binds it to the store's
   * setFeatureHidden — no domain mutation, no history, no dirty).
   */
  HideFeature: 'hideFeature',
} as const;

export type FlowKind = (typeof FLOW_KIND)[keyof typeof FLOW_KIND];

/**
 * A launch intent for one existing flow. Discriminated by {@link FlowKind} so a
 * payload is only readable for the right flow (教訓 5.19). The shell calls the
 * matching dependency launcher with this payload — it never builds a simplified
 * side-path (教訓 5.6: same flow as the button path).
 */
export type DispatchIntent =
  | { readonly kind: typeof FLOW_KIND.Delete; readonly featureId: FeatureId; readonly featureKind: FeatureKind }
  | {
      readonly kind: typeof FLOW_KIND.DeleteVertex;
      /** The owner whose selected vertices are deleted (FR-81 single owner). */
      readonly ownerFeatureId: FeatureId;
      /** The vertices to delete (the current selection set). */
      readonly vertexIds: ReadonlySet<VertexId>;
    }
  | { readonly kind: typeof FLOW_KIND.EditProperties; readonly featureId: FeatureId; readonly featureKind: FeatureKind }
  | {
      readonly kind: typeof FLOW_KIND.Unshare;
      /**
       * The SHARED vertices to detach (≥1) — only the shared subset of the
       * selection, never the whole set. U11 resolves which shape reference each
       * shared vertex belongs to from the vertex's own shape-reference metadata
       * (buildReverseIndex), so this intent does NOT depend on a single owner
       * being resolvable: it works for multi-owner / unknown-owner shared
       * vertices too (受け入れ基準 3/6/8, U11 §4.6).
       */
      readonly vertexIds: ReadonlySet<VertexId>;
      /**
       * The CONFIRMED owner whose reference is detached (owner-qualified unshare):
       * that owner gets a fresh same-coordinate copy while every OTHER citer keeps the
       * shared vertex, so the owner is fully separated from ALL neighbours in one op
       * (右クリック「共有解除」= この所有者の参照を1つ剥がす). The composer offers 共有解除
       * ONLY when the owner is resolvable (active feature, or a single-owner vertex
       * context), so a multi/unknown-owner selection never dispatches an unshare that
       * would dangle the selection. `null` is a defensive residual the launcher no-ops.
       */
      readonly ownerFeatureId: FeatureId | null;
    }
  | { readonly kind: typeof FLOW_KIND.Split; readonly featureId: FeatureId }
  | { readonly kind: typeof FLOW_KIND.ChangeAffiliation; readonly featureId: FeatureId; readonly featureKind: FeatureKind }
  | {
      readonly kind: typeof FLOW_KIND.Merge;
      /** The leaf feature seeded as the first merge target (U30 collects more). */
      readonly seedFeatureId: FeatureId;
    }
  | {
      readonly kind: typeof FLOW_KIND.HideFeature;
      /** The feature to force-hide from the display (FR-113 個別非表示). */
      readonly featureId: FeatureId;
    };

// --- Shared-vertex判定 lookup (FR-33, single source — 教訓 5.10 / 5.29) ------
//
// "頂点選択セットに共有頂点が含まれるか" is U11/U22's derived truth. This unit
// does NOT re-implement sharing detection (spec §2.2 / §4.3); it asks this
// injected port "is this vertex shared right now?". A caller backs it with the
// U11 reverse-index derivation, so there is one source for the判定.
export interface SharedVertexLookup {
  isShared(vertexId: VertexId): boolean;
}

/** Build a shared-vertex lookup from a plain set (used by tests / thin adapters). */
export function sharedLookupFromSet(
  shared: ReadonlySet<VertexId>,
): SharedVertexLookup {
  return { isShared: (vertexId) => shared.has(vertexId) };
}

// --- Feature-kind lookup (面/集約 出し分けの単一の真実源, 教訓 5.19) ---------
//
// The composer needs the KIND of the target feature to出し分け面情報項目. It
// reads the kind through this port from the displayed feature data — it never
// guesses from a label or scans the data source (教訓 5.3 / 5.19). Returns
// `null` when the feature cannot be resolved (the menu then omits feature-wide
// items, never falling back to a default).
export interface FeatureKindLookup {
  kindOf(featureId: FeatureId): FeatureKind | null;
}

/** Build a feature-kind lookup from a plain map (used by tests / thin adapters). */
export function featureKindLookupFromMap(
  kinds: ReadonlyMap<FeatureId, FeatureKind>,
): FeatureKindLookup {
  return { kindOf: (featureId) => kinds.get(featureId) ?? null };
}
