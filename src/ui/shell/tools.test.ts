// U20 pure-logic tests: mode -> tools mapping (FR-75, 受け入れ基準 3).

import { describe, expect, it } from 'vitest';

import { EDIT_MODE } from '../state/session';
import {
  ALL_TOOLS,
  TOOL_GROUPS,
  TOOL_ID,
  isAddTool,
  isSelectTool,
  modeForTool,
  toolBelongsToMode,
  toolPansFromEmptyPress,
  toolShowsVertexHandles,
  toolsForMode,
} from './tools';

describe('toolsForMode (FR-75)', () => {
  it('add mode exposes the point/line/area tools', () => {
    expect(toolsForMode(EDIT_MODE.Add)).toEqual([
      TOOL_ID.AddPoint,
      TOOL_ID.AddLine,
      TOOL_ID.AddArea,
    ]);
  });

  it('edit mode exposes the editing tools (select/vertex/move/knife/reparent/merge/ring/drill)', () => {
    expect(toolsForMode(EDIT_MODE.Edit)).toEqual([
      TOOL_ID.EditSelect,
      TOOL_ID.EditVertex,
      TOOL_ID.EditMove,
      TOOL_ID.EditKnife,
      TOOL_ID.EditReparent,
      TOOL_ID.EditMerge,
      TOOL_ID.EditRing,
      TOOL_ID.EditDrill,
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

describe('道具は 1 段（増分 5b / 設計書 §C.3）', () => {
  it('1 段に並ぶのは、追加と編集の道具を合わせた全部', () => {
    // 「どちらかのモードにしか出ない道具」がもう無いこと。並びは群のとおり。
    expect([...ALL_TOOLS].sort()).toEqual(
      [...toolsForMode(EDIT_MODE.Add), ...toolsForMode(EDIT_MODE.Edit)].sort(),
    );
  });

  it('群の中に同じ道具が 2 回出てこない', () => {
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('群はすべて名前と道具を持つ（近接のまとまりが空にならない）', () => {
    for (const g of TOOL_GROUPS) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.tools.length).toBeGreaterThan(0);
    }
  });
});

describe('内部の mode の導出（設計書 §D.1 / 裁定 1）', () => {
  it('鍵が閉じていれば、どの道具でも view のまま', () => {
    // **ここが落ちると K-6 が丸ごと消える。** `canEdit(mode)` は `mode !== View` の
    // 1 行なので、view が出なくなると読むだけの関門が常に開く（設計書 §A.1）。
    for (const tool of [null, ...ALL_TOOLS]) {
      expect(modeForTool(true, tool)).toBe(EDIT_MODE.View);
    }
  });

  it('鍵が開いていれば、面・線・点は add、それ以外は edit', () => {
    expect(modeForTool(false, TOOL_ID.AddArea)).toBe(EDIT_MODE.Add);
    expect(modeForTool(false, TOOL_ID.AddLine)).toBe(EDIT_MODE.Add);
    expect(modeForTool(false, TOOL_ID.AddPoint)).toBe(EDIT_MODE.Add);
    for (const tool of toolsForMode(EDIT_MODE.Edit)) {
      expect(modeForTool(false, tool)).toBe(EDIT_MODE.Edit);
    }
    // 道具を外した状態（＝「選択」）も edit。
    expect(modeForTool(false, null)).toBe(EDIT_MODE.Edit);
  });

  it('isAddTool は追加の 3 つだけを真にする', () => {
    for (const tool of toolsForMode(EDIT_MODE.Add)) expect(isAddTool(tool)).toBe(true);
    for (const tool of toolsForMode(EDIT_MODE.Edit)) expect(isAddTool(tool)).toBe(false);
    expect(isAddTool(null)).toBe(false);
  });

  it('「選択」は道具を外した状態と同じ扱い', () => {
    expect(isSelectTool(null)).toBe(true);
    expect(isSelectTool(TOOL_ID.EditSelect)).toBe(true);
    expect(isSelectTool(TOOL_ID.EditVertex)).toBe(false);
  });
});

describe('頂点ハンドルを出す道具（増分 5b。旧「編集モードのときだけ」）', () => {
  it('頂点・動かす だけが掴める', () => {
    expect(toolShowsVertexHandles(TOOL_ID.EditVertex)).toBe(true);
    expect(toolShowsVertexHandles(TOOL_ID.EditMove)).toBe(true);
  });

  it('「選択」と道具なしでは掴めない（所有者の裁定 2026-10-31 / B114）', () => {
    expect(toolShowsVertexHandles(null)).toBe(false);
    expect(toolShowsVertexHandles(TOOL_ID.EditSelect)).toBe(false);
  });

  it('何もないところからの左ドラッグで地図が動くのは「選択」と道具なしだけ（B114）', () => {
    expect(ALL_TOOLS.filter((t) => toolPansFromEmptyPress(t))).toEqual([TOOL_ID.EditSelect]);
    expect(toolPansFromEmptyPress(null)).toBe(true);
  });

  it('自分の板を持つ道具と、描く道具では掴めない', () => {
    for (const tool of [
      TOOL_ID.EditKnife,
      TOOL_ID.EditMerge,
      TOOL_ID.EditReparent,
      TOOL_ID.EditRing,
      TOOL_ID.EditDrill,
      TOOL_ID.AddArea,
      TOOL_ID.AddLine,
      TOOL_ID.AddPoint,
    ]) {
      expect(toolShowsVertexHandles(tool)).toBe(false);
    }
  });
});
