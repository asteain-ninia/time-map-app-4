// U40 PointerDispatcher — press→move→release sequences, teardown, wheel
// (受け入れ基準 2 / 4 / 5 / 6 / 8).

import { describe, it, expect, beforeEach } from 'vitest';

import {
  PointerDispatcher,
  buttonFromButtonsMask,
  type NormalizedPointer,
} from './PointerDispatcher';
import { DISPATCH_TARGET, POINTER_BUTTON, type PointerButton } from './dispatch';
import { NO_MODIFIERS, type PointerModifiers, type SelectionPort } from './ports';
import {
  EMPTY_HIT,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { EDIT_MODE, type EditMode } from '../state/session';
import type { Camera, ScreenPoint, Viewport } from '../../render';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

// --- Fakes for the four ports ----------------------------------------------

class FakeCamera {
  camera: Camera = { centerLon: 0, centerLat: 0, zoom: 4 };
  writes: Camera[] = [];
  read() {
    return { camera: this.camera, viewport: VIEWPORT };
  }
  write(c: Camera) {
    this.camera = c;
    this.writes.push(c);
  }
}

class FakeSelection implements SelectionPort {
  events: string[] = [];
  start(hit: HitResult) {
    this.events.push(`start:${hit.kind}`);
  }
  move() {
    this.events.push('move');
  }
  end(point: ScreenPoint, wasDrag: boolean) {
    this.events.push(`end:${wasDrag ? 'drag' : 'click'}@${point.x},${point.y}`);
  }
  cancel() {
    this.events.push('cancel');
  }
}

class FakeAdd {
  presses = 0;
  press() {
    this.presses += 1;
  }
}

class FakeContextMenu {
  requests = 0;
  request() {
    this.requests += 1;
  }
}

function setup(mode: EditMode, hit: HitResult = EMPTY_HIT) {
  const camera = new FakeCamera();
  const selection = new FakeSelection();
  const add = new FakeAdd();
  const contextMenu = new FakeContextMenu();
  const dispatcher = new PointerDispatcher({
    getMode: () => mode,
    camera,
    hitTester: { hitTest: () => hit },
    selection,
    add,
    contextMenu,
  });
  return { camera, selection, add, contextMenu, dispatcher };
}

function ptr(
  pointerId: number,
  x: number,
  y: number,
  button: PointerButton,
  modifiers: PointerModifiers = NO_MODIFIERS,
): NormalizedPointer {
  return { pointerId, x, y, button, modifiers };
}

describe('pan sequence (受け入れ基準 4)', () => {
  it('press→drag→release: camera moves, transient cleared', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    expect(dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.Pan,
    );
    expect(dispatcher.isPanning).toBe(true);
    dispatcher.pointerMove(ptr(1, 440, 300, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 440, 300, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBeGreaterThan(0);
    // +40px right at zoom 4 = +10° world; center moves -10°.
    expect(camera.camera.centerLon).toBeCloseTo(-10, 6);
    expect(dispatcher.isPanning).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
  });

  it('press→release with NO move (click): camera unchanged, transient cleared', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 400, 300, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBe(0); // 教訓 5.8: a pure click moves nothing.
    expect(dispatcher.activeCount).toBe(0);
  });

  it('sub-threshold wiggle stays a click (camera still)', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 402, 301, POINTER_BUTTON.Left)); // ~2.2px < 4
    dispatcher.pointerUp(ptr(1, 402, 301, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBe(0);
  });

  it('middle-button pans in EVERY mode', () => {
    for (const mode of [EDIT_MODE.View, EDIT_MODE.Add, EDIT_MODE.Edit] as const) {
      const { camera, dispatcher } = setup(mode);
      dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle));
      dispatcher.pointerMove(ptr(1, 480, 300, POINTER_BUTTON.Middle));
      dispatcher.pointerUp(ptr(1, 480, 300, POINTER_BUTTON.Middle));
      expect(camera.writes.length).toBeGreaterThan(0);
    }
  });
});

describe('select/edit delegation (受け入れ基準 5)', () => {
  it('edit-mode left press→move→release forwards to U22, never pans', () => {
    const hit = vertexHit(asFeatureId('f1'), asVertexId('v1'));
    const { camera, selection, dispatcher } = setup(EDIT_MODE.Edit, hit);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    dispatcher.pointerMove(ptr(1, 140, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 140, 100, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:vertex', 'move', 'end:drag@140,100']);
    expect(camera.writes.length).toBe(0); // never pans
    expect(dispatcher.isPanning).toBe(false);
  });

  it('edit-mode left click (no move) still ends as a click (教訓 5.8)', () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:empty', 'end:click@100,100']);
  });

  it('add-mode left press fires the add operation, never pans', () => {
    const { camera, add, dispatcher } = setup(EDIT_MODE.Add);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.Add,
    );
    expect(add.presses).toBe(1);
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBe(0);
  });

  it('right button requests the context menu, starts no tracked sequence', () => {
    const { contextMenu, dispatcher } = setup(EDIT_MODE.Edit);
    expect(dispatcher.pointerDown(ptr(1, 50, 50, POINTER_BUTTON.Right))).toBe(
      DISPATCH_TARGET.ContextMenu,
    );
    expect(contextMenu.requests).toBe(1);
    expect(dispatcher.activeCount).toBe(0);
  });
});

describe('全経路破棄 of transient state (受け入れ基準 6, 教訓 5.2)', () => {
  it('pointercancel drops the pan transient WITHOUT a final move', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 440, 300, POINTER_BUTTON.Left));
    const writesBefore = camera.writes.length;
    dispatcher.pointerCancel(1);
    expect(dispatcher.activeCount).toBe(0);
    expect(camera.writes.length).toBe(writesBefore); // no extra write on cancel
  });

  it('pointercancel forwards U22 cancel for an edit interaction', () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerCancel(1);
    expect(selection.events).toContain('cancel');
    expect(dispatcher.activeCount).toBe(0);
  });

  it('pointerleave aborts every live pointer', () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerLeave();
    expect(dispatcher.activeCount).toBe(0);
    expect(selection.events).toContain('cancel');
  });

  it('mode change aborts an in-progress pan (no leak into next op)', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left));
    expect(dispatcher.isPanning).toBe(true);
    dispatcher.onModeChange();
    expect(dispatcher.isPanning).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
  });

  it('start→cancel→re-start does not inherit stale transient', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 600, 300, POINTER_BUTTON.Left));
    dispatcher.pointerCancel(1);
    // The first drag committed live writes; the cancel did NOT roll them back and
    // did NOT add a final move (受け入れ基準 6). The new pan captures a FRESH
    // reference from the current camera at THIS press — it does not inherit the
    // first pan's reference.
    const baseAtSecondPress = camera.camera.centerLon;
    camera.writes = [];
    dispatcher.pointerDown(ptr(2, 400, 300, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(2, 440, 300, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(2, 440, 300, POINTER_BUTTON.Left));
    // +40px right = +10° world ⇒ center -10° relative to the fresh base only.
    const last = camera.writes[camera.writes.length - 1]!;
    expect(last.centerLon - baseAtSecondPress).toBeCloseTo(-10, 6);
  });
});

describe('multi-pointer tracking (受け入れ基準 3 末項)', () => {
  it('two pointers track independently by pointerId', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerDown(ptr(2, 200, 200, POINTER_BUTTON.Middle));
    expect(dispatcher.activeCount).toBe(2);
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(dispatcher.activeCount).toBe(1);
    dispatcher.pointerUp(ptr(2, 200, 200, POINTER_BUTTON.Middle));
    expect(dispatcher.activeCount).toBe(0);
  });
});

describe('multi-pointer select/edit gate (Codex multi-pointer finding, 教訓 5.2 / 5.9)', () => {
  // The SelectionPort / EditSessionPort each hold ONE press/session transient and
  // take no pointerId. A second simultaneous edit-mode left press must NOT start a
  // second select/edit gesture (which would overwrite the first's transient and let
  // either pointer's up/cancel consume the wrong one). It is ignored at the source.
  it('a second simultaneous edit-mode left press is ignored (no second start)', () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    // Second finger / device presses while the first select/edit is live.
    expect(dispatcher.pointerDown(ptr(2, 200, 200, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.Ignore,
    );
    // Only ONE select/edit start happened; the second pointer is not tracked.
    expect(selection.events).toEqual(['start:empty']);
    expect(dispatcher.activeCount).toBe(1);
  });

  it("the second pointer's release/cancel cannot finalize the first's selection", () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left)); // first gesture
    dispatcher.pointerDown(ptr(2, 200, 200, POINTER_BUTTON.Left)); // ignored
    // Releasing the (untracked) second pointer must be a no-op: it does not touch
    // the shared selection transient, so no spurious end/cancel is emitted.
    dispatcher.pointerUp(ptr(2, 200, 200, POINTER_BUTTON.Left));
    dispatcher.pointerCancel(2);
    expect(selection.events).toEqual(['start:empty']); // still only the first start
    expect(dispatcher.activeCount).toBe(1); // the first gesture is still live
    // The FIRST pointer's own release finalizes its own gesture exactly once.
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:empty', 'end:click@100,100']);
    expect(dispatcher.activeCount).toBe(0);
  });

  it('after the first select/edit ends, a fresh edit press is accepted again', () => {
    const { selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    // The gate is released once the gesture finishes; a later press is not blocked.
    expect(dispatcher.pointerDown(ptr(2, 300, 300, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    expect(selection.events).toEqual([
      'start:empty',
      'end:click@100,100',
      'start:empty',
    ]);
  });

  it('a concurrent middle-button pan is NOT blocked by an active select/edit', () => {
    const { camera, selection, dispatcher } = setup(EDIT_MODE.Edit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left)); // select/edit
    // A second pointer panning (middle) coexists — pan is per-pointer, never shares
    // the selection transient, so it is allowed alongside the live select/edit.
    expect(dispatcher.pointerDown(ptr(2, 400, 300, POINTER_BUTTON.Middle))).toBe(
      DISPATCH_TARGET.Pan,
    );
    dispatcher.pointerMove(ptr(2, 480, 300, POINTER_BUTTON.Middle));
    dispatcher.pointerUp(ptr(2, 480, 300, POINTER_BUTTON.Middle));
    expect(camera.writes.length).toBeGreaterThan(0);
    expect(selection.events).toEqual(['start:empty']); // first gesture untouched
    expect(dispatcher.activeCount).toBe(1);
  });
});

describe('wheel → U17 cursor-anchored zoom (受け入れ基準 2)', () => {
  it('scroll up zooms IN; the cursor world point stays under the cursor', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    const before = camera.camera.zoom;
    dispatcher.wheel({ x: 200, y: 150, deltaY: -100 });
    expect(camera.writes.length).toBe(1);
    expect(camera.camera.zoom).toBeGreaterThan(before);
  });

  it('scroll down zooms OUT', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    const before = camera.camera.zoom;
    dispatcher.wheel({ x: 200, y: 150, deltaY: 100 });
    expect(camera.camera.zoom).toBeLessThan(before);
  });

  it('wheel works in every mode (全モード共通)', () => {
    for (const mode of [EDIT_MODE.View, EDIT_MODE.Add, EDIT_MODE.Edit] as const) {
      const { camera, dispatcher } = setup(mode);
      dispatcher.wheel({ x: 100, y: 100, deltaY: -100 });
      expect(camera.writes.length).toBe(1);
    }
  });

  it('deltaY === 0 is a no-op (never zooms out, Codex medium #5)', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    const before = camera.camera.zoom;
    dispatcher.wheel({ x: 200, y: 150, deltaY: 0 });
    expect(camera.writes.length).toBe(0);
    expect(camera.camera.zoom).toBe(before);
  });

  it('a smaller delta zooms LESS than a full notch (magnitude-scaled)', () => {
    const big = setup(EDIT_MODE.View);
    const small = setup(EDIT_MODE.View);
    const start = big.camera.camera.zoom;
    big.dispatcher.wheel({ x: 200, y: 150, deltaY: -100 });
    small.dispatcher.wheel({ x: 200, y: 150, deltaY: -10 });
    // Both zoom in, but the 10px delta moves zoom less than the 100px notch.
    expect(small.camera.camera.zoom).toBeGreaterThan(start);
    expect(small.camera.camera.zoom).toBeLessThan(big.camera.camera.zoom);
  });

  it('deltaMode line (1) is normalized to a comparable pixel magnitude', () => {
    const px = setup(EDIT_MODE.View);
    const line = setup(EDIT_MODE.View);
    // 100px and ~6.25 lines (×16px) should land at a comparable zoom, NOT wildly
    // different — without normalization a deltaY of 100 "lines" would be enormous.
    px.dispatcher.wheel({ x: 200, y: 150, deltaY: -100, deltaMode: 0 });
    line.dispatcher.wheel({ x: 200, y: 150, deltaY: -100 / 16, deltaMode: 1 });
    expect(line.camera.camera.zoom).toBeCloseTo(px.camera.camera.zoom, 5);
  });

  // HB-1 / Codex finding #2: the LIVE getZoomRange clamp must reach the wheel path
  // (a project-setting change / fit-world floor), and take precedence over the
  // static option, so the wheel never zooms past the effective range.
  it('getZoomRange clamps the wheel zoom against the LIVE range', () => {
    const camera = new FakeCamera();
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.View,
      camera,
      hitTester: { hitTest: () => EMPTY_HIT },
      selection: new FakeSelection(),
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
      // A tight live max BELOW the start zoom (4): any zoom-in is clamped to 5,
      // proving the live range reached zoomStepAtCursor.
      getZoomRange: () => ({ minZoom: 1, maxZoom: 5 }),
    });
    // Many strong zoom-IN notches; without the clamp the zoom would exceed 5.
    for (let i = 0; i < 20; i += 1) dispatcher.wheel({ x: 200, y: 150, deltaY: -100 });
    expect(camera.camera.zoom).toBeLessThanOrEqual(5);
    expect(camera.camera.zoom).toBeCloseTo(5, 6);
  });

  it('getZoomRange (live) takes precedence over the static zoomRange option', () => {
    const camera = new FakeCamera();
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.View,
      camera,
      hitTester: { hitTest: () => EMPTY_HIT },
      selection: new FakeSelection(),
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
      // The static range would allow zooming to 50, but the LIVE getter caps at 5.
      zoomRange: { minZoom: 1, maxZoom: 50 },
      getZoomRange: () => ({ minZoom: 1, maxZoom: 5 }),
    });
    for (let i = 0; i < 20; i += 1) dispatcher.wheel({ x: 200, y: 150, deltaY: -100 });
    expect(camera.camera.zoom).toBeCloseTo(5, 6);
  });
});

describe('buttonFromButtonsMask', () => {
  it('extracts the held button from the buttons bitmask', () => {
    expect(buttonFromButtonsMask(1)).toBe(0); // left
    expect(buttonFromButtonsMask(4)).toBe(1); // middle
    expect(buttonFromButtonsMask(2)).toBe(2); // right
    expect(buttonFromButtonsMask(0)).toBe(-1); // none
  });
});

describe('PointerDispatcher.normalize', () => {
  let evt: Pick<
    PointerEvent,
    'pointerId' | 'button' | 'buttons' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
  >;
  beforeEach(() => {
    evt = {
      pointerId: 7,
      button: 1,
      buttons: 4,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };
  });
  it('down uses the changed `button`; carries modifiers', () => {
    const n = PointerDispatcher.normalize(evt, 12, 34);
    expect(n).toMatchObject({
      pointerId: 7,
      x: 12,
      y: 34,
      button: POINTER_BUTTON.Middle,
    });
    expect(n.modifiers.shift).toBe(true);
  });
  it('move derives the held button from `buttons`', () => {
    const moveEvt = { ...evt, button: -1, buttons: 1 };
    const n = PointerDispatcher.normalize(moveEvt, 0, 0, true);
    expect(n.button).toBe(POINTER_BUTTON.Left);
  });
});
