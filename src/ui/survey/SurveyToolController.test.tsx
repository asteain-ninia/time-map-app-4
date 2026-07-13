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
import {
  EMPTY_HIT_TESTER,
  NOOP_ADD_PORT,
  NOOP_CONTEXT_MENU_PORT,
  NOOP_SELECTION_PORT,
  POINTER_BUTTON,
  PointerDispatcher,
  type MapCameraInput,
} from '../map/index';
import type { Camera, Viewport } from '../../render';
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
    beginPanCalls: { pressX: number; pressY: number; pointerId: number }[];
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
    beginPanCalls: [],
    wheel() {
      this.wheelCalls += 1;
    },
    pointerDown() {
      this.downCalls += 1;
    },
    pointerMove() {},
    pointerUp() {},
    pointerCancel() {},
    beginPan(e, pressClientX, pressClientY) {
      this.beginPanCalls.push({
        pressX: pressClientX,
        pressY: pressClientY,
        pointerId: e.pointerId,
      });
    },
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

  // survey F1 (Codex HIGH) — a threshold-exceeded LEFT drag is DELEGATED to the
  // camera as a pan (mapCameraInput.beginPan, anchored at the PRESS point), exactly
  // once, and the consumed press can never also confirm a click. Before the fix the
  // gesture was a dead zone: the click was suppressed AND no pan ever started.
  it('閾値超えの左ドラッグは beginPan へ 1 回だけ委譲され、クリック確定しない (F1)', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    const dx = SURVEY_CLICK_MOVE_THRESHOLD_PX + 10;
    act(() => {
      fireEvent.pointerDown(layer(), { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(layer(), { clientX: 100 + dx, clientY: 50, pointerId: 1 });
      // Further movement must NOT re-delegate (the press candidate was consumed).
      fireEvent.pointerMove(layer(), { clientX: 100 + dx * 2, clientY: 50, pointerId: 1 });
      fireEvent.pointerUp(layer(), { clientX: 100 + dx * 2, clientY: 50, button: 0, pointerId: 1 });
    });

    // Delegated ONCE, anchored at the ORIGINAL press position (catch-up pan).
    // (jsdom does not thread pointerId through fireEvent, so only the anchor is
    // asserted here; the id-matching guard is covered by the pointerId-mismatch
    // no-op semantics of the press candidate itself.)
    expect(h.cameraInput.beginPanCalls).toHaveLength(1);
    expect(h.cameraInput.beginPanCalls[0]).toMatchObject({ pressX: 100, pressY: 50 });
    // No click was confirmed by the drag.
    const s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(0);

    // A subsequent genuine click still measures (the delegation left no residue).
    act(() => clickAt(10, 20));
    expect(h.store.getState().survey.draft?.start).toEqual({ lon: 10, lat: 20 });
    expect(h.cameraInput.beginPanCalls).toHaveLength(1);
    h.unmount();
  });

  it('閾値未満の移動では beginPan は呼ばれずクリックが確定する (F1 対照)', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    const dx = SURVEY_CLICK_MOVE_THRESHOLD_PX - 1;
    act(() => {
      fireEvent.pointerDown(layer(), { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(layer(), { clientX: 100 + dx, clientY: 50, pointerId: 1 });
      fireEvent.pointerUp(layer(), { clientX: 100 + dx, clientY: 50, button: 0, pointerId: 1 });
    });

    expect(h.cameraInput.beginPanCalls).toHaveLength(0);
    // The click confirmed at the PRESS point (クリックした場所＝測った場所).
    expect(h.store.getState().survey.draft?.start).toEqual({ lon: 100, lat: 50 });
    h.unmount();
  });

  // survey F3 (Codex MED) — a pointer that LEAVES the bridge abandons its press
  // candidate: 端で押下→離脱→再進入→元の押下位置近くで解放 must NOT confirm a
  // stale click (the underlying map-input-layer applies the same leave rule).
  it('pointerleave は press 候補を破棄する — 再進入後の解放はクリック確定しない (F3)', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());

    act(() => {
      fireEvent.pointerDown(layer(), { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
      fireEvent.pointerLeave(layer(), { pointerId: 1 });
      // Re-enter and release right at the original press position.
      fireEvent.pointerUp(layer(), { clientX: 101, clientY: 50, button: 0, pointerId: 1 });
    });

    const s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(0);
    h.unmount();
  });
});

// Codex F2 (survey 単発ムーブの空振り) — the threshold-crossing move itself must
// already PAN: the bridge delegates (beginPan) BEFORE forwarding the move, so a
// down → ONE big move → up gesture moves the camera. Locked against a REAL
// PointerDispatcher + camera port (the same machinery App wires), because a
// call-order regression is invisible to a call-counting fake.
describe('SurveyToolController — 単発ムーブのパン (Codex F2, real dispatcher)', () => {
  function mountRealPanSurvey(): {
    store: StoreApi<SessionStore<S>>;
    center: () => { lon: number; lat: number };
    unmount: () => void;
  } {
    let camera: Camera = { centerLon: 0, centerLat: 0, zoom: 2 };
    const viewport: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.View,
      camera: {
        read: () => ({ camera, viewport }),
        write: (c) => {
          camera = c;
        },
      },
      hitTester: EMPTY_HIT_TESTER,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: NOOP_CONTEXT_MENU_PORT,
    });
    // The App's MapCameraInput wiring, with an identity client→surface transform
    // (the test has no real map rect): beginPan re-tags the sample as MIDDLE so the
    // dispatcher's PAN_BUTTONS table starts a pan in every mode (App.tsx と同型).
    const cameraInput: MapCameraInput = {
      wheel: (x, y, deltaY, deltaMode) => dispatcher.wheel({ x, y, deltaY, deltaMode }),
      pointerDown: (e, x, y) => {
        if (e.button === 0) return;
        dispatcher.pointerDown(PointerDispatcher.normalize(e, x, y));
      },
      pointerMove: (e, x, y) =>
        dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true)),
      pointerUp: (e, x, y) => dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y)),
      pointerCancel: (pointerId) => dispatcher.pointerCancel(pointerId),
      beginPan: (e, pressX, pressY) => {
        dispatcher.pointerDown({
          ...PointerDispatcher.normalize(e, pressX, pressY),
          button: POINTER_BUTTON.Middle,
        });
      },
    };
    const store = createSessionStore<S>({
      initialDomain: { tag: 'd0' },
      initial: { mode: EDIT_MODE.View },
    });
    const utils = render(
      <>
        <SurveyToolController store={store} drawSink={{ drawSurvey() {} }} />
        <SurveyMapBridge
          store={store}
          screenToWorld={screenToWorld}
          mapCameraInput={cameraInput}
        />
      </>,
    );
    return {
      store,
      center: () => ({ lon: camera.centerLon, lat: camera.centerLat }),
      unmount: utils.unmount,
    };
  }

  it('down→単発 move(閾値超)→up でカメラが動く（跨いだムーブ自身が delta を適用）', () => {
    const h = mountRealPanSurvey();
    act(() => h.store.getState().surveyEnable());
    expect(h.center()).toEqual({ lon: 0, lat: 0 });

    act(() => {
      fireEvent.pointerDown(layer(), { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
      // ONE move, well past the threshold — no further moves before release.
      fireEvent.pointerMove(layer(), {
        clientX: 160,
        clientY: 50,
        pointerId: 1,
        buttons: 1,
      });
      fireEvent.pointerUp(layer(), { clientX: 160, clientY: 50, button: 0, pointerId: 1 });
    });

    // The camera panned by the press→current delta (60px / zoom 2 = 30° of lon;
    // direction is the pan math's own — only the magnitude is asserted here) and
    // no survey click was confirmed (教訓 5.8).
    expect(Math.abs(h.center().lon)).toBeCloseTo(30, 5);
    expect(h.center().lat).toBeCloseTo(0, 5);
    const s = h.store.getState().survey;
    expect(s.draft).toBeNull();
    expect(s.lines).toHaveLength(0);
    h.unmount();
  });
});

describe('SurveyToolController — native context menu suppression (F2, Codex MED)', () => {
  it('the bridge preventDefaults contextmenu so only the FR-96 custom menu shows', () => {
    const h = mountSurvey();
    act(() => h.store.getState().surveyEnable());
    // fireEvent returns FALSE when preventDefault was called on the event.
    const notPrevented = fireEvent.contextMenu(layer(), { clientX: 10, clientY: 20 });
    expect(notPrevented).toBe(false);
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
