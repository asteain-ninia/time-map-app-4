// U20 React component tests: draggable panel move + front-most (FR-112,
// 受け入れ基準 5).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DraggablePanel } from './DraggablePanel';

describe('DraggablePanel (FR-112, 教訓 5.8)', () => {
  it('moves on header drag (press -> move -> release)', () => {
    render(
      <DraggablePanel id="p1" title="詳細" initialPosition={{ x: 100, y: 100 }} zIndex={1} />,
    );
    const panel = screen.getByTestId('panel-p1');
    const header = screen.getByTestId('panel-header-p1');

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 });
    expect(panel.style.left).toBe('150px');
    expect(panel.style.top).toBe('130px');

    fireEvent.pointerUp(window);
    // After release the position is retained (stateで保持) and drag ended.
    expect(panel.style.left).toBe('150px');
  });

  it('a press without movement (click-only path) ends cleanly', () => {
    render(
      <DraggablePanel id="p2" title="詳細" initialPosition={{ x: 10, y: 20 }} zIndex={1} />,
    );
    const header = screen.getByTestId('panel-header-p2');
    fireEvent.pointerDown(header, { clientX: 10, clientY: 20 });
    fireEvent.pointerUp(window);
    const panel = screen.getByTestId('panel-p2');
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('20px');
  });

  it('a press anywhere brings the panel to the front (前面化)', () => {
    const onFocusPanel = vi.fn();
    render(
      <DraggablePanel
        id="p3"
        title="詳細"
        initialPosition={{ x: 0, y: 0 }}
        zIndex={2}
        onFocusPanel={onFocusPanel}
      />,
    );
    fireEvent.pointerDown(screen.getByTestId('panel-p3'), { clientX: 0, clientY: 0 });
    expect(onFocusPanel).toHaveBeenCalledWith('p3');
  });

  it('applies the supplied z-index', () => {
    render(
      <DraggablePanel id="p4" title="詳細" initialPosition={{ x: 0, y: 0 }} zIndex={7} />,
    );
    expect(screen.getByTestId('panel-p4').style.zIndex).toBe('7');
  });

  it('close button invokes onClose with the id', () => {
    const onClose = vi.fn();
    render(
      <DraggablePanel
        id="p5"
        title="詳細"
        initialPosition={{ x: 0, y: 0 }}
        zIndex={1}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onClose).toHaveBeenCalledWith('p5');
  });
});
