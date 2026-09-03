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

// D3-2 — 診断画面はロガーを購読する（教訓 5.35 共有リソース更新は全依存先へ通知する）。
// 購読が無かったころは、画面を開いたまま新しいエラーが出ても欄に現れなかった。
describe('DiagnosticLogger の購読（useSyncExternalStore の前提）', () => {
  it('記録すると購読者へ知らせ、解除するとそれ以上来ない', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const listener = vi.fn();
    const off = logger.subscribe(listener);

    logger.log(LOG_LEVEL.Error, 'a');
    expect(listener).toHaveBeenCalledTimes(1);
    logger.log(LOG_LEVEL.Error, 'b');
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    logger.log(LOG_LEVEL.Error, 'c');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clear でも知らせる（開いたまま消したら欄も空になる）', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const listener = vi.fn();
    logger.subscribe(listener);

    logger.log(LOG_LEVEL.Info, 'x');
    expect(listener).toHaveBeenCalledTimes(1);

    logger.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(logger.getSnapshot()).toEqual([]);
  });

  it('すでに空なら clear は何もしない（通知もスナップショットの差し替えもしない）', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const listener = vi.fn();
    logger.subscribe(listener);
    const before = logger.getSnapshot();

    logger.clear();

    expect(listener).not.toHaveBeenCalled();
    expect(logger.getSnapshot()).toBe(before);
  });

  it('変化が無いあいだ getSnapshot は同じ配列を返し、記録すると別の配列になる', () => {
    // ここが崩れる（毎回 [...entries] を返す）と `useSyncExternalStore` は
    // 「毎レンダー値が変わった」と見なして無限ループする。
    const logger = new DiagnosticLogger({ clock: () => 0 });
    const first = logger.getSnapshot();
    expect(logger.getSnapshot()).toBe(first);

    logger.log(LOG_LEVEL.Warning, 'w');
    const second = logger.getSnapshot();
    expect(second).not.toBe(first);
    expect(logger.getSnapshot()).toBe(second);
    expect(second.map((e) => e.message)).toEqual(['w']);

    // 既に配ったスナップショットは、あとから記録が増えても書き換わらない。
    logger.log(LOG_LEVEL.Warning, 'w2');
    expect(second).toHaveLength(1);
  });

  it('snapshot() は getSnapshot() と同じ値を返す（経路は 1 本）', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    logger.log(LOG_LEVEL.Info, 'x');
    expect(logger.snapshot()).toBe(logger.getSnapshot());
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
