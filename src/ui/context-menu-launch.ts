// fr96 — the right-click menu ITEM → flow LAUNCH routing (the thin, testable seam
// between the PURE U36 dispatch and the App's live effects; vertex-delete.ts /
// live-unshare.ts の同型 sibling, 教訓 5.34).
//
// WHY THIS FILE (Codex F1b): the routing used to live inline in App.tsx's
// onSelectMenuItem, so its ONE stateful guard — the EditProperties live-existence
// check — was untestable without a full App harness. Extracted here, the routing is
// pure over injected ports and Vitest pins every branch, especially the STALE
// EditProperties no-op:
//
//   dispatchMenuItem validates only the FROZEN model (frozen at menu-open by design —
//   dispatch.ts's drift guard blocks items absent/disabled IN THE MODEL). But the
//   TARGET can cease to exist while the menu is open (the menu suspends the global
//   shortcuts — F1a — yet defense must not depend on that alone, 深層防御). Every
//   other flow re-reads the live root downstream (EditDelete funnel / vertex-delete
//   plan / unshare plan all no-op on a stale target; the tool arms collect their own
//   targets), but EditProperties would have promoted a nonexistent id into the
//   selection (setActiveFeature is unvalidated). So THIS seam re-checks existence
//   against the LIVE root at the LIVE time before opening properties: absent ⇒ no-op
//   (the menu closes itself; nothing dangles — 教訓 5.5 / 5.6).

import { assertNever } from '../domain/assert-never';
import {
  FLOW_KIND,
  dispatchMenuItem,
  isBlocked,
  type ContextMenuModel,
  type MenuItemKind,
} from '../domain/context-menu/index';
import type { FeatureId, VertexId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import type { TimePoint } from '../domain/time/time-point';

import { featureByIdAt } from './live-lookup';
import { TOOL_ID } from './shell/tools';
import type { ToolId } from './state/session';

/** The host effects a chosen menu item can launch (the SAME flows the UI buttons run). */
export interface MenuLaunchPorts {
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** COMMAND_ID.EditDelete — the ONE delete funnel via the registry (地物全錨削除). */
  readonly dispatchEditDelete: () => void;
  /** The runEditDelete vertex branch, fed the intent's own payload (FR-88). */
  readonly deleteVertices: (
    ownerFeatureId: FeatureId,
    vertexIds: ReadonlySet<VertexId>,
  ) => void;
  /** Promote the target + focus the プロパティ tab (called ONLY for a live target). */
  readonly openProperties: (featureId: FeatureId) => void;
  /** Arm an edit tool (分割→knife / 所属変更→reparent / 結合→merge), selection pinned. */
  readonly armEditTool: (tool: ToolId) => void;
  /** The FR-33 live unshare launcher (ONE composite undo unit + selection remap). */
  readonly unshare: (
    vertexIds: ReadonlySet<VertexId>,
    ownerFeatureId: FeatureId | null,
  ) => void;
  /**
   * FR-113 個別非表示 — force-hide the target feature via the session display filter
   * (store.setFeatureHidden). DISPLAY-only: no domain mutation, no history, no dirty, so
   * — unlike every flow above — it needs no live-existence guard (a stale id is a
   * harmless no-op override that reconcileToLiveFeatures prunes on the next edit).
   */
  readonly hideFeature: (featureId: FeatureId) => void;
  /**
   * FR-113 Phase 2 強調 — add/remove the target from the session 強調集合
   * (store.setFeatureEmphasized). DISPLAY-only, exactly like {@link hideFeature}: no domain
   * mutation, no history, no dirty, no live-existence guard (a stale id is a harmless
   * session override that reconcileToLiveFeatures prunes on the next structure change).
   */
  readonly setFeatureEmphasized: (featureId: FeatureId, emphasized: boolean) => void;
}

/**
 * Route a chosen item through the PURE dispatch (drift guard: a disabled / stale item
 * is BLOCKED there, 教訓 5.13) and launch the matching EXISTING flow — never a
 * simplified side-path (教訓 5.6). The FLOW → TOOL_ID mapping lives HERE, once.
 */
export function launchMenuItem(
  itemKind: MenuItemKind,
  model: ContextMenuModel,
  ports: MenuLaunchPorts,
): void {
  const intent = dispatchMenuItem(itemKind, model);
  if (isBlocked(intent)) return; // disabled / stale in the model: never fires (教訓 5.13)
  switch (intent.kind) {
    case FLOW_KIND.Delete:
      ports.dispatchEditDelete();
      return;
    case FLOW_KIND.DeleteVertex:
      // The intent names its own owner + vertex set (the composed target), so the
      // funnel deletes EXACTLY what the menu offered (教訓 5.6); a stale target is a
      // no-op inside buildVertexDeletePlan (owner/vertex absent ⇒ null plan).
      ports.deleteVertices(intent.ownerFeatureId, intent.vertexIds);
      return;
    case FLOW_KIND.EditProperties: {
      // F1b — LIVE existence check (see the module note): the frozen model can
      // outlive its target; promoting a nonexistent id would leave the property
      // panel pointing at nothing. Absent at the live (root, time) ⇒ no-op.
      const alive = featureExistsAt(ports.getRoot(), ports.getTime(), intent.featureId);
      if (!alive) return;
      ports.openProperties(intent.featureId);
      return;
    }
    case FLOW_KIND.Split:
      ports.armEditTool(TOOL_ID.EditKnife);
      return;
    case FLOW_KIND.ChangeAffiliation:
      ports.armEditTool(TOOL_ID.EditReparent);
      return;
    case FLOW_KIND.Merge:
      ports.armEditTool(TOOL_ID.EditMerge);
      return;
    case FLOW_KIND.Unshare:
      // A stale unshare target is a no-op inside buildUnsharePlan (owner does not
      // cite / not shared ⇒ null plan, no幽霊 undo — 教訓 5.24).
      ports.unshare(intent.vertexIds, intent.ownerFeatureId);
      return;
    case FLOW_KIND.HideFeature:
      // FR-113 個別非表示 — session display state only (no live-existence guard needed;
      // see MenuLaunchPorts.hideFeature). The store's reconcile prunes a stale id later.
      ports.hideFeature(intent.featureId);
      return;
    case FLOW_KIND.SetFeatureEmphasis:
      // FR-113 Phase 2 強調/強調解除 — one arm for both items; the intent's `emphasized`
      // carries the direction the composer showed (see MenuLaunchPorts.setFeatureEmphasized).
      ports.setFeatureEmphasized(intent.featureId, intent.emphasized);
      return;
    default:
      return assertNever(intent);
  }
}

/** Whether `featureId` is effective at the live (root, time) — the F1b guard. */
function featureExistsAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): boolean {
  return featureByIdAt(root, time, featureId) !== undefined;
}
