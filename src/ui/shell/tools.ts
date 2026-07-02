// UI layer (U20 / shell): tool identifiers and the mode -> tools mapping (FR-75).
//
// Each editing mode exposes a fixed set of tools in the toolbar. The mapping
// from mode to tool set is derived from a SINGLE definition here (教訓 5.30:
// 同じ判定は同じ実装を共有), and tool branching uses these constants, never
// bare literals (教訓 5.19). This unit provides only the tool BUTTONS and their
// selected state; each tool's behaviour is implemented by a later unit
// (spec スコープ「やらないこと」).

import { EDIT_MODE, asToolId, type EditMode, type ToolId } from '../state/session';

/** The canonical tool-id vocabulary. */
export const TOOL_ID = {
  // add mode (点 / 線 / 面, FR-75)
  AddPoint: asToolId('add.point'),
  AddLine: asToolId('add.line'),
  AddArea: asToolId('add.area'),
  // edit mode (選択 / 頂点編集 / 地物移動 / ナイフ / 所属変更 / 結合, FR-75)
  EditSelect: asToolId('edit.select'),
  EditVertex: asToolId('edit.vertex'),
  EditMove: asToolId('edit.move'),
  EditKnife: asToolId('edit.knife'),
  EditReparent: asToolId('edit.reparent'),
  EditMerge: asToolId('edit.merge'),
  // FR-22 / FR-24 穴・飛び地の追加 / リング削除 (U25 ring-edit)
  EditRing: asToolId('edit.ring'),
} as const;

/** The tools shown in 追加モード, in toolbar order. */
const ADD_MODE_TOOLS: readonly ToolId[] = [
  TOOL_ID.AddPoint,
  TOOL_ID.AddLine,
  TOOL_ID.AddArea,
];

/** The tools shown in 編集モード, in toolbar order. */
const EDIT_MODE_TOOLS: readonly ToolId[] = [
  TOOL_ID.EditSelect,
  TOOL_ID.EditVertex,
  TOOL_ID.EditMove,
  TOOL_ID.EditKnife,
  TOOL_ID.EditReparent,
  TOOL_ID.EditMerge,
  TOOL_ID.EditRing,
];

const NO_TOOLS: readonly ToolId[] = [];

/**
 * The tools available for a mode (FR-75). View mode shows no editing tools
 * (it is the display-only permission state). The mapping is the single source
 * the toolbar reads from; adding a tool means editing only this table.
 */
export function toolsForMode(mode: EditMode): readonly ToolId[] {
  switch (mode) {
    case EDIT_MODE.Add:
      return ADD_MODE_TOOLS;
    case EDIT_MODE.Edit:
      return EDIT_MODE_TOOLS;
    case EDIT_MODE.View:
      return NO_TOOLS;
    default: {
      // Exhaustiveness: a new mode must extend this table (教訓 5.19).
      const _never: never = mode;
      return _never;
    }
  }
}

/** True if the tool belongs to the given mode's tool set. */
export function toolBelongsToMode(tool: ToolId, mode: EditMode): boolean {
  return toolsForMode(mode).includes(tool);
}
