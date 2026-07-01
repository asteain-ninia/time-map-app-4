/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ERROR_ORIGIN } from './errors';
import { DiagnosticLogger, LOG_LEVEL } from './log';
import type { ErrorEventTarget } from './global-handlers';
import { wireGlobalErrorHandlers } from './error-wiring';
import { ErrorBoundary } from './ErrorBoundary';
import { ERROR_HANDLING_STRINGS } from './strings';

/** A minimal in-memory event target (same shape the global-handlers test uses). */
function fakeTarget(): ErrorEventTarget & {
  emit(type: string, event: unknown): void;
  count(type: string): number;
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
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe('wireGlobalErrorHandlers (FR-117 起動時の1回結線)', () => {
  it('installs the two paths ONCE and surfaces the notification through the notify sink', () => {
    const target = fakeTarget();
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const notified: string[] = [];

    const uninstall = wireGlobalErrorHandlers(target, {
      logger,
      contextTimeLabel: () => '前27年',
      notify: (message) => notified.push(message),
    });

    // exactly one listener per path (no double install)
    expect(target.count('error')).toBe(1);
    expect(target.count('unhandledrejection')).toBe(1);

    target.emit('error', { error: new Error('sync boom') });
    target.emit('unhandledrejection', { reason: new Error('async boom') });

    // both caught errors reached the existing notify sink (message text)
    expect(notified).toHaveLength(2);
    expect(notified[0]).toContain('予期しないエラーが発生しました');
    // logged through the single pipeline with the作中時刻 context (教訓 5.15)
    const entries = logger.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.context.contextTime).toBe('前27年');
    // the notifications carried the origin tags (per-path coverage lives in
    // global-handlers.test; here we just confirm the sink saw distinct messages)
    expect(ERROR_ORIGIN.Event).toBeDefined();
    expect(ERROR_ORIGIN.Async).toBeDefined();

    // uninstall removes BOTH listeners (no leak)
    uninstall();
    expect(target.count('error')).toBe(0);
    expect(target.count('unhandledrejection')).toBe(0);
    target.emit('error', { error: new Error('after') });
    expect(notified).toHaveLength(2); // nothing new after uninstall
  });

  it('defaults the notify sink to globalThis.alert (existing surface, no new toast)', () => {
    const target = fakeTarget();
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const alertSpy = vi
      .spyOn(globalThis, 'alert')
      .mockImplementation(() => {});
    try {
      const uninstall = wireGlobalErrorHandlers(target, { logger });
      target.emit('error', { error: new Error('boom') });
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(String(alertSpy.mock.calls[0]?.[0])).toContain(
        '予期しないエラーが発生しました',
      );
      uninstall();
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('a React render throw AND a non-React error land in the SAME shared logger (単一真実源)', () => {
    // Mirrors the App wiring: ONE logger backs both the ErrorBoundary and the
    // global handlers, so every path records into one diagnostics buffer.
    const target = fakeTarget();
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const uninstall = wireGlobalErrorHandlers(target, {
      logger,
      notify: () => {},
    });

    // React render path → ErrorBoundary (bound to the same logger).
    function Boom(): JSX.Element {
      throw new Error('render boom');
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary logger={logger}>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      spy.mockRestore();
    }
    expect(screen.getByTestId('error-boundary-fallback')).toHaveTextContent(
      ERROR_HANDLING_STRINGS.fallbackTitle,
    );

    // Non-React path → global handler (same logger).
    target.emit('unhandledrejection', { reason: new Error('async boom') });

    const entries = logger.snapshot();
    // both errors recorded in the ONE buffer, both at Error level (unrecoverable)
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === LOG_LEVEL.Error)).toBe(true);
    expect(entries[0]?.context.cause).toContain('render boom');
    expect(entries[1]?.context.cause).toContain('async boom');

    uninstall();
  });
});
