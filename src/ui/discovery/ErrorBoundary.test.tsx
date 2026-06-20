/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';
import { DiagnosticLogger, LOG_LEVEL } from './log';
import { ERROR_HANDLING_STRINGS } from './strings';

function Boom(): JSX.Element {
  throw new Error('render boom');
}

describe('ErrorBoundary (React 描画中例外の捕捉, 受け入れ基準3, FR-117)', () => {
  it('renders children when there is no error', () => {
    const logger = new DiagnosticLogger({ clock: () => 0 });
    render(
      <ErrorBoundary logger={logger}>
        <div data-testid="ok">中身</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('catches a render-time exception, shows the日本語 fallback and logs it', () => {
    const logger = new DiagnosticLogger({ clock: () => 1234 });
    // React logs the caught error to console.error; silence it for a clean run.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary logger={logger} contextTimeLabel={() => '前27年'}>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      spy.mockRestore();
    }

    // The whole tree did not crash — the日本語 fallback is shown instead.
    const fallback = screen.getByTestId('error-boundary-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent(ERROR_HANDLING_STRINGS.fallbackTitle);
    expect(fallback).toHaveTextContent(ERROR_HANDLING_STRINGS.reportHint);

    // The error was recorded with the real-time stamp and作中時刻 (教訓 5.15).
    const entries = logger.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe(LOG_LEVEL.Error);
    expect(entries[0]?.recordedAtMs).toBe(1234);
    expect(entries[0]?.context.contextTime).toBe('前27年');
    expect(entries[0]?.context.cause).toContain('render boom');
  });
});
