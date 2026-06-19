// U20 pure-logic tests: the single edit-permission gate (教訓 5.13,
// 受け入れ基準 9).

import { describe, expect, it } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID } from './commands';
import {
  canEdit,
  isEditingCommand,
  resolveCommandEnabled,
} from './permissions';

describe('canEdit (教訓 5.13)', () => {
  it('view mode is not editable; add/edit are', () => {
    expect(canEdit(EDIT_MODE.View)).toBe(false);
    expect(canEdit(EDIT_MODE.Add)).toBe(true);
    expect(canEdit(EDIT_MODE.Edit)).toBe(true);
  });
});

describe('isEditingCommand', () => {
  it('undo/redo/delete are editing commands; open/zoom/help are not', () => {
    expect(isEditingCommand(COMMAND_ID.EditUndo)).toBe(true);
    expect(isEditingCommand(COMMAND_ID.EditRedo)).toBe(true);
    expect(isEditingCommand(COMMAND_ID.EditDelete)).toBe(true);
    expect(isEditingCommand(COMMAND_ID.FileOpen)).toBe(false);
    expect(isEditingCommand(COMMAND_ID.ViewZoomIn)).toBe(false);
    expect(isEditingCommand(COMMAND_ID.HelpAbout)).toBe(false);
  });
});

describe('resolveCommandEnabled (single shared judgement)', () => {
  it('an unrunnable command is always disabled', () => {
    expect(
      resolveCommandEnabled(COMMAND_ID.FileOpen, { runnable: false, mode: EDIT_MODE.Edit }),
    ).toBe(false);
  });

  it('an editing command is disabled in view-only mode even when runnable', () => {
    expect(
      resolveCommandEnabled(COMMAND_ID.EditDelete, { runnable: true, mode: EDIT_MODE.View }),
    ).toBe(false);
  });

  it('an editing command is enabled when runnable and editable', () => {
    expect(
      resolveCommandEnabled(COMMAND_ID.EditDelete, { runnable: true, mode: EDIT_MODE.Edit }),
    ).toBe(true);
  });

  it('a view-only command stays enabled while viewing (FR-42)', () => {
    expect(
      resolveCommandEnabled(COMMAND_ID.FileOpen, { runnable: true, mode: EDIT_MODE.View }),
    ).toBe(true);
  });
});
