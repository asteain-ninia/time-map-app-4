// a11y unit test (jsdom): the shared modal keydown helper (第5次バグハント
// MEDIUM / a11y). Verifies Esc calls onClose and Tab / Shift+Tab wrap focus at the
// ends of the dialog's focusable ring so it never escapes to the背面.

import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useModalKeydown } from './focus-trap';

afterEach(() => cleanup());

/** A minimal dialog with three buttons, wired to the shared trap. */
function Harness(props: { readonly onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useModalKeydown(ref, props.onClose);
  return (
    <div data-testid="dialog" role="dialog" tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
      <button type="button" data-testid="first">
        first
      </button>
      <button type="button" data-testid="mid">
        mid
      </button>
      <button type="button" data-testid="last">
        last
      </button>
    </div>
  );
}

describe('useModalKeydown (shared modal a11y)', () => {
  it('Esc calls onClose', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab on the last focusable wraps to the first', () => {
    render(<Harness onClose={() => {}} />);
    const last = screen.getByTestId('last');
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('Shift+Tab on the first focusable wraps to the last', () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByTestId('first');
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('last'));
  });

  it('Tab in the middle of the ring does not force-wrap (browser default handles it)', () => {
    render(<Harness onClose={() => {}} />);
    const mid = screen.getByTestId('mid');
    mid.focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
    // Not at an end ⇒ the helper leaves focus alone (does not jump to first/last).
    expect(document.activeElement).toBe(mid);
  });

  // 回帰 (bughunt review #4): on mount the dialog ROOT (tabIndex=-1) holds focus, so it
  // is NOT in the focusable ring. The wrap branches only fire on active===first/last, so
  // the FIRST key being Shift+Tab used to fall through to the browser default and escape
  // to the背面. When focus is on the root, Tab must land on `first` and Shift+Tab on
  // `last` — both trapped inside the dialog.
  it('Shift+Tab from the focused root wraps to the last (no escape to背面)', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByTestId('dialog');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('last'));
  });

  it('Tab from the focused root moves into the first focusable (no escape to背面)', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByTestId('dialog');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });
});
