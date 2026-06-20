import { describe, expect, it, vi } from 'vitest';

import {
  ERROR_ORIGIN,
  type UserNotification,
} from './errors';
import {
  installGlobalErrorHandlers,
  wrapAsyncBoundary,
  wrapEventHandler,
  type ErrorEventTarget,
  type GlobalErrorHandlerOptions,
} from './global-handlers';
import { DiagnosticLogger } from './log';

/** A minimal in-memory event target for testing window-level installation. */
function fakeTarget(): ErrorEventTarget & {
  emit(type: string, event: unknown): void;
} {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  return {
    addEventListener(type, listener) {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    removeEventListener(type, listener) {
      const arr = listeners.get(type) ?? [];
      listeners.set(type, arr.filter((l) => l !== listener));
    },
    emit(type, event) {
      for (const l of listeners.get(type) ?? []) l(event);
    },
  };
}

function options(): GlobalErrorHandlerOptions & {
  notifications: UserNotification[];
} {
  const notifications: UserNotification[] = [];
  return {
    logger: new DiagnosticLogger({ clock: () => 0 }),
    onError: (n) => notifications.push(n),
    contextTimeLabel: () => '前27年',
    notifications,
  };
}

describe('installGlobalErrorHandlers (全経路網羅, 教訓 5.6)', () => {
  it('catches both window error and unhandledrejection paths', () => {
    const target = fakeTarget();
    const opts = options();
    const uninstall = installGlobalErrorHandlers(target, opts);

    target.emit('error', { error: new Error('sync boom') });
    target.emit('unhandledrejection', { reason: new Error('async boom') });

    expect(opts.notifications).toHaveLength(2);
    expect(opts.notifications[0]?.origin).toBe(ERROR_ORIGIN.Event);
    expect(opts.notifications[1]?.origin).toBe(ERROR_ORIGIN.Async);
    // both recorded with the作中時刻 context (教訓 5.15)
    expect(opts.logger.snapshot()[0]?.context.contextTime).toBe('前27年');

    uninstall();
    target.emit('error', { error: new Error('after') });
    expect(opts.notifications).toHaveLength(2); // no new after uninstall
  });
});

describe('wrapEventHandler (イベントハンドラ経路)', () => {
  it('funnels a thrown handler error to the single path and does not rethrow', () => {
    const opts = options();
    const handler = wrapEventHandler(opts, 'click', () => {
      throw new Error('handler boom');
    });
    expect(() => handler()).not.toThrow();
    expect(opts.notifications).toHaveLength(1);
    expect(opts.notifications[0]?.origin).toBe(ERROR_ORIGIN.Event);
  });

  it('passes through a successful handler without notifying', () => {
    const opts = options();
    const spy = vi.fn();
    wrapEventHandler(opts, 'click', spy)('arg');
    expect(spy).toHaveBeenCalledWith('arg');
    expect(opts.notifications).toHaveLength(0);
  });
});

describe('wrapAsyncBoundary (IPC / IO 経路)', () => {
  it('returns the value on success', async () => {
    const opts = options();
    const value = await wrapAsyncBoundary(opts, ERROR_ORIGIN.Ipc, 'save', async () => 7);
    expect(value).toBe(7);
    expect(opts.notifications).toHaveLength(0);
  });

  it('catches a rejection, notifies and resolves undefined', async () => {
    const opts = options();
    const value = await wrapAsyncBoundary(opts, ERROR_ORIGIN.Io, 'load', async () => {
      throw new Error('io boom');
    });
    expect(value).toBeUndefined();
    expect(opts.notifications[0]?.origin).toBe(ERROR_ORIGIN.Io);
  });
});
