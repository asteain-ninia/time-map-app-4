// UI layer (map): the PURE adapter that turns a live store snapshot + live domain
// lookups into the U36 {@link ComposeInput} — the single place the App composition
// root assembles right-click menu input, so App.tsx stays thin (教訓 5.13 / 5.29)
// and the assembly is Vitest-testable without env (技術方針 2.5).
//
// It re-implements NO composition rule (that is U36 composeContextMenu); it only maps
// the session's RAW selection + mode + active tool + hit + position + the three
// injected lookups into the ComposeInput contract. The three lookups are the SINGLE
// sources the rest of the app already derives:
//   - featureKindLookup  ← featureByIdAt (the same effective-at-time feature the draw
//     / hit-test resolve, 教訓 5.3 / 5.29);
//   - ownerLookup        ← resolveDisplayFor(...).owners (the grabbable vertex → owning
//     feature map the hit-test grabs from and the selection heal reads). It is a
//     FIRST-owner-wins single-valued map (VertexId → FeatureId): it classifies the
//     SELECTION into Single / Multi / Unknown (per-vertex distinct owners across the
//     set) and CANNOT — nor needs to — express one vertex's CO-OWNERSHIP; that
//     "this vertex is shared" fact is the SEPARATE sharedLookup's job (see below);
//   - sharedLookup       ← shared-vertex-derivation.sharedVertexIdsFor (RAW, depth-
//     independent — the same set the FR-30 marker draws and the FR-33 unshare detaches).
//
// canEdit is read through the ONE shell permission predicate (permissions.canEdit) so
// the menu's view-only gate is the SAME single source the menu bar / shortcuts use
// (教訓 5.13) — View ⇒ NO_MENU; Add/Edit ⇒ editable.

import {
  MENU_TOOL_KIND,
  composeContextMenu,
  type ComposeInput,
  type ContextMenuModel,
  type FeatureKindLookup,
  type MenuPosition,
  type MenuToolKind,
  type NoMenu,
  type SharedVertexLookup,
} from '../../domain/context-menu/index';
import {
  EMPTY_CONTEXT,
  HIT_KIND,
  analyzeVertexContext,
  type HitResult,
  type SelectionState,
  type VertexOwnerLookup,
} from '../../domain/selection/index';

import { canEdit } from '../shell/permissions';
import { TOOL_ID } from '../shell/tools';
import type { EditMode, ToolId } from '../state/session';

/** The three live domain lookups the composer needs (all single-source, see the module note). */
export interface MenuLookups {
  readonly featureKindLookup: FeatureKindLookup;
  readonly sharedLookup: SharedVertexLookup;
  readonly ownerLookup: VertexOwnerLookup;
}

/**
 * Map the active tool to the U36 tool CLASS that changes the offered set (FR-96
 * 受け入れ基準 4). The knife tool (already mid-split) drops the redundant 分割 item;
 * shape-editing tools are a distinct class; everything else (incl. `null`) is the
 * default Select set. Routed through TOOL_ID constants, never bare literals (教訓 5.19).
 */
export function toMenuToolKind(activeTool: ToolId | null): MenuToolKind {
  switch (activeTool) {
    case TOOL_ID.EditKnife:
      return MENU_TOOL_KIND.Knife;
    case TOOL_ID.EditVertex:
    case TOOL_ID.EditRing:
    case TOOL_ID.EditDrill:
      return MENU_TOOL_KIND.ShapeEdit;
    default:
      return MENU_TOOL_KIND.Select;
  }
}

/** The store snapshot + context a right-click composes against. */
export interface ComposeInputArgs {
  readonly selection: SelectionState;
  readonly mode: EditMode;
  readonly activeTool: ToolId | null;
  /** What the right-click hit (feature body / vertex / edge / empty). */
  readonly hit: HitResult;
  /** Where the menu opens (screen pixels). */
  readonly position: MenuPosition;
  readonly lookups: MenuLookups;
}

/**
 * Assemble the U36 {@link ComposeInput} from a live store snapshot + lookups. The
 * vertex context is analyzed through the injected owner lookup (the SAME U22 truth the
 * property panel reads); `hitVertexId` is the right-clicked vertex if any; `canEdit`
 * is the ONE permission predicate. Pure.
 */
export function buildComposeInput(args: ComposeInputArgs): ComposeInput {
  const { selection, mode, activeTool, hit, position, lookups } = args;
  const vertexContext =
    selection.vertexIds.size === 0
      ? EMPTY_CONTEXT
      : analyzeVertexContext(selection.vertexIds, lookups.ownerLookup);
  const hitVertexId = hit.kind === HIT_KIND.Vertex ? hit.vertexId : null;
  return {
    activeFeature: selection.activeFeature,
    vertexIds: selection.vertexIds,
    vertexContext,
    hitVertexId,
    position,
    toolKind: toMenuToolKind(activeTool),
    canEdit: canEdit(mode),
    featureKindLookup: lookups.featureKindLookup,
    sharedLookup: lookups.sharedLookup,
  };
}

/**
 * Convenience: assemble the input and compose the menu model in one call (the shell's
 * `composeFor`). Returns {@link ContextMenuModel} or {@link NoMenu} (view-only / empty).
 */
export function composeMenuFor(args: ComposeInputArgs): ContextMenuModel | NoMenu {
  return composeContextMenu(buildComposeInput(args));
}
