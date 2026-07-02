// U20 pure-logic tests: mode -> tools mapping (FR-75, 受け入れ基準 3).

import { describe, expect, it } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { TOOL_ID, toolsForMode, toolBelongsToMode } from './tools';

describe('toolsForMode (FR-75)', () => {
  it('add mode exposes the point/line/area tools', () => {
    expect(toolsForMode(EDIT_MODE.Add)).toEqual([
      TOOL_ID.AddPoint,
      TOOL_ID.AddLine,
      TOOL_ID.AddArea,
    ]);
  });

  it('edit mode exposes the editing tools (select/vertex/move/knife/reparent/merge/ring)', () => {
    expect(toolsForMode(EDIT_MODE.Edit)).toEqual([
      TOOL_ID.EditSelect,
      TOOL_ID.EditVertex,
      TOOL_ID.EditMove,
      TOOL_ID.EditKnife,
      TOOL_ID.EditReparent,
      TOOL_ID.EditMerge,
      TOOL_ID.EditRing,
    ]);
  });

  it('view mode exposes no editing tools', () => {
    expect(toolsForMode(EDIT_MODE.View)).toEqual([]);
  });

  it('tool sets are disjoint between add and edit modes', () => {
    const add = new Set(toolsForMode(EDIT_MODE.Add));
    for (const t of toolsForMode(EDIT_MODE.Edit)) {
      expect(add.has(t)).toBe(false);
    }
  });

  it('toolBelongsToMode reflects the mapping', () => {
    expect(toolBelongsToMode(TOOL_ID.AddPoint, EDIT_MODE.Add)).toBe(true);
    expect(toolBelongsToMode(TOOL_ID.AddPoint, EDIT_MODE.Edit)).toBe(false);
    expect(toolBelongsToMode(TOOL_ID.EditKnife, EDIT_MODE.Edit)).toBe(true);
  });
});
