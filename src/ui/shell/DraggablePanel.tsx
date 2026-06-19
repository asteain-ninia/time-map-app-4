// UI layer (U20 / shell): the draggable floating-panel container (FR-112).
//
// The "器" for modal detail panels / floating panels: a header drag handle, a
// body slot for later units' content, and bring-to-front on press (z-order.ts).
// Dragging is driven by the pure reducer via useDrag (教訓 5.8). The panel is an
// INPUT-CAPTURING front layer (教訓 5.14): pointer events on it do NOT reach the
// map input layer behind it; the layering is expressed via z-index + an overlay
// the caller can place. Content is provided by later units (spec スコープ).

import { type ReactNode } from 'react';

import { useDrag } from './useDrag';
import type { Point } from './drag';

export interface DraggablePanelProps {
  /** Stable id used for z-order / front-most tracking. */
  readonly id: string;
  readonly title: string;
  readonly initialPosition: Point;
  /** CSS z-index derived from the z-order model (front-most = highest). */
  readonly zIndex: number;
  /** Bring this panel to the front (called on header press). */
  readonly onFocusPanel?: (id: string) => void;
  readonly onClose?: (id: string) => void;
  readonly children?: ReactNode;
}

export function DraggablePanel(props: DraggablePanelProps): JSX.Element {
  const { id, title, initialPosition, zIndex, onFocusPanel, onClose, children } = props;
  const drag = useDrag(initialPosition);

  return (
    <div
      className="draggable-panel"
      data-testid={`panel-${id}`}
      data-panel-id={id}
      style={{
        position: 'absolute',
        left: drag.position.x,
        top: drag.position.y,
        zIndex,
      }}
      // A press anywhere on the panel brings it to the front (前面化, FR-112).
      onPointerDownCapture={() => onFocusPanel?.(id)}
    >
      <div
        className="draggable-panel__header"
        data-testid={`panel-header-${id}`}
        onPointerDown={(e) => drag.onPointerDown(e)}
      >
        <span className="draggable-panel__title">{title}</span>
        {onClose !== undefined && (
          <button
            type="button"
            className="draggable-panel__close"
            aria-label="閉じる"
            onClick={() => onClose(id)}
          >
            ×
          </button>
        )}
      </div>
      <div className="draggable-panel__body">{children}</div>
    </div>
  );
}
