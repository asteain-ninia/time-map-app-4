// U23 — the toolbar-tool ↔ add-tool-kind mapping (FR-75 / FR-76, 教訓 5.19 / 5.30).
//
// The shell's toolbar exposes tool IDs (`add.point` / `add.line` / `add.area`,
// tools.ts); the U23 add flow speaks {@link AddToolKind} (`point` / `line` /
// `face`). The two vocabularies meet HERE, in one table, so the mapping is the
// single source of truth (教訓 5.30) and branching never compares bare display
// strings (教訓 5.19). A non-add tool (or `null`) maps to `null` so the
// controller can decide "no add tool is active" by a value, not a falsy check
// (教訓 5.18).

import { ADD_TOOL_KIND, type AddToolKind } from '../../domain/add/index';
import { type ToolId } from '../state/session';
import { TOOL_ID } from '../shell/tools';

/**
 * The fixed add-tool table: which toolbar tool id drives which add-tool kind.
 * Adding an add tool means editing ONLY this table (and tools.ts), keeping the
 * mapping in one place (教訓 5.30). Edit-mode / view tools are intentionally
 * absent — they are not add tools.
 */
const ADD_TOOL_FOR: ReadonlyMap<ToolId, AddToolKind> = new Map<ToolId, AddToolKind>([
  [TOOL_ID.AddPoint, ADD_TOOL_KIND.Point],
  [TOOL_ID.AddLine, ADD_TOOL_KIND.Line],
  [TOOL_ID.AddArea, ADD_TOOL_KIND.Face],
]);

/**
 * Resolve the {@link AddToolKind} a toolbar tool id drives, or `null` when the
 * id is not an add tool (an edit tool, or `null` = no tool). The controller
 * starts a session exactly when this is non-null and discards it (resetForSwitch)
 * on every transition to a different value (教訓 5.2 (d)/(e)).
 */
export function addToolKindFor(tool: ToolId | null): AddToolKind | null {
  if (tool === null) return null;
  return ADD_TOOL_FOR.get(tool) ?? null;
}
