// REGRESSION (bughunt: 追加(Add)/ナイフ(Knife)描画中は中ボタンパンとホイールズームが
// 効かない).
//
// ROOT CAUSE the fix closes: while an add is in its DrawingフェーズんThe controller
// mounts a full-surface input bridge ABOVE the map (教訓 5.14). It captured pointer
// events to place vertices, but it only handled onPointerDown / onPointerMove — it
// never forwarded the WHEEL or the MIDDLE-button pointer events to the live U40
// PointerDispatcher (whose DOM listeners are on the BACKGROUND map-input-layer, a
// sibling the overlay shadows). So during drawing 中ボタンパン / ホイールズーム died,
// even though the dispatcher's own unit tests (which call it directly, no overlay)
// stayed green. The dispatcher is now reached THROUGH an injected `mapCameraInput`
// port the bridge forwards the camera-only events to.
//
// This behavioural test mounts the REAL AddToolController with a SPY camera port,
// enters the drawing phase through the production component graph, and asserts the
// bridge forwards:
//   - a wheel notch → mapCameraInput.wheel (描画中のホイールズーム再生);
//   - a MIDDLE-button press/move/up → the mapCameraInput pointer path (中ボタンパン);
//   - a LEFT-button press is NOT forwarded to the camera (it stays the tool's own
//     vertex placement — forwarding never steals the tool input, 教訓 5.9).
//
// Runs in jsdom: the camera port is a spy, while the WIRING under test is the real
// component (the bridge's native wheel/pointer listeners), not a stand-in.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { createSessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { AppShell } from '../shell';
import type { MapCameraInput } from '../map/index';

import { AddToolController, type AddDrawSink, type ScreenToWorld } from './AddToolController';

type S = { tag: string };

const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

function mountWithCamera(): {
  readonly camera: {
    wheel: ReturnType<typeof vi.fn>;
    pointerDown: ReturnType<typeof vi.fn>;
    pointerMove: ReturnType<typeof vi.fn>;
    pointerUp: ReturnType<typeof vi.fn>;
    pointerCancel: ReturnType<typeof vi.fn>;
  };
} {
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: {
      mode: EDIT_MODE.Add,
      currentTime: timePointYearMonthDay(1500, 6, 20),
    },
  });
  const drawSink: AddDrawSink = { drawAdd: () => {} };
  const camera = {
    wheel: vi.fn(),
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    pointerCancel: vi.fn(),
  };
  const mapCameraInput: MapCameraInput = camera;

  let f = 0;
  let v = 0;
  let r = 0;
  render(
    <AppShell
      store={store}
      overlay={
        <AddToolController<S>
          store={store}
          startProcess={() => {
            throw new Error('not used in this test');
          }}
          ids={{
            nextFeatureId: () => asFeatureId(`f${++f}`),
            nextVertexId: () => asVertexId(`v${++v}`),
          }}
          nextRingId={() => asRingId(`r${++r}`)}
          screenToWorld={screenToWorld}
          drawSink={drawSink}
          mapCameraInput={mapCameraInput}
          onCommitted={() => {}}
        />
      }
    />,
  );
  // Enter the drawing phase: selecting the line tool starts a session and shows the
  // input bridge (the same导线 the integration test uses).
  act(() => fireEvent.click(screen.getByTestId('tool-add.line')));
  return { camera };
}

describe('bughunt regression: 追加描画中も中ボタンパン/ホイールズームが効く', () => {
  it('forwards a wheel notch over the drawing bridge to the camera (ホイールズーム)', () => {
    const { camera } = mountWithCamera();
    const bridge = screen.getByTestId('add-input-layer');

    act(() => {
      fireEvent.wheel(bridge, { clientX: 40, clientY: 30, deltaY: -120, deltaMode: 0 });
    });

    expect(camera.wheel).toHaveBeenCalledTimes(1);
    expect(camera.wheel).toHaveBeenCalledWith(40, 30, -120, 0);
  });

  it('forwards a MIDDLE-button drag over the bridge to the camera pan path (中ボタンパン)', () => {
    const { camera } = mountWithCamera();
    const bridge = screen.getByTestId('add-input-layer');

    act(() => {
      fireEvent.pointerDown(bridge, { clientX: 10, clientY: 10, button: 1, buttons: 4, pointerId: 7 });
      fireEvent.pointerMove(bridge, { clientX: 60, clientY: 40, buttons: 4, pointerId: 7 });
      fireEvent.pointerUp(bridge, { clientX: 60, clientY: 40, button: 1, pointerId: 7 });
    });

    expect(camera.pointerDown).toHaveBeenCalledTimes(1);
    expect(camera.pointerMove).toHaveBeenCalledTimes(1);
    expect(camera.pointerUp).toHaveBeenCalledTimes(1);
  });

  it('does NOT forward a LEFT-button press to the camera (it stays vertex placement)', () => {
    const { camera } = mountWithCamera();
    const bridge = screen.getByTestId('add-input-layer');

    act(() => {
      fireEvent.pointerDown(bridge, { clientX: 5, clientY: 5, button: 0, buttons: 1, pointerId: 3 });
    });

    // The left press places a vertex (the tool), not a camera pan — the camera port
    // is left untouched so the two input surfaces can never both act on one press.
    expect(camera.pointerDown).not.toHaveBeenCalled();
    // And the vertex actually landed (the tool still owns left-button input).
    expect(screen.getByTestId('add-vertex-count')).toHaveTextContent('1');
  });
});
