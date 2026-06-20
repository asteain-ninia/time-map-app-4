import { describe, expect, it } from 'vitest';

import {
  buildUserMessage,
  describeCause,
  DISMISS_ON,
  ERROR_ORIGIN,
  ERROR_SEVERITY,
  handleError,
  handleRenderError,
  mayDismiss,
} from './errors';
import { DiagnosticLogger, LOG_LEVEL } from './log';
import { ERROR_HANDLING_STRINGS } from './strings';

describe('buildUserMessage (FR-115 報告案内の付与規約)', () => {
  it('leaves a recoverable message untouched', () => {
    const msg = buildUserMessage(ERROR_SEVERITY.Recoverable, '入力を確認してください。');
    expect(msg).toBe('入力を確認してください。');
    expect(msg).not.toContain(ERROR_HANDLING_STRINGS.reportHint);
  });

  it('appends the report hint to an unrecoverable message exactly once', () => {
    const msg = buildUserMessage(ERROR_SEVERITY.Unrecoverable, '内部エラー。');
    expect(msg).toContain(ERROR_HANDLING_STRINGS.reportHint);
    // already-present hint is not duplicated
    const twice = buildUserMessage(ERROR_SEVERITY.Unrecoverable, msg);
    expect(twice.split(ERROR_HANDLING_STRINGS.reportHint)).toHaveLength(2);
  });
});

describe('handleError (単一の変換+ログ経路, 受け入れ基準3, 教訓 5.6)', () => {
  it('returns a notification and records a log entry with separated time fields', () => {
    const logger = new DiagnosticLogger({ clock: () => 1000 });
    const note = handleError(logger, {
      origin: ERROR_ORIGIN.Ipc,
      severity: ERROR_SEVERITY.Unrecoverable,
      message: '保存に失敗しました。',
      cause: new Error('disk full'),
      contextSummary: 'save',
      contextTime: '紀元前27年',
    });

    expect(note.origin).toBe(ERROR_ORIGIN.Ipc);
    expect(note.message).toContain(ERROR_HANDLING_STRINGS.reportHint);

    const entries = logger.snapshot();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.level).toBe(LOG_LEVEL.Error);
    // 実時刻 (recordedAtMs) と 作中時刻 (contextTime) を区別 (教訓 5.15)
    expect(entry?.recordedAtMs).toBe(1000);
    expect(entry?.context.contextTime).toBe('紀元前27年');
    expect(entry?.context.cause).toContain('disk full');
  });

  it('logs a recoverable error at warning level without the report hint', () => {
    const logger = new DiagnosticLogger();
    const note = handleError(logger, {
      origin: ERROR_ORIGIN.DomainRejection,
      severity: ERROR_SEVERITY.Recoverable,
      message: '錨の順序を確認してください。',
    });
    expect(note.message).not.toContain(ERROR_HANDLING_STRINGS.reportHint);
    expect(logger.snapshot()[0]?.level).toBe(LOG_LEVEL.Warning);
  });
});

describe('handleRenderError (React 境界経路, FR-117)', () => {
  it('always produces an unrecoverable notification with the report hint', () => {
    const logger = new DiagnosticLogger();
    const note = handleRenderError(logger, new Error('boom'), '1年');
    expect(note.severity).toBe(ERROR_SEVERITY.Unrecoverable);
    expect(note.origin).toBe(ERROR_ORIGIN.Render);
    expect(note.message).toContain(ERROR_HANDLING_STRINGS.reportHint);
    expect(logger.snapshot()[0]?.context.contextTime).toBe('1年');
  });
});

describe('mayDismiss (判断用メッセージの消去契機, 教訓 5.12)', () => {
  const logger = new DiagnosticLogger();
  const note = handleError(logger, {
    origin: ERROR_ORIGIN.DomainRejection,
    severity: ERROR_SEVERITY.Recoverable,
    message: '拒否理由',
  });

  it('permits only retry / explicit close / successful replace', () => {
    expect(mayDismiss(note, DISMISS_ON.Retry)).toBe(true);
    expect(mayDismiss(note, DISMISS_ON.ExplicitClose)).toBe(true);
    expect(mayDismiss(note, DISMISS_ON.SuccessfulReplace)).toBe(true);
  });
});

describe('describeCause', () => {
  it('stringifies errors, strings and objects safely', () => {
    expect(describeCause(new Error('x'))).toContain('x');
    expect(describeCause('plain')).toBe('plain');
    expect(describeCause({ a: 1 })).toBe('{"a":1}');
  });
});
