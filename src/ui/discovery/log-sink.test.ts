// U41 — diagnostic-log FILE SINK bridge unit tests (FR-117 / FR-02, 教訓 5.7 / 5.41).
// The window IPC (`appendLog`) is a fake so the forwarding / best-effort swallow /
// session marker are verified WITHOUT Electron or a real bridge.

import { describe, expect, it, vi } from 'vitest';

import type { DiagnosticLogRecord } from '../../shell/ipc/contract';
import { DiagnosticLogger, LOG_LEVEL, type LogEntry } from './log';
import {
  createDiagnosticLogSink,
  logSessionStart,
  resolveDiagnosticLogSink,
  SESSION_START_MESSAGE,
} from './log-sink';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVEL.Error,
    message: 'boom',
    recordedAtMs: 1000,
    context: { summary: 'op' },
    ...overrides,
  };
}

describe('transport type lock (教訓 5.33: 層をまたぐ契約は両側テストで固定)', () => {
  it('LogEntry stays assignable to DiagnosticLogRecord (compile-time lock)', () => {
    // COMPILE-TIME LOCK: the ui LogEntry (src/ui/discovery/log.ts) must remain
    // structurally assignable to the shell transport type DiagnosticLogRecord
    // (src/shell/ipc/contract.ts). A future ui-side field that breaks the transport
    // shape turns THIS assignment into a type error before it can ship — the shell
    // cannot import the ui type (layer boundary), so this ui-side test is the ONE
    // place the two shapes are pinned against each other.
    const entry: LogEntry = makeEntry();
    const record: DiagnosticLogRecord = entry;
    expect(record).toBe(entry);
  });
});

describe('createDiagnosticLogSink (LogEntry → window IPC appendLog)', () => {
  it('forwards each entry verbatim to appendLog', () => {
    let forwarded: unknown;
    const appendLog = vi.fn((record: unknown): Promise<void> => {
      forwarded = record;
      return Promise.resolve();
    });
    const sink = createDiagnosticLogSink({ appendLog });
    const entry = makeEntry({ message: 'hello' });
    sink.write(entry);
    expect(appendLog).toHaveBeenCalledTimes(1);
    expect(forwarded).toBe(entry);
  });

  it('attaches a rejection handler so a failed persist never becomes an unhandledrejection (feedback-loop guard)', () => {
    const promise = Promise.resolve();
    const catchSpy = vi.spyOn(promise, 'catch');
    const appendLog = vi.fn((): Promise<void> => promise);
    createDiagnosticLogSink({ appendLog }).write(makeEntry());
    expect(catchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw and handles a rejecting appendLog', async () => {
    const appendLog = vi.fn((): Promise<void> => Promise.reject(new Error('io')));
    const sink = createDiagnosticLogSink({ appendLog });
    expect(() => sink.write(makeEntry())).not.toThrow();
    // Flush microtasks: if the rejection were unhandled it would surface here.
    await Promise.resolve();
    expect(appendLog).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronous throw from appendLog (partial mock / bridge error)', () => {
    const appendLog = vi.fn((): Promise<void> => {
      throw new Error('bridge missing');
    });
    const sink = createDiagnosticLogSink({ appendLog });
    expect(() => sink.write(makeEntry())).not.toThrow();
  });

  it('wires a DiagnosticLogger end-to-end: every log() reaches the file sink (教訓 5.7)', () => {
    let forwarded: unknown;
    const appendLog = vi.fn((record: unknown): Promise<void> => {
      forwarded = record;
      return Promise.resolve();
    });
    const logger = new DiagnosticLogger({
      sink: createDiagnosticLogSink({ appendLog }),
      clock: () => 7,
    });
    logger.log(LOG_LEVEL.Warning, 'w', { summary: 'op' });
    expect(appendLog).toHaveBeenCalledTimes(1);
    expect((forwarded as LogEntry).message).toBe('w');
    expect((forwarded as LogEntry).recordedAtMs).toBe(7);
    // The in-memory buffer still records too (single truth source unaffected).
    expect(logger.size).toBe(1);
  });
});

describe('resolveDiagnosticLogSink (合成ルートの結線 / vitest 環境の退避)', () => {
  it('returns a sink when the host exposes timeMapApi.appendLog', () => {
    let forwarded: unknown;
    const host = {
      timeMapApi: {
        appendLog: (record: unknown): Promise<void> => {
          forwarded = record;
          return Promise.resolve();
        },
      },
    };
    const sink = resolveDiagnosticLogSink(host);
    expect(sink).toBeDefined();
    const entry = makeEntry();
    sink!.write(entry);
    expect(forwarded).toBe(entry);
  });

  it('returns undefined when there is no timeMapApi (vitest/jsdom → memory-only)', () => {
    expect(resolveDiagnosticLogSink({})).toBeUndefined();
    expect(resolveDiagnosticLogSink(globalThis)).toBeUndefined();
  });

  it('returns undefined when appendLog is not a function', () => {
    expect(resolveDiagnosticLogSink({ timeMapApi: {} })).toBeUndefined();
    expect(resolveDiagnosticLogSink({ timeMapApi: { appendLog: 42 } })).toBeUndefined();
  });
});

describe('logSessionStart (FR-117 セッション開始マーカー: バージョン・日時)', () => {
  it('records ONE info entry carrying the version and the real-time stamp', () => {
    const logger = new DiagnosticLogger({ clock: () => 123 });
    const entry = logSessionStart(logger, { version: '9.9.9', contextTimeLabel: '前27年' });
    expect(logger.size).toBe(1);
    expect(entry.level).toBe(LOG_LEVEL.Info);
    expect(entry.message).toBe(SESSION_START_MESSAGE);
    expect(entry.recordedAtMs).toBe(123); // 日時 = real-time clock
    expect(entry.context.summary).toContain('9.9.9'); // バージョン
    expect(entry.context.contextTime).toBe('前27年');
  });

  it('omits contextTime when no label is supplied (exactOptional — no undefined field)', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const entry = logSessionStart(logger, { version: '1.0.0' });
    expect(entry.context.summary).toContain('1.0.0');
    expect('contextTime' in entry.context).toBe(false);
  });
});
