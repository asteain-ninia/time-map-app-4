// U25 — REACHABILITY (到達可能性) test for the ring-edit tool (FR-22 / FR-23 / FR-24).
//
// WHY THIS FILE EXISTS (実機検証 U-C: 到達不能クラスタ):
// The existing controller test injects a `featureAtPoint` that hits the target face's
// whole BOUNDING BOX — including the hole void. The PRODUCTION port
// (`ringEditBootstrap.featureAtPoint` → `leafAtPoint`) is 穴透過: a click inside a hole
// (or outside the face) resolves to NOTHING. Under that REAL semantics the tool had two
// unreachable requirements:
//   (a) FR-22 飛び地: the first click had to hit the face to pick a target, but the SAME
//       click was classified — and "hits the face" ∧ "outside the solid" cannot both hold
//       under a 穴透過 hit-test, so enclave mode was reachable only by accident (a grid-
//       snap coordinate shift);
//   (b) FR-24 穴リング削除: the delete sub-mode's first click also went through
//       `featureAtPoint`, so a click inside the hole was completely inert — no delete, no
//       message.
//
// The invariant this file pins is REACHABILITY ITSELF: with a 穴透過 hit-test (the honest
// production rule) and RAW clicks only (no grid snap, no store pokes, no direct hook
// calls), each of 穴追加 / 飛び地追加 / 穴削除 / 飛び地削除 completes end-to-end and drives
// the injected U24→U13 process with the expected after-state. It also pins the cancel
// re-arm (同一ボタン再クリックで復活) and the grid-snap checkbox state source.
//
// Runs in jsdom over the REAL RingEditToolController (the production component graph).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  PROCESS_STATUS,
  createEditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { createLeafFeature, type Feature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type RingId } from '../../domain/ids';
import { createHoleRing, createShape, createTerritoryRing, RING_KIND } from '../../domain/ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../../domain/vertex';
import { timePointYearMonthDay } from '../../domain/time/time-point';
import {
  RELEASE_OUTCOME,
  buildSnapshot,
  type FeatureSnapshot,
  type ReleaseOutcome,
} from '../../domain/editing/index';
import { POINT_LOCATION, pointInPolygon } from '../../domain/geometry/index';
import { resolveLeafShape } from '../../domain/hierarchy/resolve-shape';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  RingEditToolController,
  type RingEditDrawSink,
  type FeatureAtPoint,
  type ScreenToWorld,
} from './RingEditToolController';

// --- Fixtures ---------------------------------------------------------------

type S = { tag: string };
const NEXT_STATE: S = { tag: 'committed' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'ring-edit',
  execute: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  undo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  redo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
};

const committed: ProcessResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: NEXT_STATE,
  command: noopCommand,
};

const ATTRS = createBasicAttributes('target', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');
const ANCHOR = timePointYearMonthDay(1000, 1, 1);
const TARGET_ID = asFeatureId('leaf');

const OUTER_RING_ID = asRingId('tr-0');
const HOLE_RING_ID = asRingId('hr-0');
const ENCLAVE_RING_ID = asRingId('tr-1');

function box(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): ReturnType<typeof createCoordinate>[] {
  return [
    createCoordinate(minLon, minLat),
    createCoordinate(maxLon, minLat),
    createCoordinate(maxLon, maxLat),
    createCoordinate(minLon, maxLat),
  ];
}

function vertsFor(
  prefix: string,
  coords: ReturnType<typeof createCoordinate>[],
): { ids: ReturnType<typeof asVertexId>[]; vertices: Vertex[] } {
  const ids = coords.map((_, i) => asVertexId(`${prefix}-${i}`));
  return { ids, vertices: coords.map((c, i) => createVertex(ids[i]!, c)) };
}

/**
 * The target face: a [0,20]² territory with a [5,15]² hole, PLUS (when `withEnclave`)
 * a detached [30,40]² 飛び地 (a second top-level territory ring of the SAME face).
 */
function targetLeaf(withEnclave: boolean): { feature: LeafFeature; store: VertexStore } {
  const outer = vertsFor('ov', box(0, 0, 20, 20));
  const hole = vertsFor('hv', box(5, 5, 15, 15));
  const enclave = vertsFor('ev', box(30, 30, 40, 40));
  const territory = createTerritoryRing(OUTER_RING_ID, outer.ids);
  const holeRing = createHoleRing(HOLE_RING_ID, hole.ids, territory.id);
  const enclaveRing = createTerritoryRing(ENCLAVE_RING_ID, enclave.ids);
  const rings = withEnclave ? [territory, holeRing, enclaveRing] : [territory, holeRing];
  const vertices = [
    ...outer.vertices,
    ...hole.vertices,
    ...(withEnclave ? enclave.vertices : []),
  ];
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape(rings));
  return { feature, store: createVertexStore(vertices) };
}

// Identity screen→world so a click at (clientX, clientY) lands at world (x, y).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

let counter = 0;
const ids = () => ({
  nextRingId: () => asRingId(`nr-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly unmount: () => void;
}

const committedOutcome: ReleaseOutcome<S> = {
  kind: RELEASE_OUTCOME.Processed,
  result: committed,
  proposal: createEditProposal(TARGET_ID, ANCHOR, buildSnapshot({ vertices: [] })),
};

const drawSink: RingEditDrawSink = {
  drawRingEdit() {
    /* no renderer under test here */
  },
};

/**
 * Mount the REAL controller with the PRODUCTION hit-test semantics: `featureAtPoint`
 * resolves the leaf through `resolveLeafShape` + `pointInPolygon`, which is 穴透過 —
 * exactly what `leafAtPoint` (the shipped `ringEditBootstrap.featureAtPoint`) does. A
 * click inside the hole void or outside the face therefore returns NULL here, so any
 * flow that survives this harness is genuinely reachable in the app.
 */
function mountRing(withEnclave = false): Harness {
  const { feature, store: vstore } = targetLeaf(withEnclave);
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ReleaseOutcome<S> => committedOutcome);

  const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
    fid === TARGET_ID ? feature : undefined;
  const resolveStore = (): VertexStore => vstore;

  const solidShape = resolveLeafShape(feature.shape, vstore);
  const featureAtPoint: FeatureAtPoint = (p) => {
    if (solidShape === undefined) return null;
    const hit = solidShape.some(
      (polygon) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside,
    );
    return hit ? TARGET_ID : null;
  };

  const utils = render(
    <RingEditToolController<S>
      store={store}
      startProcess={startProcess}
      ids={ids()}
      resolveFeature={resolveFeature}
      resolveStore={resolveStore}
      anchorTime={() => ANCHOR}
      current={() => store.getState().domain}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      drawSink={drawSink}
    />,
  );

  return { store, startProcess, unmount: utils.unmount };
}

function activateRing(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditRing);
  });
}

/** A RAW left click on the tool's map-input layer (the only input these tests use). */
function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('ring-edit-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

function confirmedSnapshot(h: Harness, call = 0): FeatureSnapshot {
  return h.startProcess.mock.calls[call]![0] as FeatureSnapshot;
}

function ringsOf(snapshot: FeatureSnapshot): ReadonlyArray<{ id: RingId; kind: string }> {
  const feature = snapshot.feature as LeafFeature | undefined;
  if (feature === undefined) return [];
  return feature.shape.rings.map((r) => ({ id: r.id, kind: r.kind }));
}

// --- FR-22 穴追加 / 飛び地追加 — reachable with RAW clicks only ------------------

describe('ring-edit reachability — FR-22 穴 / 飛び地 追加 (生クリックのみ)', () => {
  it('穴追加: 面をクリックで選択 → 面の内側に 3 点 → 確定で HOLE リングが追加される', () => {
    const h = mountRing();
    activateRing(h.store);

    // 1st click: pick the target face (in the solid fill — the hit-test finds it).
    clickInput(2, 2);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    // No vertex is placed by the target-selection click; the guide switches to drawing.
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('0');
    expect(screen.getByTestId('ring-edit-guide').textContent).toContain('頂点');

    // Ring clicks: inside the solid ring band (between outer 0..20 and hole 5..15).
    clickInput(1, 1);
    clickInput(3, 1);
    clickInput(2, 3);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const rings = ringsOf(confirmedSnapshot(h));
    expect(rings).toHaveLength(3);
    const added = rings.filter((r) => r.id !== OUTER_RING_ID && r.id !== HOLE_RING_ID);
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe(RING_KIND.Hole);
    h.unmount();
  });

  it('飛び地追加: 面をクリックで選択 → 面の外側に 3 点 → 確定で TERRITORY リングが追加される', () => {
    const h = mountRing();
    activateRing(h.store);

    clickInput(2, 2); // target face
    // Every ring click is OUTSIDE the face — `featureAtPoint` returns null there, and
    // that must NOT swallow the click (this is the FR-22 飛び地 path).
    clickInput(30, 30);
    clickInput(34, 30);
    clickInput(32, 34);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const rings = ringsOf(confirmedSnapshot(h));
    expect(rings).toHaveLength(3);
    const added = rings.filter((r) => r.id !== OUTER_RING_ID && r.id !== HOLE_RING_ID);
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe(RING_KIND.Territory);
    h.unmount();
  });

  it('穴の内側を最初の頂点にすると 飛び地 (TERRITORY) として分類される（穴の中の飛び地）', () => {
    const h = mountRing();
    activateRing(h.store);
    clickInput(2, 2); // target face (solid)
    // Inside the [5,15]² hole void: not solid ⇒ enclave, even though the hit-test misses.
    clickInput(8, 8);
    clickInput(12, 8);
    clickInput(10, 12);
    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const added = ringsOf(confirmedSnapshot(h)).filter(
      (r) => r.id !== OUTER_RING_ID && r.id !== HOLE_RING_ID,
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.kind).toBe(RING_KIND.Territory);
    h.unmount();
  });
});

// --- FR-24 穴削除 / 飛び地削除 — reachable with RAW clicks only ------------------

describe('ring-edit reachability — FR-24 リング削除 (生クリックのみ)', () => {
  it('穴削除: 面を選択 → 穴の内側クリックで HOLE リングが消えた後状態を確定する', () => {
    const h = mountRing();
    activateRing(h.store);
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → delete

    clickInput(2, 2); // pick the target face (solid fill — the only place the hit-test hits)
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(h.startProcess).not.toHaveBeenCalled(); // selection alone deletes nothing

    clickInput(10, 10); // inside the hole void → the hole ring
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const rings = ringsOf(confirmedSnapshot(h));
    expect(rings.map((r) => r.id)).toEqual([OUTER_RING_ID]);
    h.unmount();
  });

  it('飛び地削除: 面を選択 → 飛び地の内側クリックで TERRITORY リングだけが消える', () => {
    const h = mountRing(true);
    activateRing(h.store);
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → delete

    clickInput(2, 2); // target face
    clickInput(35, 35); // inside the detached 飛び地
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const rings = ringsOf(confirmedSnapshot(h));
    expect(rings.map((r) => r.id).sort()).toEqual([HOLE_RING_ID, OUTER_RING_ID].sort());
    h.unmount();
  });

  it('リングに当たらないクリックは日本語メッセージを出す（無反応にしない）', () => {
    const h = mountRing();
    activateRing(h.store);
    fireEvent.click(screen.getByTestId('ring-edit-submode'));
    clickInput(2, 2); // target face
    clickInput(100, 100); // nowhere near any ring of the chosen face
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('ring-edit-message').textContent).not.toBe('');
    h.unmount();
  });

  it('対象の面に当たらない最初のクリックも日本語メッセージを出す（無反応にしない）', () => {
    const h = mountRing();
    activateRing(h.store);
    fireEvent.click(screen.getByTestId('ring-edit-submode'));
    clickInput(100, 100);
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('ring-edit-message').textContent).not.toBe('');
    h.unmount();
  });
});

// --- キャンセル後の再アーム (同一ツールボタンの再クリックで復活) -------------------

describe('ring-edit reachability — キャンセルはツール選択も解除して再アームできる', () => {
  it('キャンセルで activeTool が null になり（toolbar の押下状態も解除）、再選択で復活する', () => {
    const h = mountRing();
    activateRing(h.store);
    clickInput(2, 2);
    expect(screen.getByTestId('ring-edit-tool')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ring-edit-cancel'));
    expect(screen.queryByTestId('ring-edit-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // Re-selecting the SAME tool re-arms a fresh session (the 実機 repro: the user
    // pressed the same button again and nothing happened).
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditRing));
    expect(screen.getByTestId('ring-edit-tool')).toBeInTheDocument();
    clickInput(2, 2);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    h.unmount();
  });

  it('Escape も同じくツール選択を解除する（単一の解除経路）', () => {
    const h = mountRing();
    activateRing(h.store);
    clickInput(2, 2);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('ring-edit-tool')).not.toBeInTheDocument();
    h.unmount();
  });
});

// --- FR-78 グリッドスナップのチェック状態 (draft 生成前でも反映) --------------------

describe('ring-edit reachability — グリッドスナップの checked は draft 前でも反映される', () => {
  it('対象未選択（draft 生成前）でもチェックが入り、その設定で最初の頂点が量子化される', () => {
    const h = mountRing();
    act(() => h.store.getState().updateProjectSetting('gridSpacingDeg', 1));
    activateRing(h.store);

    const checkbox = screen.getByTestId('ring-edit-gridsnap') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    act(() => {
      fireEvent.click(checkbox);
    });
    expect((screen.getByTestId('ring-edit-gridsnap') as HTMLInputElement).checked).toBe(true);

    // And the toggle is live for the FIRST placed vertex of the draft that follows.
    clickInput(2, 2);
    expect((screen.getByTestId('ring-edit-gridsnap') as HTMLInputElement).checked).toBe(true);
    clickInput(1.4, 1.4);
    clickInput(3.4, 0.6);
    clickInput(1.6, 3.4);
    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    const snapshot = confirmedSnapshot(h);
    expect(snapshot.vertices.map((v) => v.coordinate)).toEqual([
      { lon: 1, lat: 1 },
      { lon: 3, lat: 1 },
      { lon: 2, lat: 3 },
    ]);
    h.unmount();
  });
});
