// U40 PointerDispatcher — press→move→release sequences, teardown, wheel
// (受け入れ基準 2 / 4 / 5 / 6 / 8).

import { describe, it, expect, beforeEach } from 'vitest';

import {
  PointerDispatcher,
  buttonFromButtonsMask,
  type NormalizedPointer,
} from './PointerDispatcher';
import { DISPATCH_TARGET, POINTER_BUTTON, type PointerButton } from './dispatch';
import {
  NO_MODIFIERS,
  type PointerCaptureTarget,
  type PointerModifiers,
  type SelectionPort,
} from './ports';
import {
  EMPTY_HIT,
  featureBodyHit,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { EDIT_MODE, type EditMode } from '../state/session';
import { DEFAULT_ZOOM_RANGE, type Camera, type ScreenPoint, type Viewport } from '../../render';

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

/**
 * A fake DOM pointer-capture target that records set/release calls and tracks the
 * currently-captured pointer ids — so a test can assert the dispatcher RELEASES a
 * pan's capture on every teardown path (BUGHUNT2).
 */
class FakeCaptureTarget implements PointerCaptureTarget {
  readonly captured = new Set<number>();
  readonly calls: string[] = [];
  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
    this.calls.push(`set:${pointerId}`);
  }
  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
    this.calls.push(`release:${pointerId}`);
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

  it('読むだけの左クリック（動かさない）は選択になる（裁定 N-4(A)）', () => {
    // **左ドラッグはパンのまま**（読むだけの主要な操作を奪わない）。動かさずに離した
    // ときだけ選択として解決し直す。押した瞬間の行き先は Pan のままなので、
    // `decideDispatch` の表（`PAN_BUTTONS`）は 1 文字も変えていない。
    const hit = featureBodyHit(asFeatureId('f1'));
    const { camera, selection, dispatcher } = setup(EDIT_MODE.View, hit);
    expect(dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.Pan,
    );
    dispatcher.pointerUp(ptr(1, 200, 150, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:featureBody', 'end:click@200,150']);
    expect(camera.writes.length).toBe(0);
  });

  it('読むだけの左ドラッグはパンのまま（選択にはならない）', () => {
    const hit = featureBodyHit(asFeatureId('f1'));
    const { camera, selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 280, 150, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 280, 150, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBeGreaterThan(0);
    expect(selection.events).toEqual([]);
  });

  it('読むだけの中ボタンのクリックでは選択しない（左ボタンだけの約束）', () => {
    const hit = featureBodyHit(asFeatureId('f1'));
    const { selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Middle));
    dispatcher.pointerUp(ptr(1, 200, 150, POINTER_BUTTON.Middle));
    expect(selection.events).toEqual([]);
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

describe('pan pointer-capture lifecycle (BUGHUNT2 — 全経路で capture を解放)', () => {
  // ROOT of BUGHUNT2: a middle-button pan started through the tool-overlay input
  // bridge captures the pointer on the BRIDGE element. A mid-pan tool/mode switch
  // aborts the pan transient (onModeChange → abortAll) but FORMERLY left the DOM
  // capture in place — and the bridge element can UNMOUNT on that switch, so the
  // trailing pointerup had no captured element to land on. The dispatcher now owns
  // capture lifecycle: it captures on pan-start and RELEASES on every teardown path
  // (release / cancel / mode-change abort) BEFORE the element can unmount.

  it('captures on pan-start and releases on pointerUp', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    const cap = new FakeCaptureTarget();
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle), cap);
    expect(cap.captured.has(1)).toBe(true);
    dispatcher.pointerMove(ptr(1, 480, 300, POINTER_BUTTON.Middle));
    dispatcher.pointerUp(ptr(1, 480, 300, POINTER_BUTTON.Middle));
    expect(cap.captured.has(1)).toBe(false); // released, not left dangling
    expect(cap.calls).toEqual(['set:1', 'release:1']);
  });

  it('releases the capture on a mid-pan mode change (the reported repro)', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    const cap = new FakeCaptureTarget();
    // Start a middle-button pan through the (bridge) capture target...
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle), cap);
    dispatcher.pointerMove(ptr(1, 440, 300, POINTER_BUTTON.Middle));
    expect(cap.captured.has(1)).toBe(true);
    // ...then a tool/mode switch fires onModeChange WHILE the pointer is still held.
    dispatcher.onModeChange();
    // The transient is gone AND the DOM capture is released — so when the bridge
    // element unmounts on the switch it carries no dangling capture, and the trailing
    // pointerup is a safe no-op (the record is already gone).
    expect(dispatcher.isPanning).toBe(false);
    expect(dispatcher.activeCount).toBe(0);
    expect(cap.captured.has(1)).toBe(false);
    expect(cap.calls).toEqual(['set:1', 'release:1']);
  });

  it('releases the capture on pointercancel', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    const cap = new FakeCaptureTarget();
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle), cap);
    dispatcher.pointerCancel(1);
    expect(cap.captured.has(1)).toBe(false);
  });

  it('releases the capture on pointerleave (abort of every live pointer)', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    const cap = new FakeCaptureTarget();
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle), cap);
    dispatcher.pointerLeave();
    expect(cap.captured.has(1)).toBe(false);
  });

  it('a pan with NO capture target works and never touches capture', () => {
    // The dispatcher unit tests call pointerDown without a target; that path must
    // stay a no-op for capture (no throw, no spurious release on teardown).
    const { camera, dispatcher } = setup(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle));
    dispatcher.pointerMove(ptr(1, 480, 300, POINTER_BUTTON.Middle));
    expect(() => dispatcher.onModeChange()).not.toThrow();
    expect(camera.writes.length).toBeGreaterThan(0);
  });

  it('swallows a release that throws (capture already gone / element detached)', () => {
    const { dispatcher } = setup(EDIT_MODE.View);
    const throwing: PointerCaptureTarget = {
      setPointerCapture() {},
      releasePointerCapture() {
        throw new DOMException('InvalidPointerId');
      },
    };
    dispatcher.pointerDown(ptr(1, 400, 300, POINTER_BUTTON.Middle), throwing);
    // A throw from the browser's releasePointerCapture must not break teardown.
    expect(() => dispatcher.onModeChange()).not.toThrow();
    expect(dispatcher.activeCount).toBe(0);
  });

  it('does NOT capture for a non-pan press (edit-mode left selection)', () => {
    const { dispatcher } = setup(EDIT_MODE.Edit);
    const cap = new FakeCaptureTarget();
    // A capture target is offered, but the press resolves to SelectEdit, not Pan,
    // so no capture is taken (capture is a pan-only concern).
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left), cap)).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    expect(cap.calls).toEqual([]);
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

  // Bughunt REGRESSION: a deltaMode=2 (page, ×800) event with a large deltaY is a
  // zoom-IN gesture, but `wheelFactor ** (-normalizedPx / NOTCH)` overflowed the
  // factor to +Infinity → `camera.zoom * factor === +∞` → clampZoom (formerly)
  // mapped +∞ to the LOWER bound, snapping the map to MINIMUM zoom — direction
  // REVERSED. The fix saturates the per-event notch count so the factor stays
  // finite, and clampZoom resolves +∞ to the UPPER bound. Either way the direction
  // is honoured: an extreme zoom-IN must end at MAX zoom, never MIN.
  it('an extreme deltaMode=page zoom-IN notch saturates to MAX zoom, not MIN (REGRESSION)', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View); // start zoom 4, range 1..50
    const before = camera.camera.zoom;
    // The exact repro from the audit: deltaMode=2 (page), large negative deltaY.
    dispatcher.wheel({ x: 200, y: 150, deltaY: -1000, deltaMode: 2 });
    expect(camera.writes.length).toBe(1);
    expect(Number.isFinite(camera.camera.zoom)).toBe(true);
    // Direction honoured: zoom went UP (in), not down to the minimum.
    expect(camera.camera.zoom).toBeGreaterThan(before);
    expect(camera.camera.zoom).toBe(DEFAULT_ZOOM_RANGE.maxZoom);
  });

  it('an extreme deltaMode=page zoom-OUT notch saturates to MIN zoom (REGRESSION)', () => {
    const { camera, dispatcher } = setup(EDIT_MODE.View); // start zoom 4, range 1..50
    const before = camera.camera.zoom;
    dispatcher.wheel({ x: 200, y: 150, deltaY: 1000, deltaMode: 2 });
    expect(Number.isFinite(camera.camera.zoom)).toBe(true);
    expect(camera.camera.zoom).toBeLessThan(before);
    expect(camera.camera.zoom).toBe(DEFAULT_ZOOM_RANGE.minZoom);
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

// --- A8: クリックかドラッグかを、離した位置でもう一度測り直す --------------------
//
// 増分 5 の手直し A8 / GPT #12。それまで「動いたか」の判定は `pointerMove` が来たとき
// にしか走っていなかったので、**移動の見本が 1 つも届かない（あるいは間引かれて最後の
// 1 つが落ちた）まま、押した所と離れた所が離れている**押下が「クリック」になった。
// 読むだけのときは、これがそのまま「離した場所の地物を選ぶ」になる ―― 地図を掴んで
// 動かしたのに、指を離した先の地物が勝手に選ばれる。`dispatch.ts` が書いている契約
// （押下から解放までの総移動量で決める）とも食い違っていた。
//
// 判定は 1 方向にしか倒れない（クリック → ドラッグ）ので、近くで離したときは従来どおり
// クリックのままである（下の回帰）。

describe('A8: pointerMove が 1 度も来ない押下でも、離した位置で測り直す', () => {
  /** しきい値（4px）より十分遠い。 */
  const FAR = { dx: 40, dy: 0 };
  /** しきい値より近い（クリックのまま）。 */
  const NEAR = { dx: 2, dy: 1 };

  it('読むだけ: 移動なしで遠くで離しても選択が走らない（旧版は離した場所の地物を選んだ）', () => {
    const hit = featureBodyHit(asFeatureId('f1'));
    const { camera, selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left));
    // **pointerMove は 1 度も送らない**（間引かれて最後の 1 つが落ちた状況そのもの）。
    dispatcher.pointerUp(ptr(1, 200 + FAR.dx, 150 + FAR.dy, POINTER_BUTTON.Left));
    expect(selection.events).toEqual([]);
    // ドラッグと判った押下なので、最後の位置で視点は 1 度書かれる（見本が落ちても
    // 動いたぶんは反映される ―― 「何も起きない」にはしない）。
    expect(camera.writes.length).toBe(1);
    expect(dispatcher.activeCount).toBe(0);
  });

  it('読むだけ: 移動なしで近くで離せば従来どおりクリック＝選択（回帰）', () => {
    const hit = featureBodyHit(asFeatureId('f1'));
    const { camera, selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 200 + NEAR.dx, 150 + NEAR.dy, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:featureBody', 'end:click@202,151']);
    expect(camera.writes.length).toBe(0); // 教訓 5.8: クリックは何も動かさない
  });

  it('編集: 移動なしで遠くで離すと selection.end の第 2 引数が true（ドラッグ）になる', () => {
    const hit = vertexHit(asFeatureId('f1'), asVertexId('v1'));
    const { selection, dispatcher } = setup(EDIT_MODE.Edit, hit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100 + FAR.dx, 100 + FAR.dy, POINTER_BUTTON.Left));
    // 旧版は 'end:click@140,100' ―― ドラッグを「クリック」と報せると、U22 の
    // 「ドラッグなら選択しない」規則をすり抜けて、離した先の頂点が選ばれる。
    expect(selection.events).toEqual(['start:vertex', 'end:drag@140,100']);
  });

  it('編集: 移動なしで近くで離せば従来どおりクリック（回帰）', () => {
    const hit = vertexHit(asFeatureId('f1'), asVertexId('v1'));
    const { selection, dispatcher } = setup(EDIT_MODE.Edit, hit);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100 + NEAR.dx, 100 + NEAR.dy, POINTER_BUTTON.Left));
    expect(selection.events).toEqual(['start:vertex', 'end:click@102,101']);
  });

  it('編集セッションの release にも、測り直した「ドラッグだったか」が渡る', () => {
    // 掴んだ頂点を離す確定（U24 confirmRelease）は wasDrag で 0 移動の空振りを落とす
    // （教訓 5.24）。ここが click のままだと、実際に動かした編集が「動いていない」と
    // 判定されて確定が落ちる。
    const releases: { wasDrag: boolean }[] = [];
    const camera = new FakeCamera();
    const selection = new FakeSelection();
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      camera,
      hitTester: { hitTest: () => vertexHit(asFeatureId('f1'), asVertexId('v1')) },
      selection,
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
      editSession: {
        begin: () => true,
        update: () => undefined,
        release: (_point, wasDrag) => releases.push({ wasDrag }),
        cancel: () => undefined,
      },
    });
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 140, 100, POINTER_BUTTON.Left));
    expect(releases).toEqual([{ wasDrag: true }]);
  });

  it('一度ドラッグと判った押下は、押した位置へ戻して離してもクリックへ戻らない（1 方向）', () => {
    // 測り直しは「クリック → ドラッグ」の 1 方向にしか倒れない。往復して元の位置で
    // 離したときに「クリック」に戻ると、地図を掴んで動かして戻した拍子に地物が選ばれる。
    const hit = featureBodyHit(asFeatureId('f1'));
    const { selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 280, 150, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 200, 150, POINTER_BUTTON.Left)); // 元の位置へ戻して離す
    expect(selection.events).toEqual([]);
  });

  it('斜めのわずかな移動でもしきい値を越えればドラッグ（軸ごとの比較になっていない）', () => {
    // dx=3,dy=3 は各軸では 4px 未満だが距離は約 4.24px でしきい値を越える。軸ごとに
    // 比べる実装へ書き換わると、ここだけが落ちる。
    const hit = featureBodyHit(asFeatureId('f1'));
    const { selection, dispatcher } = setup(EDIT_MODE.View, hit);
    dispatcher.pointerDown(ptr(1, 200, 150, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 203, 153, POINTER_BUTTON.Left));
    expect(selection.events).toEqual([]);
  });
});

describe('「選択」の道具の左ボタン（B114。読むだけと同じ割り当て）', () => {
  function setupSelectTool(hit: HitResult, emptyPressPans = true) {
    const camera = new FakeCamera();
    const selection = new FakeSelection();
    const begins: string[] = [];
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      getEmptyPressPans: () => emptyPressPans,
      camera,
      hitTester: { hitTest: () => hit },
      selection,
      editSession: {
        begin: (h) => {
          begins.push(h.kind);
          return false;
        },
        update: () => {},
        release: () => {},
        cancel: () => {},
      },
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
    });
    return { camera, selection, begins, dispatcher };
  }

  it('何もないところからのドラッグは地図を動かし、選択には触れず、掴みも始めない', () => {
    const { camera, selection, begins, dispatcher } = setupSelectTool(EMPTY_HIT);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(DISPATCH_TARGET.Pan);
    dispatcher.pointerMove(ptr(1, 150, 120, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 150, 120, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBeGreaterThan(0);
    expect(selection.events).toEqual([]);
    expect(begins).toEqual([]);
  });

  it('何もないところで動かさず離すと、今までどおり選択として解決する（選択の解除）', () => {
    const { camera, selection, begins, dispatcher } = setupSelectTool(EMPTY_HIT);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(camera.writes).toEqual([]);
    expect(selection.events).toEqual([`start:${EMPTY_HIT.kind}`, 'end:click@100,100']);
    expect(begins).toEqual([]);
  });

  it('地物の上からは今までどおり選択と掴みの口へ行き、地図は動かない', () => {
    const hit = featureBodyHit(asFeatureId('f1'));
    const { camera, selection, begins, dispatcher } = setupSelectTool(hit);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    dispatcher.pointerMove(ptr(1, 150, 120, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 150, 120, POINTER_BUTTON.Left));
    expect(camera.writes).toEqual([]);
    expect(begins).toEqual([hit.kind]);
    expect(selection.events).toContain('end:drag@150,120');
  });

  it('「頂点」「動かす」（偽）では何もないところからのドラッグは今までどおり囲む口へ行く', () => {
    const { camera, selection, dispatcher } = setupSelectTool(EMPTY_HIT, false);
    expect(dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left))).toBe(
      DISPATCH_TARGET.SelectEdit,
    );
    dispatcher.pointerMove(ptr(1, 150, 120, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 150, 120, POINTER_BUTTON.Left));
    expect(camera.writes).toEqual([]);
    expect(selection.events).toContain('end:drag@150,120');
  });

  it('中ボタンのパンを動かさず離しても、選択にはならない', () => {
    const { selection, dispatcher } = setupSelectTool(EMPTY_HIT);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Middle));
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Middle));
    expect(selection.events).toEqual([]);
  });
});

describe('左の押下の途中で板が開いたとき（B114 の検証の指摘）', () => {
  function setupBoard(mode: EditMode = EDIT_MODE.Edit) {
    const camera = new FakeCamera();
    const selection = new FakeSelection();
    const capture = new FakeCaptureTarget();
    const dispatcher = new PointerDispatcher({
      getMode: () => mode,
      getEmptyPressPans: () => true,
      camera,
      hitTester: { hitTest: () => EMPTY_HIT },
      selection,
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
    });
    return { camera, selection, capture, dispatcher };
  }

  it('開いた合図の時点で押下を捨て、掴みも放す（板を閉じたあとの合図を待たない）', () => {
    const { selection, capture, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left), capture);
    expect(capture.captured.size).toBe(1);
    expect(dispatcher.foldPressedLeftPans()).toBe(true);
    expect(capture.captured.size).toBe(0);
    expect(dispatcher.activeCount).toBe(0);
    expect(selection.events).toEqual([]);
  });

  it('動かさず離しても、選択を解決しない', () => {
    const { selection, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.foldPressedLeftPans();
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(selection.events).toEqual([]);
  });

  it('動かしても地図を動かさない', () => {
    const { camera, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.foldPressedLeftPans();
    dispatcher.pointerMove(ptr(1, 180, 140, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 180, 140, POINTER_BUTTON.Left));
    expect(camera.writes).toEqual([]);
  });

  it('畳んだあとの次の押下は今までどおり動く', () => {
    const { camera, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.foldPressedLeftPans();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 180, 140, POINTER_BUTTON.Left));
    expect(camera.writes.length).toBe(1);
  });

  it('中ボタンの移動は畳まない', () => {
    const { camera, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Middle));
    expect(dispatcher.foldPressedLeftPans()).toBe(false);
    dispatcher.pointerMove(ptr(1, 180, 140, POINTER_BUTTON.Middle));
    expect(camera.writes.length).toBe(1);
  });

  it('地物の上からの選択の押下は畳まない（板の覆いへ移った時点で別の経路が畳む）', () => {
    const selection = new FakeSelection();
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      getEmptyPressPans: () => true,
      camera: new FakeCamera(),
      hitTester: { hitTest: () => featureBodyHit(asFeatureId('f1')) },
      selection,
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
    });
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(dispatcher.foldPressedLeftPans()).toBe(false);
    expect(dispatcher.activeCount).toBe(1);
  });

  it('押下が無ければ何も畳まない', () => {
    expect(setupBoard().dispatcher.foldPressedLeftPans()).toBe(false);
  });

  it('板が開いていなければ、今までどおり選択として解決する', () => {
    const { selection, dispatcher } = setupBoard();
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(selection.events).toEqual([`start:${EMPTY_HIT.kind}`, 'end:click@100,100']);
  });
});

describe('地図を動かしている最中のカメラの変更（B114 の検証の指摘）', () => {
  const MODES = [
    ['読むだけ', EDIT_MODE.View, POINTER_BUTTON.Left],
    ['「選択」', EDIT_MODE.Edit, POINTER_BUTTON.Left],
    ['中ボタン', EDIT_MODE.Edit, POINTER_BUTTON.Middle],
  ] as const;

  function setupPan(mode: EditMode) {
    const camera = new FakeCamera();
    const dispatcher = new PointerDispatcher({
      getMode: () => mode,
      getEmptyPressPans: () => true,
      camera,
      hitTester: { hitTest: () => EMPTY_HIT },
      selection: new FakeSelection(),
      add: new FakeAdd(),
      contextMenu: new FakeContextMenu(),
    });
    return { camera, dispatcher };
  }

  it.each(MODES)('%s: ホイールの倍率が次の移動で戻らず、掴んだ場所が指に付いてくる', (_n, mode, button) => {
    const { camera, dispatcher } = setupPan(mode);
    dispatcher.pointerDown(ptr(1, 100, 100, button));
    dispatcher.pointerMove(ptr(1, 150, 100, button));
    dispatcher.wheel({ x: 150, y: 100, deltaY: -100 });
    const afterWheel = camera.camera;
    expect(afterWheel.zoom).toBeGreaterThan(4);

    dispatcher.pointerMove(ptr(1, 170, 100, button));
    expect(camera.camera.zoom).toBe(afterWheel.zoom);
    // 指が 20px 動いた分だけ、ホイールのあとの倍率で中心が動く。
    expect(camera.camera.centerLon).toBeCloseTo(afterWheel.centerLon - 20 / afterWheel.zoom, 9);

    dispatcher.pointerUp(ptr(1, 180, 100, button));
    expect(camera.camera.zoom).toBe(afterWheel.zoom);
    expect(camera.camera.centerLon).toBeCloseTo(afterWheel.centerLon - 30 / afterWheel.zoom, 9);
  });

  it('外からのカメラの変更（鍵盤の拡大・全体表示）にも追従する', () => {
    const { camera, dispatcher } = setupPan(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 150, 100, POINTER_BUTTON.Left));
    camera.camera = { centerLon: 40, centerLat: 10, zoom: 8 };
    dispatcher.pointerMove(ptr(1, 158, 100, POINTER_BUTTON.Left));
    expect(camera.camera).toEqual({ centerLon: 39, centerLat: 10, zoom: 8 });
  });

  it('カメラの変更が無ければ、起点は押した瞬間のまま（長いドラッグで誤差を積まない）', () => {
    const { camera, dispatcher } = setupPan(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    for (let x = 101; x <= 400; x += 3) dispatcher.pointerMove(ptr(1, x, 100, POINTER_BUTTON.Left));
    dispatcher.pointerMove(ptr(1, 500, 100, POINTER_BUTTON.Left));
    expect(camera.camera.centerLon).toBe(-(500 - 100) / 4);
  });

  it('しきい値の手前でホイールを回しても、離せばカメラはホイールの位置のまま', () => {
    const { camera, dispatcher } = setupPan(EDIT_MODE.View);
    dispatcher.pointerDown(ptr(1, 100, 100, POINTER_BUTTON.Left));
    dispatcher.wheel({ x: 100, y: 100, deltaY: -100 });
    const afterWheel = camera.camera;
    dispatcher.pointerUp(ptr(1, 100, 100, POINTER_BUTTON.Left));
    expect(camera.camera).toEqual(afterWheel);
  });
});
