// U20 pure-logic tests: command registry — 未登録 == 無効, dynamic gate, dispatch
// (受け入れ基準 7).

import { describe, expect, it, vi } from 'vitest';

import { COMMAND_ID, COMMAND_REFUSAL, CommandRegistry, isCommandId } from './commands';

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

// 増分 2 の手直し A5 — 断ったことをコマンドの持ち主へ伝える口（バグ狩り #2 / 反証 F5）。
//
// メニュー項目は灰色になって理由を持てるが、鍵盤には灰色が無い。だから Ctrl+K を
// 押しても「押せなかった」こと自体が見えなかった。**可否の判定は増やさず**、結果を
// 伝えるだけの口を足した。
describe('CommandRegistry — 断ったことを伝える（A5）', () => {
  it('canRun が偽なら onRefused が呼ばれ、run は呼ばれない', () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    const onRefused = vi.fn();
    registry.register(COMMAND_ID.EditCreateAnchorHere, { run, canRun: () => false, onRefused });

    expect(registry.dispatch(COMMAND_ID.EditCreateAnchorHere)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith(COMMAND_REFUSAL.NotRunnable);
  });

  it('走れたときは onRefused を呼ばない', () => {
    const registry = new CommandRegistry();
    const onRefused = vi.fn();
    registry.register(COMMAND_ID.EditCreateAnchorHere, { run: () => {}, onRefused });
    expect(registry.dispatch(COMMAND_ID.EditCreateAnchorHere)).toBe(true);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('reportRefusal は実行せずに理由だけ伝える（権限で止まった経路のため）', () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    const onRefused = vi.fn();
    registry.register(COMMAND_ID.EditCreateAnchorHere, { run, onRefused });
    registry.reportRefusal(COMMAND_ID.EditCreateAnchorHere, COMMAND_REFUSAL.ViewOnly);
    expect(run).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith(COMMAND_REFUSAL.ViewOnly);
  });

  it('未登録・口が無いコマンドでは何もしない（例外にしない）', () => {
    const registry = new CommandRegistry();
    expect(() =>
      registry.reportRefusal(COMMAND_ID.EditCreateAnchorHere, COMMAND_REFUSAL.NotRunnable),
    ).not.toThrow();
    registry.register(COMMAND_ID.EditUndo, { run: () => {}, canRun: () => false });
    expect(() => registry.dispatch(COMMAND_ID.EditUndo)).not.toThrow();
  });
});
