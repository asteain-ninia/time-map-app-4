import { describe, expect, it, vi } from 'vitest';

import {
  buildDiagnosticsSnapshot,
  DiagnosticLogger,
  LOG_LEVEL,
  type AppOverview,
  type LogEntry,
} from './log';

describe('DiagnosticLogger (FR-117 ログ記録, 教訓 5.15 / 5.41)', () => {
  it('records the real time from the injected clock, separate from作中時刻', () => {
    let now = 100;
    const logger = new DiagnosticLogger({ clock: () => now });
    now = 250;
    const entry = logger.log(LOG_LEVEL.Error, 'fail', { contextTime: '前27年' });
    expect(entry.recordedAtMs).toBe(250); // 実時刻
    expect(entry.context.contextTime).toBe('前27年'); // 作中時刻 — 区別される
  });

  it('keeps a bounded ring buffer (oldest drops)', () => {
    const logger = new DiagnosticLogger({ capacity: 2, clock: () => 0 });
    logger.log(LOG_LEVEL.Info, 'a');
    logger.log(LOG_LEVEL.Info, 'b');
    logger.log(LOG_LEVEL.Info, 'c');
    expect(logger.size).toBe(2);
    expect(logger.snapshot().map((e) => e.message)).toEqual(['b', 'c']);
  });

  it('forwards to a local sink and survives a sink failure (offline完結)', () => {
    const written: LogEntry[] = [];
    const sink = {
      write: vi.fn((e: LogEntry) => {
        written.push(e);
      }),
    };
    const logger = new DiagnosticLogger({ sink, clock: () => 0 });
    logger.log(LOG_LEVEL.Warning, 'w');
    expect(written).toHaveLength(1);

    const throwing = new DiagnosticLogger({
      sink: { write: () => { throw new Error('io'); } },
      clock: () => 0,
    });
    // a sink error must not propagate (an error-logging path can't itself crash)
    expect(() => throwing.log(LOG_LEVEL.Error, 'e')).not.toThrow();
    expect(throwing.size).toBe(1);
  });

  it('clear empties the buffer', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    logger.log(LOG_LEVEL.Info, 'x');
    logger.clear();
    expect(logger.size).toBe(0);
  });
});

describe('buildDiagnosticsSnapshot (FR-117 診断情報, FR-02 機微情報を含めない)', () => {
  it('combines the log with a non-sensitive overview (counts/flags only)', () => {
    const logger = new DiagnosticLogger({ clock: () => 5 });
    logger.log(LOG_LEVEL.Error, 'boom');
    const overview: AppOverview = {
      featureCount: 42,
      currentTimeLabel: '前27年',
      hasUnsavedChanges: true,
    };
    const snap = buildDiagnosticsSnapshot(logger, overview);
    expect(snap.log).toHaveLength(1);
    expect(snap.overview.featureCount).toBe(42);
    expect(snap.overview.currentTimeLabel).toBe('前27年');
  });
});
