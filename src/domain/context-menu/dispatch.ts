// U36 context menu — pure dispatch: chosen item → flow launch intent (FR-96
// 後段, 教訓 5.6 / 5.11 / 5.13 / 5.19).
//
// `dispatchMenuItem(itemKind, model) → DispatchIntent | DISPATCH_BLOCKED` maps a
// chosen item to ONE launch intent for the matching existing flow (U11/U26/U28/
// U30/U31) or "open property editor". It is pure: it produces the intent VALUE
// only; the shell calls the real dependency launcher with it (spec §4.6二層化).
// There is no simplified side-path — the same flow as the UI-button path runs
// (教訓 5.6), so the consistency process (U13) and history (U12) are reached
// identically.
//
// 教訓 5.13: a disabled item (grayed-out, e.g. 結合 with one target) is BLOCKED
// here too — the right-click path cannot fire what the menu shows disabled.
//
// LAYER: pure `domain`.

import { assertNever } from '../assert-never';
import type { FeatureId, VertexId } from '../ids';

import {
  FLOW_KIND,
  type DispatchIntent,
  type FeatureKind,
} from './contracts';
import { MENU_ITEM_KIND, type ContextMenuItem, type MenuItemKind } from './items';
import {
  MENU_TARGET_KIND,
  type ContextMenuModel,
  type MenuTarget,
} from './compose';

// --- Blocked outcome (disabled item / no target / mismatched item) ----------

export const DISPATCH_BLOCKED_KIND = {
  /** The chosen item was disabled (grayed-out) — never fires (教訓 5.13). */
  ItemDisabled: 'itemDisabled',
  /** The chosen item is not present in the model (stale model / drift). */
  ItemNotInModel: 'itemNotInModel',
  /** The item needs a feature target the model does not have. */
  NoFeatureTarget: 'noFeatureTarget',
  /** The item needs shared vertices the model does not have. */
  NoSharedVertices: 'noSharedVertices',
} as const;

export type DispatchBlockedKind =
  (typeof DISPATCH_BLOCKED_KIND)[keyof typeof DISPATCH_BLOCKED_KIND];

export type DispatchBlocked = { readonly blocked: DispatchBlockedKind };

export type DispatchResult = DispatchIntent | DispatchBlocked;

function blocked(kind: DispatchBlockedKind): DispatchBlocked {
  return { blocked: kind };
}

export function isBlocked(result: DispatchResult): result is DispatchBlocked {
  return 'blocked' in result;
}

// --- Feature-target extraction (削除/編集/分割/所属変更/結合 need a feature) --
//
// The feature these items act on is the model's target: a Feature target, or a
// VertexOnly target whose single owner names the feature (§4.2). Returns null
// when no single feature is named (multi/unknown owner) — the caller blocks.

interface FeatureTargetInfo {
  readonly featureId: FeatureId;
  readonly featureKind: FeatureKind;
}

function featureTargetOf(target: MenuTarget): FeatureTargetInfo | null {
  switch (target.kind) {
    case MENU_TARGET_KIND.Feature:
      return { featureId: target.featureId, featureKind: target.featureKind };
    case MENU_TARGET_KIND.VertexOnly:
      // VertexOnly names a feature via a single owner, and the composer resolved
      // that owner's kind onto the target (compose.resolveMenuTarget). When both
      // the owner id and its kind are present, the feature-wide items the
      // composer offered for this single-owner vertex context dispatch HERE —
      // there is no separate shell re-resolution path (出す=発火できる, 受け入れ
      // 基準 6/8, 教訓 5.6). Multi/unknown owners have null kind → block.
      if (target.ownerFeatureId !== null && target.ownerFeatureKind !== null) {
        return { featureId: target.ownerFeatureId, featureKind: target.ownerFeatureKind };
      }
      return null;
    case MENU_TARGET_KIND.None:
      return null;
    default:
      return assertNever(target);
  }
}

/** The single owner id of a VertexOnly target (for shell re-resolution). */
function vertexOnlyOwner(target: MenuTarget): FeatureId | null {
  return target.kind === MENU_TARGET_KIND.VertexOnly ? target.ownerFeatureId : null;
}

/**
 * The owner + selected vertices a 頂点を削除 acts on (FR-88). A Feature target names its
 * own id as owner; a VertexOnly target names its single owner. Returns null when there
 * is no vertex selection or no resolvable owner (the caller blocks) — this is exactly
 * when the composer offered 削除(地物) or nothing instead (no drift, 教訓 5.6).
 */
function deleteVertexTargetOf(
  target: MenuTarget,
): { readonly ownerFeatureId: FeatureId; readonly vertexIds: ReadonlySet<VertexId> } | null {
  switch (target.kind) {
    case MENU_TARGET_KIND.Feature:
      return target.vertexIds.size > 0
        ? { ownerFeatureId: target.featureId, vertexIds: target.vertexIds }
        : null;
    case MENU_TARGET_KIND.VertexOnly:
      return target.ownerFeatureId !== null && target.vertexIds.size > 0
        ? { ownerFeatureId: target.ownerFeatureId, vertexIds: target.vertexIds }
        : null;
    case MENU_TARGET_KIND.None:
      return null;
    default:
      return assertNever(target);
  }
}

/**
 * The shared vertices to unshare: ONLY the共有頂点部分集合 the composer resolved
 * onto the target (§4.3), never the whole selection — so U11 never receives a
 * non-shared vertex as an unshare target (contracts payload「≥1 shared」). The
 * owner is a hint for selection re-resolution and may be null (multi/unknown);
 * U11 derives each vertex's shape reference itself, so a null owner does NOT
 * block the unshare (受け入れ基準 3/6/8). Returns null only when there is no
 * shared vertex to detach.
 */
function unshareTargetOf(
  target: MenuTarget,
): { readonly vertexIds: ReadonlySet<VertexId>; readonly ownerFeatureId: FeatureId | null } | null {
  let sharedVertexIds: ReadonlySet<VertexId> | null = null;
  let owner: FeatureId | null = null;
  switch (target.kind) {
    case MENU_TARGET_KIND.Feature:
      sharedVertexIds = target.sharedVertexIds;
      owner = target.featureId;
      break;
    case MENU_TARGET_KIND.VertexOnly:
      sharedVertexIds = target.sharedVertexIds;
      owner = target.ownerFeatureId;
      break;
    case MENU_TARGET_KIND.None:
      return null;
    default:
      return assertNever(target);
  }
  // 教訓 5.18: decide on the shared subset's size, not a falsy short-circuit.
  if (sharedVertexIds === null || sharedVertexIds.size === 0) return null;
  return { vertexIds: sharedVertexIds, ownerFeatureId: owner };
}

/** Find the chosen item in the model (drift guard, 教訓 5.6). */
function findItem(
  model: ContextMenuModel,
  itemKind: MenuItemKind,
): ContextMenuItem | undefined {
  return model.items.find((it) => it.kind === itemKind);
}

/**
 * Map a chosen item to its flow launch intent (FR-96 後段). Returns a
 * {@link DispatchBlocked} when the item is disabled (教訓 5.13), absent from the
 * model (stale), or lacks the target it needs. The intent is the VALUE the shell
 * hands to the real dependency launcher — there is no separate simplified path
 * (教訓 5.6).
 *
 * Single-owner VertexOnly feature items: the composer resolves the owner's kind
 * onto the target, so the feature-wide items it offered (削除/プロパティ編集/
 * 分割/所属変更) dispatch fully HERE — the right-click path fires exactly what
 * the menu showed enabled (出す=発火できる, 受け入れ基準 6/8, 教訓 5.6). Only a
 * multi/unknown owner (no resolvable single feature) blocks feature-wide items,
 * which is also exactly when the composer omits them (no drift). 共有解除 works
 * for multi/unknown owners too because U11 derives each shared vertex's shape
 * reference itself (受け入れ基準 3).
 */
export function dispatchMenuItem(
  itemKind: MenuItemKind,
  model: ContextMenuModel,
): DispatchResult {
  const item = findItem(model, itemKind);
  if (item === undefined) {
    return blocked(DISPATCH_BLOCKED_KIND.ItemNotInModel);
  }
  if (!item.enabled) {
    return blocked(DISPATCH_BLOCKED_KIND.ItemDisabled);
  }

  const ft = featureTargetOf(model.target);

  switch (itemKind) {
    case MENU_ITEM_KIND.Delete: {
      if (ft === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      return { kind: FLOW_KIND.Delete, featureId: ft.featureId, featureKind: ft.featureKind };
    }
    case MENU_ITEM_KIND.DeleteVertex: {
      const dv = deleteVertexTargetOf(model.target);
      if (dv === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      return { kind: FLOW_KIND.DeleteVertex, ownerFeatureId: dv.ownerFeatureId, vertexIds: dv.vertexIds };
    }
    case MENU_ITEM_KIND.EditProperties: {
      if (ft === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      return {
        kind: FLOW_KIND.EditProperties,
        featureId: ft.featureId,
        featureKind: ft.featureKind,
      };
    }
    case MENU_ITEM_KIND.Split: {
      if (ft === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      // 分割 is leaf-only; the composer only offers it for a leaf target, so the
      // intent carries just the feature id (FR-44, 教訓 5.25).
      return { kind: FLOW_KIND.Split, featureId: ft.featureId };
    }
    case MENU_ITEM_KIND.ChangeAffiliation: {
      if (ft === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      return {
        kind: FLOW_KIND.ChangeAffiliation,
        featureId: ft.featureId,
        featureKind: ft.featureKind,
      };
    }
    case MENU_ITEM_KIND.Merge: {
      // 結合(U30) — distinct from所属変更 (教訓 5.27). Seeds one target; U30
      // collects more. (Composer offers it DISABLED so this branch is reached
      // only if a future state enables it — the item.enabled guard above already
      // blocks the disabled case.)
      if (ft === null) return blocked(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
      return { kind: FLOW_KIND.Merge, seedFeatureId: ft.featureId };
    }
    case MENU_ITEM_KIND.Unshare: {
      const us = unshareTargetOf(model.target);
      if (us === null) return blocked(DISPATCH_BLOCKED_KIND.NoSharedVertices);
      return {
        kind: FLOW_KIND.Unshare,
        vertexIds: us.vertexIds,
        ownerFeatureId: us.ownerFeatureId,
      };
    }
    default:
      return assertNever(itemKind);
  }
}

/** Re-exported helper: the single owner of a VertexOnly target (shell wiring). */
export { vertexOnlyOwner };
