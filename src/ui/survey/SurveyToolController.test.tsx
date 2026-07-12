// U37 — SurveyToolController integration test (FR-14 / FR-15 / FR-16 結線).
//
// The pure survey domain (state machine / measure / great-circle) and the
// render-batch builder are covered in isolation; THIS test verifies the
// layer-crossing wiring: the controller binds the session store's survey slice
// to the map input (click / drag / hover / wheel), the keyboard (Escape with the
// shared focus-guard), the persistent survey draw sink (FR-15: confirmed lines
// keep drawing after survey OFF), and the reset契約 rows the CONTROLLER owns
// (仕様書 §7): edit-tool select → surveyDisable (lines kept), mode switch →
// surveyCancelDraft (draft only). Runs in jsdom over the REAL component graph
// with a fake screen→world transform and draw sink.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import type { DrawPrimitive } from '../../render/map-renderer';
import type { MapCameraInput } from '../map/index';
import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE, asToolId, type EditMode } from '../state/session';

import {
  SurveyToolController,
  SurveyMapBridge,
  SURVEY_CLICK_MOVE_THRESHOLD_PX,
  type SurveyDrawSink,
} from './SurveyToolController';

interface S {
  readonly tag: string;
}

// Identity transform: a pointer at (clientX, clientY) is world (lon=x, lat=y).
const screenToWorld = (clientX: number, clientY: number) => ({
  lon: clientX,
  lat: clientY,
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly batches: (readonly DrawPrimitive[])[];
  readonly cameraInput: MapCameraInput & {
    wheelCalls: number;
    downCalls: number;
  };
  readonly onDrawingChange: ReturnType<typeof vi.fn>;
  readonly unmount: () => void;
}

function mountSurvey(initialMode: EditMode = EDIT_MODE.View): Harness {
  const store = createSessionStore<S>({
    initialDomain: { tag: 'd0' },
    initial: { mode: initialMode },
  });
  const batches: (readonly DrawPrimitive[])[] = [];
  const drawSink: SurveyDrawSink = {
    drawSurvey(primitives) {
      batches.push(primitives);
    },
  };
  const cameraInput: Harness['cameraInput'] = {
    wheelCalls: 0,
    downCalls: 0,
    wheel() {
      this.wheelCalls += 1;
    },
    pointerDown() {
      this.downCalls += 1;
    },
    pointerMove() {},
    pointerUp() {},
    pointerCancel() {},
  };
  const onDrawingChange = vi.fn();
  // The production pair: the headless controller (shell overlay) + the map-cell
  // input bridge (AppShell.mapOverlay) — mounted together as App.tsx does.
  const utils = render(
    <>
      <SurveyToolController
        store={store}
        drawSink={drawSink}
        onDrawingChange={onDrawingChange}
      />
      <SurveyMapBridge
        store={store}
        screenToWorld={screenToWorld}
        mapCameraInput={cameraInput}
      />
    </>,
  );
  return { store, batches, cameraInput, onDrawingChange, unmount: utils.unmount };
}

function layer(): HTMLElement {
  return screen.getByTestId('survey-input-layer');
}

/** A genuine click: down + up at the same position (below the drag threshold). */
function clickAt(x: number, y: number, pointerId = 1): void {
  fireEvent.pointerDown(layer(), { clientX: x, clientY: y, button: 0, pointerId });
  fireEvent.pointerUp(layer(), { clientX: x, clientY: y, button: 0, pointerId });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SurveyToolController — input bridge lifecycle (別軸トグル)', () => {
  it('mounts the map input bridge ONLY while survey mode is active', () => {
    const h = mountSurvey();
    expect(screen.queryByTestId('survey-input-layer')).toBeNull();

    act(() => h.store.getState().surveyEnable());
    expect(screen.getByTestId('survey-input-layer')).toBeInTheDocument();

    act(() => h.store.getState().surveyDisable());
    expect(screen.queryByTestId('survey-input-layer')).toBeNull();
    h.unmount();
  });
});

describe('SurveyToolController — click / drag discrimination (教訓 5.8)', () => {
  it('a click (press+release in place) places the start, a second click confirms a line', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    act(() => clickAt(100, 50));
    let s = h.store.getState().survey;
    expect(s.draft?.start).toEqual({ lon: 100, lat: 50 });
    expect(s.lines).toHaveLength(0);

    act(() => clickAt(200, 80));
    s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({
      start: { lon: 100, lat: 50 },
      end: { lon: 200, lat: 80 },
    });
    h.unmount();
  });

  it('a drag (movement ≥ threshold) confirms NOTHING (pan gesture, not a click)', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    const dx = SURVEY_CLICK_MOVE_THRESHOLD_PX + 10;
    act(() => {
      fireEvent.pointerDown(layer(), { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(layer(), { clientX: 100 + dx, clientY: 50, pointerId: 1 });
      fireEvent.pointerUp(layer(), { clientX: 100 + dx, clientY: 50, button: 0, pointerId: 1 });
    });

    const s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(0);
    h.unmount();
  });
});

describe('SurveyToolController — hover preview (NFR 5.1 rAF 結合)', () => {
  it('coalesces N pointermoves in one frame into ONE hover update (the LAST point wins)', () => {
    // Deterministic rAF: collect callbacks, run them manually.
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    act(() => clickAt(0, 0));

    let hoverSets = 0;
    const unsub = h.store.subscribe(() => {
      hoverSets += 1;
    });
    act(() => {
      fireEvent.pointerMove(layer(), { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(layer(), { clientX: 20, clientY: 30, pointerId: 1 });
    });
    // Nothing flushed yet — the two moves scheduled ONE frame.
    expect(hoverSets).toBe(0);
    expect(frames).toHaveLength(1);

    act(() => frames[0]!(16));
    expect(hoverSets).toBe(1);
    expect(h.store.getState().survey.draft?.hover).toEqual({ lon: 20, lat: 30 });
    unsub();
    h.unmount();
  });

  it('a pointermove with NO draft never writes a hover', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    const before = h.store.getState().survey;
    act(() => {
      fireEvent.pointerMove(layer(), { clientX: 10, clientY: 10, pointerId: 1 });
    });
    expect(h.store.getState().survey).toBe(before);
    h.unmount();
  });
});

describe('SurveyToolController — camera passthrough (wheel / 非左ボタン)', () => {
  it('forwards wheel + middle-button presses to mapCameraInput; the LEFT button is consumed', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    fireEvent.wheel(layer(), { clientX: 10, clientY: 20, deltaY: 120, deltaMode: 0 });
    expect(h.cameraInput.wheelCalls).toBe(1);

    fireEvent.pointerDown(layer(), { clientX: 10, clientY: 20, button: 1, pointerId: 2 });
    expect(h.cameraInput.downCalls).toBe(1);

    // A LEFT press is survey input — never forwarded as a camera press.
    fireEvent.pointerDown(layer(), { clientX: 10, clientY: 20, button: 0, pointerId: 3 });
    expect(h.cameraInput.downCalls).toBe(1);
    h.unmount();
  });
});

describe('SurveyToolController — Escape (U37 §4.2 + focus-guard)', () => {
  it('Escape discards the DRAFT only; confirmed lines and active survive', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    act(() => {
      clickAt(0, 0);
      clickAt(10, 10);
      clickAt(20, 20); // second draft in progress
    });

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    const s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1);
    expect(s.active).toBe(true);
    h.unmount();
  });

  it('Escape over a text-editing target passes through (focus-guard 再利用)', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    act(() => clickAt(0, 0));

    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    // The draft is untouched — the field owned the keyboard.
    expect(h.store.getState().survey.draft).not.toBeNull();
    input.remove();
    h.unmount();
  });
});

describe('SurveyToolController — reset契約 (仕様書 §7 controller-owned rows)', () => {
  it('arming an edit tool while survey is ON disables survey (draft 破棄・確定線 保持)', () => {
    const h = mountSurvey(EDIT_MODE.Edit);
    act(() => h.store.getState().surveyEnable());
    act(() => {
      clickAt(0, 0);
      clickAt(10, 10);
      clickAt(20, 20); // draft
    });

    act(() => h.store.getState().setActiveTool(asToolId('edit.knife')));

    const s = h.store.getState().survey;
    expect(s.active).toBe(false);
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1); // FR-15: lines persist through the disable
    // The bridge unmounted — the edit tool's bridge is the only input layer now.
    expect(screen.queryByTestId('survey-input-layer')).toBeNull();
    h.unmount();
  });

  it('a mode switch cancels the DRAFT only (active + 確定線 保持)', () => {
    const h = mountSurvey(EDIT_MODE.View);
    act(() => h.store.getState().surveyEnable());
    act(() => {
      clickAt(0, 0);
      clickAt(10, 10);
      clickAt(20, 20); // draft
    });

    act(() => h.store.getState().setMode(EDIT_MODE.Add));

    const s = h.store.getState().survey;
    expect(s.active).toBe(true);
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(1);
    h.unmount();
  });
});

describe('SurveyToolController — persistent draw sink (FR-15)', () => {
  it('pushes a batch on every survey change and STILL draws confirmed lines after OFF; clear empties', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    act(() => {
      clickAt(0, 0);
      clickAt(10, 10);
    });

    const confirmed = h.batches[h.batches.length - 1]!;
    // One confirmed line = equirectangular + great-circle lines + 2 markers.
    expect(confirmed.filter((p) => p.kind === 'line')).toHaveLength(2);
    expect(confirmed.filter((p) => p.kind === 'point')).toHaveLength(2);

    // Survey OFF: the controller stays mounted and keeps drawing the lines.
    act(() => h.store.getState().surveyDisable());
    const afterOff = h.batches[h.batches.length - 1]!;
    expect(afterOff.filter((p) => p.kind === 'line')).toHaveLength(2);
    expect(afterOff.filter((p) => p.kind === 'point')).toHaveLength(2);

    // Clear: an EMPTY batch is pushed (the layer clears, 教訓 5.18).
    act(() => h.store.getState().surveyClear());
    expect(h.batches[h.batches.length - 1]).toHaveLength(0);
    h.unmount();
  });
});

describe('SurveyToolController — onDrawingChange (shortcut suspend 境界)', () => {
  it('fires true when a draft starts and false when it ends', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    expect(h.onDrawingChange).toHaveBeenLastCalledWith(false);

    act(() => clickAt(0, 0));
    expect(h.onDrawingChange).toHaveBeenLastCalledWith(true);

    act(() => clickAt(10, 10)); // confirm → draft gone
    expect(h.onDrawingChange).toHaveBeenLastCalledWith(false);
    h.unmount();
  });
});
