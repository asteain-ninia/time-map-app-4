// U20 pure-logic tests: command registry — 未登録 == 無効, dynamic gate, dispatch
// (受け入れ基準 7).

import { describe, expect, it, vi } from 'vitest';

import { COMMAND_ID, CommandRegistry, isCommandId } from './commands';

describe('isCommandId', () => {
  it('recognises known ids and rejects unknown', () => {
    expect(isCommandId(COMMAND_ID.FileSave)).toBe(true);
    expect(isCommandId('nope.unknown')).toBe(false);
  });
});

describe('CommandRegistry (未登録 == 無効)', () => {
  it('an unregistered command is not runnable and dispatch is a safe no-op', () => {
    const r = new CommandRegistry();
    expect(r.isRegistered(COMMAND_ID.FileSave)).toBe(false);
    expect(r.isRunnable(COMMAND_ID.FileSave)).toBe(false);
    expect(r.dispatch(COMMAND_ID.FileSave)).toBe(false);
  });

  it('registers a handler and dispatches it', () => {
    const r = new CommandRegistry();
    const run = vi.fn();
    r.register(COMMAND_ID.FileSave, { run });
    expect(r.isRunnable(COMMAND_ID.FileSave)).toBe(true);
    expect(r.dispatch(COMMAND_ID.FileSave)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('honours a dynamic canRun gate (FR-74 undo/redo availability)', () => {
    const r = new CommandRegistry();
    let available = false;
    const run = vi.fn();
    r.register(COMMAND_ID.EditUndo, { run, canRun: () => available });

    expect(r.isRunnable(COMMAND_ID.EditUndo)).toBe(false);
    expect(r.dispatch(COMMAND_ID.EditUndo)).toBe(false);
    expect(run).not.toHaveBeenCalled();

    available = true;
    expect(r.isRunnable(COMMAND_ID.EditUndo)).toBe(true);
    expect(r.dispatch(COMMAND_ID.EditUndo)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('unregister returns to the disabled state', () => {
    const r = new CommandRegistry();
    r.register(COMMAND_ID.FileSave, { run: vi.fn() });
    r.unregister(COMMAND_ID.FileSave);
    expect(r.isRunnable(COMMAND_ID.FileSave)).toBe(false);
  });
});
