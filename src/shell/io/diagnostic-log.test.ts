// U41 — diagnostic log FILE SINK unit tests (FR-117 / FR-02, 教訓 5.41). The fs is
// an in-memory fake so the append / prune / rotation / best-effort behaviour is
// verified WITHOUT touching a real disk or Electron. The write-amount limits
// (normalizer / line cap / daily file cap — Codex MED-1/MED-2) and the seat-
// reserving startup prune (LOW-3) are covered here too.

import { describe, expect, it, vi } from 'vitest';

import type { DiagnosticLogRecord } from '../ipc/contract';
import {
  appendDiagnosticLog,
  capDiagnosticLogLine,
  DEFAULT_DIAGNOSTIC_LOG_GENERATIONS,
  DIAGNOSTIC_LOG_FILE_CAP_MESSAGE,
  diagnosticLogDateKey,
  diagnosticLogFileName,
  formatDiagnosticLogLine,
  MAX_LOG_CONTEXT_VALUE_CHARS,
  MAX_LOG_FILE_BYTES,
  MAX_LOG_LEVEL_CHARS,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_MESSAGE_CHARS,
  normalizeDiagnosticLogRecord,
  pruneDiagnosticLogs,
  selectDiagnosticLogsToDelete,
  type DiagnosticLogEnv,
  type DiagnosticLogFs,
} from './diagnostic-log';

function makeRecord(overrides: Partial<DiagnosticLogRecord> = {}): DiagnosticLogRecord {
  return {
    level: 'error',
    message: 'boom',
    recordedAtMs: 1000,
    context: { summary: 'op', contextTime: '前27年' },
    ...overrides,
  };
}

/** An in-memory fake fs that records ops and stores file contents by path. */
function makeFakeFs(seed: Record<string, string> = {}): {
  fs: DiagnosticLogFs;
  files: Map<string, string>;
  ops: string[];
} {
  const files = new Map<string, string>(Object.entries(seed));
  const ops: string[] = [];
  const nameOf = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const fs: DiagnosticLogFs = {
    appendFile: async (path, text) => {
      ops.push(`append ${nameOf(path)}`);
      files.set(path, (files.get(path) ?? '') + text);
    },
    mkdir: async (dir) => {
      ops.push(`mkdir ${nameOf(dir)}`);
    },
    readdir: async () => [...files.keys()].map(nameOf),
    remove: async (path) => {
      ops.push(`remove ${nameOf(path)}`);
      // Remove by matching basename (paths may carry platform separators).
      for (const key of [...files.keys()]) {
        if (nameOf(key) === nameOf(path)) files.delete(key);
      }
    },
    fileSize: async (path) => {
      for (const [key, content] of files) {
        if (nameOf(key) === nameOf(path)) return Buffer.byteLength(content, 'utf8');
      }
      return 0; // missing file = a fresh day's file (port contract)
    },
  };
  return { fs, files, ops };
}

describe('diagnosticLogFileName (日付ローテーション)', () => {
  it('formats the LOCAL calendar day as diagnostic-YYYY-MM-DD.jsonl', () => {
    // Local components: month is 0-based → +1; zero-padded.
    expect(diagnosticLogFileName(new Date(2026, 6, 12))).toBe('diagnostic-2026-07-12.jsonl');
    expect(diagnosticLogFileName(new Date(2026, 0, 3))).toBe('diagnostic-2026-01-03.jsonl');
  });

  it('a different day yields a different file (rotation boundary)', () => {
    const a = diagnosticLogFileName(new Date(2026, 6, 12));
    const b = diagnosticLogFileName(new Date(2026, 6, 13));
    expect(a).not.toBe(b);
  });
});

describe('formatDiagnosticLogLine (JSONL 1 行 1 エントリ)', () => {
  it('serializes the record verbatim + a trailing newline', () => {
    const line = formatDiagnosticLogLine(makeRecord());
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trimEnd())).toEqual(makeRecord());
  });
});

describe('diagnosticLogDateKey / selectDiagnosticLogsToDelete (世代保持)', () => {
  it('extracts the sortable date key, ignoring non-log names', () => {
    expect(diagnosticLogDateKey('diagnostic-2026-07-12.jsonl')).toBe('2026-07-12');
    expect(diagnosticLogDateKey('world.gimoza')).toBeUndefined();
    expect(diagnosticLogDateKey('diagnostic-2026-07-12.txt')).toBeUndefined();
  });

  it('keeps the newest `keep` generations and returns the older ones', () => {
    const names = [
      'diagnostic-2026-07-10.jsonl',
      'diagnostic-2026-07-11.jsonl',
      'diagnostic-2026-07-12.jsonl',
      'diagnostic-2026-07-13.jsonl',
    ];
    const toDelete = selectDiagnosticLogsToDelete(names, 2);
    expect(toDelete).toEqual(['diagnostic-2026-07-11.jsonl', 'diagnostic-2026-07-10.jsonl']);
  });

  it('deletes nothing when under the cap, and ignores unrelated files', () => {
    const names = ['diagnostic-2026-07-12.jsonl', 'readme.txt', 'world.gimoza'];
    expect(selectDiagnosticLogsToDelete(names, DEFAULT_DIAGNOSTIC_LOG_GENERATIONS)).toEqual([]);
  });

  it('keep<=0 deletes all log files (defensive)', () => {
    const names = ['diagnostic-2026-07-12.jsonl', 'diagnostic-2026-07-13.jsonl'];
    expect(selectDiagnosticLogsToDelete(names, 0)).toHaveLength(2);
  });
});

describe('normalizeDiagnosticLogRecord (MED-2: main 側で強制する正規化)', () => {
  it('passes a well-formed record through, values intact', () => {
    expect(normalizeDiagnosticLogRecord(makeRecord())).toEqual(makeRecord());
  });

  it('strips unknown keys at both levels AND a renderer-supplied truncated flag', () => {
    const hostile = {
      ...makeRecord(),
      junk: 'x',
      __proto__polluted: 1,
      truncated: true, // only MAIN may assert this — must be stripped
      context: { summary: 'op', evil: { deep: 'object' }, extra: 'y' },
    };
    const normalized = normalizeDiagnosticLogRecord(hostile);
    expect(normalized).toEqual({
      level: 'error',
      message: 'boom',
      recordedAtMs: 1000,
      context: { summary: 'op' },
    });
    expect('truncated' in normalized).toBe(false);
    expect('junk' in normalized).toBe(false);
  });

  it('coerces primitive values to strings and drops non-primitive values', () => {
    const normalized = normalizeDiagnosticLogRecord({
      level: 7,
      message: true,
      recordedAtMs: 5,
      context: { summary: 42, cause: { stack: 'obj' }, contextTime: ['array'] },
    });
    expect(normalized.level).toBe('7');
    expect(normalized.message).toBe('true');
    expect(normalized.context).toEqual({ summary: '42' }); // object/array values dropped
  });

  it('truncates over-long fields to the exported char caps (MED-1 連打対策)', () => {
    const normalized = normalizeDiagnosticLogRecord({
      level: 'L'.repeat(MAX_LOG_LEVEL_CHARS + 100),
      message: 'M'.repeat(MAX_LOG_MESSAGE_CHARS + 100),
      recordedAtMs: 1,
      context: {
        summary: 'S'.repeat(MAX_LOG_CONTEXT_VALUE_CHARS + 100),
        cause: 'C'.repeat(MAX_LOG_CONTEXT_VALUE_CHARS + 100),
        contextTime: 'T'.repeat(MAX_LOG_CONTEXT_VALUE_CHARS + 100),
      },
    });
    expect(normalized.level).toHaveLength(MAX_LOG_LEVEL_CHARS);
    expect(normalized.message).toHaveLength(MAX_LOG_MESSAGE_CHARS);
    expect(normalized.context.summary).toHaveLength(MAX_LOG_CONTEXT_VALUE_CHARS);
    expect(normalized.context.cause).toHaveLength(MAX_LOG_CONTEXT_VALUE_CHARS);
    expect(normalized.context.contextTime).toHaveLength(MAX_LOG_CONTEXT_VALUE_CHARS);
  });

  it('rejects a non-finite recordedAtMs (→0) and non-object input (→ safe defaults)', () => {
    expect(normalizeDiagnosticLogRecord(makeRecord({ recordedAtMs: Infinity })).recordedAtMs).toBe(0);
    expect(normalizeDiagnosticLogRecord(makeRecord({ recordedAtMs: NaN })).recordedAtMs).toBe(0);
    expect(
      normalizeDiagnosticLogRecord({ ...makeRecord(), recordedAtMs: '123' as unknown as number })
        .recordedAtMs,
    ).toBe(0);
    expect(normalizeDiagnosticLogRecord(null)).toEqual({
      level: 'unknown',
      message: '',
      recordedAtMs: 0,
      context: {},
    });
    expect(normalizeDiagnosticLogRecord('a string')).toEqual({
      level: 'unknown',
      message: '',
      recordedAtMs: 0,
      context: {},
    });
  });

  it('the exported caps carry the reviewed sizes', () => {
    expect(MAX_LOG_MESSAGE_CHARS).toBe(4096);
    expect(MAX_LOG_CONTEXT_VALUE_CHARS).toBe(1024);
    expect(MAX_LOG_LINE_BYTES).toBe(16 * 1024);
    expect(MAX_LOG_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('capDiagnosticLogLine (MED-1: 1 行のバイト上限)', () => {
  it('returns an under-cap line untouched (no truncated flag)', () => {
    const line = capDiagnosticLogLine(makeRecord());
    expect(JSON.parse(line.trimEnd())).toEqual(makeRecord());
    expect('truncated' in JSON.parse(line.trimEnd())).toBe(false);
  });

  it('cuts + flags a line that exceeds MAX_LOG_LINE_BYTES even after the char caps', () => {
    // Control chars JSON-escape to 6 bytes each (BEL -> the 6-char sequence
    // backslash-u-0-0-0-7), so a message WITHIN the 4096-char normalizer cap can
    // still encode to ~24KB — the line cap must catch it (why both caps exist).
    const record = normalizeDiagnosticLogRecord(
      makeRecord({ message: '\u0007'.repeat(MAX_LOG_MESSAGE_CHARS) }),
    );
    expect(record.message).toHaveLength(MAX_LOG_MESSAGE_CHARS); // char cap passed it
    const line = capDiagnosticLogLine(record);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES);
    const parsed = JSON.parse(line.trimEnd()) as DiagnosticLogRecord;
    expect(parsed.truncated).toBe(true);
    expect(parsed.message.length).toBeLessThan(MAX_LOG_MESSAGE_CHARS);
    expect(parsed.level).toBe('error'); // the non-dominant fields survive
    expect(parsed.recordedAtMs).toBe(1000);
  });
});

describe('appendDiagnosticLog (追記・ベストエフォート)', () => {
  it('ensures the dir then appends one JSONL line to todays file', async () => {
    const { fs, files, ops } = makeFakeFs();
    const env: DiagnosticLogEnv = { fs, dir: '/logs', now: () => new Date(2026, 6, 12) };
    await appendDiagnosticLog(env, makeRecord({ message: 'first' }));
    await appendDiagnosticLog(env, makeRecord({ message: 'second' }));

    // mkdir happens before the append (directory is ensured).
    expect(ops.indexOf('mkdir logs')).toBeLessThan(ops.indexOf('append diagnostic-2026-07-12.jsonl'));

    const [path, content] = [...files.entries()][0]!;
    expect(path).toContain('diagnostic-2026-07-12.jsonl');
    const lines = content.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('first');
    expect(JSON.parse(lines[1]!).message).toBe('second');
  });

  it('rotates to a new file when the day changes', async () => {
    const { fs, files } = makeFakeFs();
    let day = 12;
    const env: DiagnosticLogEnv = { fs, dir: '/logs', now: () => new Date(2026, 6, day) };
    await appendDiagnosticLog(env, makeRecord());
    day = 13;
    await appendDiagnosticLog(env, makeRecord());
    // Two distinct daily files exist (paths may carry platform separators).
    const keys = [...files.keys()];
    expect(keys.some((p) => p.includes('diagnostic-2026-07-12.jsonl'))).toBe(true);
    expect(keys.some((p) => p.includes('diagnostic-2026-07-13.jsonl'))).toBe(true);
  });

  it('normalizes hostile input end-to-end before persisting (MED-2)', async () => {
    const { fs, files } = makeFakeFs();
    const env: DiagnosticLogEnv = { fs, dir: '/logs', now: () => new Date(2026, 6, 12) };
    await appendDiagnosticLog(env, {
      level: {},
      message: 'M'.repeat(MAX_LOG_MESSAGE_CHARS + 5000),
      recordedAtMs: 'not-a-number',
      junk: 'x',
      context: { cause: 5, evil: 'y' },
    });
    const content = [...files.values()][0]!;
    const parsed = JSON.parse(content.trimEnd()) as Record<string, unknown>;
    expect(parsed['level']).toBe('unknown'); // object level dropped → fallback
    expect((parsed['message'] as string).length).toBe(MAX_LOG_MESSAGE_CHARS);
    expect(parsed['recordedAtMs']).toBe(0);
    expect(parsed['context']).toEqual({ cause: '5' }); // coerced; `evil` stripped
    expect('junk' in parsed).toBe(false);
  });

  it('swallows a write failure and never throws (log.ts:99 契約)', async () => {
    const fs: DiagnosticLogFs = {
      appendFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
      mkdir: async () => {},
      readdir: async () => [],
      remove: async () => {},
      fileSize: async () => 0,
    };
    const env: DiagnosticLogEnv = { fs, dir: '/logs', now: () => new Date(2026, 6, 12) };
    await expect(appendDiagnosticLog(env, makeRecord())).resolves.toBeUndefined();
  });
});

describe('appendDiagnosticLog: 1 日ファイルのバイト上限 (MED-1)', () => {
  // Derive the cap from the MEASURED line size so the crossing arithmetic is exact
  // (no reliance on hand-counted JSON skeleton bytes).
  const oneLineBytes = Buffer.byteLength(
    formatDiagnosticLogLine(makeRecord({ message: 'x'.repeat(100) })),
    'utf8',
  );

  it('appends the cap marker EXACTLY ONCE when the file crosses the cap, then drops silently', async () => {
    const { fs, files, ops } = makeFakeFs();
    const env: DiagnosticLogEnv = {
      fs,
      dir: '/logs',
      now: () => new Date(2026, 6, 12),
      // 2.5 lines: appends 1+2 fit plain; append 3 crosses (line+marker); append 4 drops.
      maxFileBytes: Math.floor(oneLineBytes * 2.5),
    };
    const msg = (label: string): DiagnosticLogRecord =>
      makeRecord({ message: label + 'x'.repeat(100 - label.length) });
    await appendDiagnosticLog(env, msg('a-'));
    await appendDiagnosticLog(env, msg('b-'));
    await appendDiagnosticLog(env, msg('c-')); // crosses the cap → line + marker
    await appendDiagnosticLog(env, msg('d-')); // beyond the cap → silently dropped

    const content = [...files.values()][0]!;
    const lines = content.trimEnd().split('\n').map((l) => JSON.parse(l) as DiagnosticLogRecord);
    expect(lines).toHaveLength(4); // 3 records + ONE marker; the 4th append left no trace
    expect(lines[0]!.message.startsWith('a-')).toBe(true);
    expect(lines[1]!.message.startsWith('b-')).toBe(true);
    expect(lines[2]!.message.startsWith('c-')).toBe(true);
    expect(lines[3]!.message).toBe(DIAGNOSTIC_LOG_FILE_CAP_MESSAGE);
    expect(lines[3]!.truncated).toBe(true);
    expect(lines.some((l) => l.message.startsWith('d-'))).toBe(false);
    // Exactly 3 physical appends (the 3rd wrote line+marker as one; the 4th none).
    expect(ops.filter((o) => o.startsWith('append')).length).toBe(3);
  });

  it('drops silently when the daily file is already at/over the cap', async () => {
    const today = 'diagnostic-2026-07-12.jsonl';
    const { fs, files, ops } = makeFakeFs({ [`/logs/${today}`]: 'y'.repeat(500) });
    const env: DiagnosticLogEnv = {
      fs,
      dir: '/logs',
      now: () => new Date(2026, 6, 12),
      maxFileBytes: 100,
    };
    await appendDiagnosticLog(env, makeRecord());
    expect(ops.filter((o) => o.startsWith('append'))).toHaveLength(0);
    expect([...files.values()][0]).toBe('y'.repeat(500)); // untouched
  });

  it('a NEW day starts a fresh file even when yesterdays file hit its cap', async () => {
    const yesterday = 'diagnostic-2026-07-12.jsonl';
    const { fs, files } = makeFakeFs({ [`/logs/${yesterday}`]: 'y'.repeat(500) });
    const env: DiagnosticLogEnv = {
      fs,
      dir: '/logs',
      now: () => new Date(2026, 6, 13),
      maxFileBytes: 100,
    };
    await appendDiagnosticLog(env, makeRecord({ message: 'fresh' }));
    const keys = [...files.keys()];
    expect(keys.some((p) => p.includes('diagnostic-2026-07-13.jsonl'))).toBe(true);
  });
});

describe('pruneDiagnosticLogs (起動時に古い世代を削除)', () => {
  it('removes generations older than keepGenerations, newest retained', async () => {
    const seed: Record<string, string> = {};
    for (let d = 1; d <= 10; d++) {
      seed[`/logs/diagnostic-2026-07-${String(d).padStart(2, '0')}.jsonl`] = 'x\n';
    }
    const { fs, files } = makeFakeFs(seed);
    // Pin the clock to the newest seeded day so today's file already exists and the
    // seat reservation is a no-op here (the LOW-3 case is tested separately below).
    await pruneDiagnosticLogs({
      fs,
      dir: '/logs',
      keepGenerations: 7,
      now: () => new Date(2026, 6, 10),
    });

    const remaining = [...files.keys()].map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
    expect(remaining).toHaveLength(7);
    // The 3 oldest (07-01..07-03) are gone; the newest (07-10) remains.
    expect(remaining).not.toContain('diagnostic-2026-07-01.jsonl');
    expect(remaining).toContain('diagnostic-2026-07-10.jsonl');
  });

  it('defaults to keeping 7 generations', async () => {
    const seed: Record<string, string> = {};
    for (let d = 1; d <= 9; d++) {
      seed[`/logs/diagnostic-2026-07-0${d}.jsonl`] = 'x\n';
    }
    const { fs, files } = makeFakeFs(seed);
    await pruneDiagnosticLogs({ fs, dir: '/logs', now: () => new Date(2026, 6, 9) });
    expect([...files.keys()]).toHaveLength(DEFAULT_DIAGNOSTIC_LOG_GENERATIONS);
  });

  it('reserves todays seat: keep 7 with 7 OLD generations deletes the oldest (LOW-3)', async () => {
    // First launch of the day: 7 generations exist (07-05..07-11), today's (07-12)
    // does NOT yet. Without the reservation nothing is deleted and the session
    // marker would create an 8th generation. With it the oldest goes now.
    const seed: Record<string, string> = {};
    for (let d = 5; d <= 11; d++) {
      seed[`/logs/diagnostic-2026-07-${String(d).padStart(2, '0')}.jsonl`] = 'x\n';
    }
    const { fs, files } = makeFakeFs(seed);
    await pruneDiagnosticLogs({
      fs,
      dir: '/logs',
      keepGenerations: 7,
      now: () => new Date(2026, 6, 12),
    });
    const remaining = [...files.keys()].map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
    expect(remaining).toHaveLength(6); // 6 old + the upcoming today = 7 total
    expect(remaining).not.toContain('diagnostic-2026-07-05.jsonl'); // oldest gone
    expect(remaining).toContain('diagnostic-2026-07-11.jsonl');
  });

  it('does not double-count today when its file already exists', async () => {
    const seed: Record<string, string> = {};
    for (let d = 6; d <= 12; d++) {
      seed[`/logs/diagnostic-2026-07-${String(d).padStart(2, '0')}.jsonl`] = 'x\n';
    }
    const { fs, files } = makeFakeFs(seed); // 7 files INCLUDING today (07-12)
    await pruneDiagnosticLogs({
      fs,
      dir: '/logs',
      keepGenerations: 7,
      now: () => new Date(2026, 6, 12),
    });
    expect([...files.keys()]).toHaveLength(7); // exactly at cap — nothing deleted
  });

  it('never deletes todays ACTIVE file, even when future-dated files outrank it', async () => {
    // Clock rollback: a file dated tomorrow exists. keep=1 would select today for
    // deletion (the future file is "newest") — the guard must skip the active file.
    const { fs, files } = makeFakeFs({
      '/logs/diagnostic-2026-07-12.jsonl': 'today\n',
      '/logs/diagnostic-2026-07-13.jsonl': 'future\n',
    });
    await pruneDiagnosticLogs({
      fs,
      dir: '/logs',
      keepGenerations: 1,
      now: () => new Date(2026, 6, 12),
    });
    const remaining = [...files.keys()].map((p) => p.slice(p.lastIndexOf('/') + 1));
    expect(remaining).toContain('diagnostic-2026-07-12.jsonl'); // active file survives
  });

  it('is a no-op (no throw) when the logs directory does not exist yet', async () => {
    const fs: DiagnosticLogFs = {
      appendFile: async () => {},
      mkdir: async () => {},
      readdir: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      remove: vi.fn(async () => {}),
      fileSize: async () => 0,
    };
    await expect(pruneDiagnosticLogs({ fs, dir: '/logs' })).resolves.toBeUndefined();
    expect(fs.remove).not.toHaveBeenCalled();
  });
});
