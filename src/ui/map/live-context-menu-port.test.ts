// REGRESSION (bughunt2: FR-96 right-click context menu wired to a NO-OP port).
//
// The defect: the U40 dispatcher routes EVERY right-button press to the
// `contextMenu` port (dispatch.ts:「Right button is always a context-menu request」),
// but the composition root backed it with NOOP_CONTEXT_MENU_PORT — `request(){}` —
// so a real right-click opened NOTHING (the menu component + registry path existed
// and were unit-tested, but were never reached from pointer input, 教訓 5.7).
//
// These tests pin the missing 結線 at the seam the bug lived at: a right-button
// press, routed through the REAL PointerDispatcher, must reach the LIVE port, which
// (1) promotes the hit feature into selection (so a menu command targets it,
// 教訓 5.11), (2) converts the surface point to client px, and (3) opens the menu.
// A test that drives NOOP_CONTEXT_MENU_PORT instead would observe nothing — exactly
// the bug. The dispatcher's right-button branch is also re-asserted as "never pans".

import { describe, expect, it } from 'vitest';

import { PointerDispatcher, type NormalizedPointer } from './PointerDispatcher';
import { POINTER_BUTTON } from './dispatch';
import {
  EMPTY_HIT_TESTER,
  NO_MODIFIERS,
  NOOP_ADD_PORT,
  NOOP_SELECTION_PORT,
  type CameraPort,
  type HitTester,
} from './ports';
import {
  createLiveContextMenuPort,
  promoteHitToSelection,
} from './live-context-menu-port';
import {
  EMPTY_HIT,
  EMPTY_SELECTION,
  edgeHit,
  featureBodyHit,
  replaceVertices,
  vertexHit,
  withActiveFeature,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { EDIT_MODE } from '../state/session';
import type { Camera, ScreenPoint, Viewport } from '../../render';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAMERA: Camera = { centerLon: 0, centerLat: 0, zoom: 1 } as unknown as Camera;

/** A camera port that records writes so we can assert a right-click never pans. */
function recordingCameraPort(): CameraPort & { readonly writes: Camera[] } {
  const writes: Camera[] = [];
  return {
    writes,
    read: () => ({ camera: CAMERA, viewport: VIEWPORT }),
    write: (c) => {
      writes.push(c);
    },
  };
}

function rightDown(x = 30, y = 40): NormalizedPointer {
  return { pointerId: 1, x, y, button: POINTER_BUTTON.Right, modifiers: NO_MODIFIERS };
}

interface PortHarness {
  readonly promoted: HitResult[];
  readonly opened: { clientX: number; clientY: number; hit: HitResult }[];
  readonly port: ReturnType<typeof createLiveContextMenuPort>;
}

/** Build the live port with recording deps + a +100/+200 surface→client offset. */
function harness(): PortHarness {
  const promoted: HitResult[] = [];
  const opened: { clientX: number; clientY: number; hit: HitResult }[] = [];
  const port = createLiveContextMenuPort({
    surfaceToClient: (p: ScreenPoint) => ({ x: p.x + 100, y: p.y + 200 }),
    promoteHit: (hit) => promoted.push(hit),
    open: (req) => opened.push(req),
  });
  return { promoted, opened, port };
}

describe('createLiveContextMenuPort (FR-96 right-click wiring, bughunt2)', () => {
  it('a feature-body right-click promotes the hit feature and opens the menu at the cursor', () => {
    const h = harness();
    const hit = featureBodyHit(asFeatureId('f-1'));
    h.port.request({ x: 30, y: 40 }, hit);

    expect(h.promoted).toEqual([hit]); // 削除 etc. now target the right-clicked feature
    expect(h.opened).toEqual([{ clientX: 130, clientY: 240, hit }]);
  });

  it('a vertex right-click promotes the vertex hit and opens the menu', () => {
    const h = harness();
    const hit = vertexHit(asFeatureId('f-2'), asVertexId('v-9'));
    h.port.request({ x: 1, y: 2 }, hit);

    expect(h.promoted).toEqual([hit]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.hit).toBe(hit);
  });

  it('an empty-space right-click opens the menu but does NOT touch the selection', () => {
    const h = harness();
    h.port.request({ x: 5, y: 6 }, EMPTY_HIT);

    expect(h.promoted).toEqual([]); // never silently clears the current selection
    expect(h.opened).toEqual([{ clientX: 105, clientY: 206, hit: EMPTY_HIT }]);
  });
});

// --- promoteHitToSelection — the right-click promote RULE (bughunt5 HOLE-2) ----
// The degradation: a right-click feature-body promote set the active feature ONLY
// and did NOT clear a stale vertex selection (from a prior rubber-band on ANOTHER
// feature). A following 削除 then read the vertex branch and wrongly deleted THAT
// feature's vertices instead of the right-clicked body. The left-click reducer path
// already cleared the vertex set (reducer.ts body branch); these pin the SAME rule
// for the right-click promote so the two paths are symmetric (単一の真実源).

/** A selection with a rubber-band vertex set owned by feature A. */
function withVertexSelectionOnA(): SelectionState {
  return replaceVertices(
    withActiveFeature(EMPTY_SELECTION, asFeatureId('A')),
    asFeatureId('A'),
    new Set([asVertexId('a-1'), asVertexId('a-2')]),
  );
}

describe('promoteHitToSelection (right-click promote rule, HOLE-2 degradation)', () => {
  it('a FEATURE BODY hit on B clears a stale vertex selection on A (no ghost target)', () => {
    const before = withVertexSelectionOnA();
    const after = promoteHitToSelection(before, featureBodyHit(asFeatureId('B')));

    expect(after.activeFeature).toBe(asFeatureId('B'));
    // The stale A-owned vertex set is gone — a following 削除 targets B's body, not A.
    expect(after.vertexOwner).toBeNull();
    expect(after.vertexIds.size).toBe(0);
  });

  it('a VERTEX hit is UNCHANGED: selects that feature + replaces the set with the one vertex', () => {
    const before = withVertexSelectionOnA();
    const after = promoteHitToSelection(before, vertexHit(asFeatureId('B'), asVertexId('b-9')));

    expect(after.activeFeature).toBe(asFeatureId('B'));
    expect(after.vertexOwner).toBe(asFeatureId('B'));
    expect([...after.vertexIds]).toEqual([asVertexId('b-9')]);
  });

  it('matches the LEFT-click reducer body branch (withoutVertexSet ∘ withActiveFeature)', () => {
    // Single truth source: the promote result equals the reducer's body-branch value.
    const before = withVertexSelectionOnA();
    const promoted = promoteHitToSelection(before, featureBodyHit(asFeatureId('B')));
    const reducerBody = { ...before, activeFeature: asFeatureId('B'), vertexOwner: null, vertexIds: new Set() };
    expect(promoted.activeFeature).toBe(reducerBody.activeFeature);
    expect(promoted.vertexOwner).toBe(reducerBody.vertexOwner);
    expect(promoted.vertexIds.size).toBe(0);
  });

  it('an EMPTY / EDGE hit leaves the current selection untouched (no promote target)', () => {
    const before = withVertexSelectionOnA();
    expect(promoteHitToSelection(before, EMPTY_HIT)).toBe(before);
    expect(
      promoteHitToSelection(
        before,
        edgeHit(asFeatureId('A'), asVertexId('a-1'), asVertexId('a-2')),
      ),
    ).toBe(before);
  });
});

describe('PointerDispatcher → live context-menu port (the bug seam)', () => {
  function dispatcherWith(
    hitTester: HitTester,
    port: ReturnType<typeof createLiveContextMenuPort>,
    cam = recordingCameraPort(),
  ): { dispatcher: PointerDispatcher; cam: ReturnType<typeof recordingCameraPort> } {
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.View,
      camera: cam,
      hitTester,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: port,
    });
    return { dispatcher, cam };
  }

  it('a right-button press in View mode reaches the live port (not a no-op) and never pans', () => {
    const h = harness();
    const hitTester: HitTester = { hitTest: () => featureBodyHit(asFeatureId('f-7')) };
    const { dispatcher, cam } = dispatcherWith(hitTester, h.port);

    dispatcher.pointerDown(rightDown());

    // The defect was: NOOP port ⇒ zero opens. The live port must have opened once.
    expect(h.opened).toHaveLength(1);
    expect(h.promoted).toHaveLength(1);
    // Right button is always a context-menu request, never a pan (受け入れ基準 3).
    expect(cam.writes).toHaveLength(0);
    expect(dispatcher.isPanning).toBe(false);
    expect(dispatcher.activeCount).toBe(0); // no tracked sequence started
  });

  it('a right-button press in Edit mode over empty space still opens the menu', () => {
    const h = harness();
    const port = h.port;
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      camera: recordingCameraPort(),
      hitTester: EMPTY_HIT_TESTER,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: port,
    });

    dispatcher.pointerDown(rightDown(10, 20));

    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.hit).toEqual(EMPTY_HIT);
    expect(h.promoted).toEqual([]);
  });
});
