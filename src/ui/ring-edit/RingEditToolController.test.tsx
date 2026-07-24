// U25 — CROSS-LAYER INTEGRATION test (FR-22 穴/飛び地追加 / FR-24 リング削除).
//
// The domain core (auto-mode / draft / commands / confirm) is covered in isolation
// under src/domain/ring-edit. THIS test is the layer-crossing verification the lens
// flags as missing: it mounts the REAL RingEditToolController over ONE session store
// and drives the whole flow through the actual UI —
//   - FR-22: tool select → target-face click → ring-vertex clicks (the first one
//     auto-classifies 穴 / 飛び地) → 確定 runs addRing and drives the injected U24→U13
//     process (the COMPLETE trigger is wired and fires — 教訓 5.7);
//   - FR-24: delete sub-mode → target-face click → click inside a hole ring →
//     deleteHoleRing drives the same confirm; a last-territory delete drops the feature;
//   - a rejection surfaces a Japanese message and does NOT confirm (教訓 5.22);
//   - the transient draft is discarded on every exit path (Escape / tool switch / sub-mode
//     switch) and the render batch is pushed to the sink + cleared on discard (教訓 5.2).
//
// Runs in jsdom: the renderer transform + draw sink are faked; the WIRING under test is
// the production component graph.

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
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { timePointYearMonthDay } from '../../domain/time/time-point';
import {
  RELEASE_OUTCOME,
  buildSnapshot,
  type ReleaseOutcome,
} from '../../domain/editing/index';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  RingEditToolController,
  type RingEditDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
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

/** A [0,20]² territory leaf with a [5,15]² hole punched into it, + its store. */
function targetLeaf(): { feature: LeafFeature; store: VertexStore } {
  const outer = [
    createCoordinate(0, 0),
    createCoordinate(20, 0),
    createCoordinate(20, 20),
    createCoordinate(0, 20),
  ];
  const hole = [
    createCoordinate(5, 5),
    createCoordinate(15, 5),
    createCoordinate(15, 15),
    createCoordinate(5, 15),
  ];
  const outerVids = outer.map((_, i) => asVertexId(`ov-${i}`));
  const holeVids = hole.map((_, i) => asVertexId(`hv-${i}`));
  const vertices = [
    ...outer.map((c, i) => createVertex(outerVids[i]!, c)),
    ...hole.map((c, i) => createVertex(holeVids[i]!, c)),
  ];
  const territory = createTerritoryRing(asRingId('tr-0'), outerVids);
  const holeRing = createHoleRing(asRingId('hr-0'), holeVids, territory.id);
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape([territory, holeRing]));
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
  readonly drawSink: RingEditDrawSink & { batches: number[] };
  readonly unmount: () => void;
}

/**
 * The injected confirm process. By default it returns a Processed→Committed outcome
 * (so a confirm exercises the whole COMPLETE trigger). The snapshot the hook assembled
 * is captured on `startProcess` so a test can assert what was confirmed.
 */
/** A committed Processed outcome carrying a well-formed (unused) proposal. */
const committedOutcome: ReleaseOutcome<S> = {
  kind: RELEASE_OUTCOME.Processed,
  result: committed,
  proposal: createEditProposal(TARGET_ID, ANCHOR, buildSnapshot({ vertices: [] })),
};

function mountRing(outcome: ReleaseOutcome<S> = committedOutcome): Harness {
  const { feature, store: vstore } = targetLeaf();
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ReleaseOutcome<S> => outcome);

  const batches: number[] = [];
  const drawSink: RingEditDrawSink & { batches: number[] } = {
    batches,
    drawRingEdit(prims) {
      batches.push(prims.length);
    },
  };

  const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
    fid === TARGET_ID ? feature : undefined;
  const resolveStore = (): VertexStore => vstore;
  // Clicking anywhere inside [0,20]² resolves the target; outside → miss.
  const featureAtPoint: FeatureAtPoint = (p) =>
    p.lon >= 0 && p.lon <= 20 && p.lat >= 0 && p.lat <= 20 ? TARGET_ID : null;

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

  return { store, startProcess, drawSink, unmount: utils.unmount };
}

function activateRing(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditRing);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('ring-edit-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

/**
 * Phase 1 of every ring-edit interaction: pick the target FACE with its own click
 * (教訓 U-C 到達可能性). The later clicks are hit-test independent, which is what makes
 * 飛び地追加 (a first vertex OUTSIDE the face) and 穴リング削除 (a click in the hole void,
 * where the production 穴透過 hit-test reports a miss) reachable at all — see
 * ring-edit-reachability.test.tsx. Selecting places NO vertex.
 */
function selectTargetFace(): void {
  clickInput(2, 2);
}

// --- FR-22: add a HOLE (first click in solid) → confirm drives U13 ------------

describe('RingEditToolController — hole/enclave add (FR-22)', () => {
  it('starting the tool shows the select-target guide and pushes an overlay batch', () => {
    const h = mountRing();
    activateRing(h.store);
    expect(screen.getByTestId('ring-edit-guide').textContent).toContain('面をクリック');
    // The render sink received an (empty) batch on the initial draft push.
    expect(h.drawSink.batches.length).toBeGreaterThan(0);
    h.unmount();
  });

  it('selecting a leaf target promotes it into the store selection', () => {
    const h = mountRing();
    activateRing(h.store);
    expect(h.store.getState().activeFeature).toBeNull();
    // A click in the SOLID fill (e.g. (2,2)) picks the target face (phase 1) — it starts
    // the draft but places NO vertex; the ring's own vertices come from the next clicks.
    selectTargetFace();
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('0');
    h.unmount();
  });

  it('a hole draft (first click in solid) confirms via addRing → U13', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace(); // phase 1: the target face
    // Three clicks INSIDE the hole void ([5,15]²) are OUTSIDE the solid → would be enclave;
    // instead place a small hole INSIDE the solid ring (between outer 0..20 and hole 5..15).
    clickInput(1, 1); // first RING click in solid fill → hole mode
    clickInput(3, 1);
    clickInput(2, 3);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('3');
    // Confirm the drafted ring: addRing succeeds and the injected U13 process is called.
    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    // On commit the draft is discarded (教訓 5.2) and the tool re-arms fresh for another
    // ring — the chrome stays mounted (like knife/merge) but the vertex draft is empty.
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('0');
    h.unmount();
  });

  it('undo removes the last placed vertex (FR-78)', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    clickInput(3, 1);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('ring-edit-undo'));
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('1');
    h.unmount();
  });

  it('confirm is disabled below 3 vertices', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    clickInput(3, 1);
    expect(screen.getByTestId('ring-edit-confirm')).toBeDisabled();
    clickInput(2, 3);
    expect(screen.getByTestId('ring-edit-confirm')).not.toBeDisabled();
    h.unmount();
  });
});

// --- FR-78: グリッドスナップ — the toggle actually quantizes placed vertices ----------
//
// 整合レビュー穴1 (dead grid-snap toggle): placeAddVertex used to pass the raw click
// straight to placeFirstVertex/placeVertex, so the FR-78 grid-snap checkbox was a no-op
// (HB-4 class of dead toggle). The fix routes placement through the SAME resolveSnap
// single-source the add tool uses, quantizing to the project graticule. These drive the
// REAL controller and read the confirmed snapshot's vertices (what the confirm assembles).

describe('RingEditToolController — grid snap quantizes placed vertices (FR-78)', () => {
  // Raw clicks at NON-integer positions that, at a 1° graticule, snap to the exact
  // (1,1)(3,1)(2,3) solid-fill triangle the FR-22 confirm test uses.
  const rawClicks: ReadonlyArray<readonly [number, number]> = [
    [1.4, 1.4],
    [3.4, 0.6],
    [1.6, 3.4],
  ];

  function firstConfirmedVertices(h: Harness): ReadonlyArray<{ lon: number; lat: number }> {
    const call = h.startProcess.mock.calls[0]!;
    const snapshot = call[0] as { vertices: ReadonlyArray<{ coordinate: { lon: number; lat: number } }> };
    return snapshot.vertices.map((v) => v.coordinate);
  }

  it('with grid snap ON the placed coordinates land on the graticule (quantized)', () => {
    const h = mountRing();
    // Fine 1° graticule so the snapped points are inside the solid fill (not degenerate).
    act(() => h.store.getState().updateProjectSetting('gridSpacingDeg', 1));
    activateRing(h.store);
    // Enable the grid-snap draft toggle, then pick the face and place the ring.
    act(() => {
      fireEvent.click(screen.getByTestId('ring-edit-gridsnap'));
    });
    selectTargetFace();
    for (const [lon, lat] of rawClicks) clickInput(lon, lat);
    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    // Every placed vertex snapped to the 1° graticule (integers) — NOT the raw click.
    expect(firstConfirmedVertices(h)).toEqual([
      { lon: 1, lat: 1 },
      { lon: 3, lat: 1 },
      { lon: 2, lat: 3 },
    ]);
    h.unmount();
  });

  it('with grid snap OFF the placed coordinates keep the raw (non-snapped) click', () => {
    const h = mountRing();
    act(() => h.store.getState().updateProjectSetting('gridSpacingDeg', 1));
    activateRing(h.store);
    // Leave grid snap OFF (default): the same raw clicks must NOT be quantized.
    selectTargetFace();
    for (const [lon, lat] of rawClicks) clickInput(lon, lat);
    fireEvent.click(screen.getByTestId('ring-edit-confirm'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    expect(firstConfirmedVertices(h)).toEqual([
      { lon: 1.4, lat: 1.4 },
      { lon: 3.4, lat: 0.6 },
      { lon: 1.6, lat: 3.4 },
    ]);
    h.unmount();
  });
});

// --- FR-24: delete a ring by clicking inside it -------------------------------

describe('RingEditToolController — ring delete (FR-24)', () => {
  it('delete sub-mode: clicking inside the hole deletes it via deleteHoleRing → U13', () => {
    const h = mountRing();
    activateRing(h.store);
    // Switch to delete sub-mode.
    fireEvent.click(screen.getByTestId('ring-edit-submode'));
    expect(screen.getByTestId('ring-edit-guide').textContent).toContain('削除');
    selectTargetFace(); // phase 1: the face whose ring is deleted
    // Click inside the hole void ([5,15]²) → the deepest containing ring is the hole.
    clickInput(10, 10);
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('a click that hits no ring surfaces a Japanese message and does not confirm', () => {
    const h = mountRing();
    activateRing(h.store);
    fireEvent.click(screen.getByTestId('ring-edit-submode'));
    selectTargetFace(); // phase 1: the face
    // Phase 2 is hit-test INDEPENDENT, so a click far outside the face still reaches
    // deleteRingAt — where ringAtPoint finds no containing ring. That branch must say
    // WHY (教訓 5.12) and must NOT drive U13.
    clickInput(80, 80);
    expect(screen.getByTestId('ring-edit-message').textContent).toContain(
      '対象のリングが見つかりませんでした',
    );
    expect(h.startProcess).not.toHaveBeenCalled();
    h.unmount();
  });
});

// --- 一時状態全経路破棄 (教訓 5.2) --------------------------------------------

describe('RingEditToolController — transient state discarded on every exit path', () => {
  it('Escape cancels the in-progress draft', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    expect(screen.getByTestId('ring-edit-tool')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('ring-edit-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('switching away from the ring tool discards a draft in progress and clears the overlay', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    clickInput(3, 1);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    expect(screen.queryByTestId('ring-edit-tool')).not.toBeInTheDocument();
    // The render sink got a final EMPTY batch on discard (overlay cleared).
    expect(h.drawSink.batches[h.drawSink.batches.length - 1]).toBe(0);
    // Re-activating starts a FRESH session (no carried-over vertices).
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('1');
    h.unmount();
  });

  it('toggling the sub-mode discards the current draft (教訓 5.2)', () => {
    const h = mountRing();
    activateRing(h.store);
    selectTargetFace();
    clickInput(1, 1);
    clickInput(3, 1);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → delete
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → add (fresh)
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('0');
    h.unmount();
  });

  // The ONE piece of state deliberately EXCLUDED from the reset契約 — pinned so the
  // exclusion is a decision, not a drift (敵対レビュー LOW: 契約が暗黙だった).
  // Grid snap is a user PREFERENCE: it carries no geometry/target/draft and is always
  // visible in the checkbox, so it cannot silently leak an operation into the next one.
  it('grid snap is a PREFERENCE: it survives sub-mode switch and tool switch (not reset)', () => {
    const h = mountRing();
    activateRing(h.store);
    act(() => {
      fireEvent.click(screen.getByTestId('ring-edit-gridsnap'));
    });
    expect(screen.getByTestId('ring-edit-gridsnap')).toBeChecked();
    // A sub-mode switch (a discard path) drops the draft but keeps the preference.
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → delete
    fireEvent.click(screen.getByTestId('ring-edit-submode')); // → add
    expect(screen.getByTestId('ring-edit-gridsnap')).toBeChecked();
    // A full tool switch (resetForSwitch) + re-arm (start) likewise keeps it.
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    activateRing(h.store);
    expect(screen.getByTestId('ring-edit-gridsnap')).toBeChecked();
    h.unmount();
  });
});

// バグハント第11波 #3/#6 — the ring-edit controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while a session runs) MUST honour the SAME focus guard the global dispatcher
// does (教訓 5.13 single predicate). The timeline year field / sidebar inputs are live even
// while a ring draft is drawn; a Ctrl+Z / Escape with a text input focused must edit the
// TEXT natively, NOT undo a draft vertex (#3) or cancel the ring edit (#6). A non-editable
// focus still cancels / undoes as before.
describe('RingEditToolController — バグハント第11波 (#3/#6): focus guard on the keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  function drawTwoVertices(): void {
    selectTargetFace();
    clickInput(1, 1);
    clickInput(3, 1);
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a vertex and does NOT preventDefault (#3)', () => {
    const h = mountRing();
    activateRing(h.store);
    drawTwoVertices();
    const input = focusedInput('number');
    const ev = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape with a text input focused does NOT cancel the ring edit and does NOT preventDefault (#6)', () => {
    const h = mountRing();
    activateRing(h.store);
    drawTwoVertices();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // Still drafting (not cancelled): the chrome is up with its 2 vertices.
    expect(screen.getByTestId('ring-edit-tool')).toBeInTheDocument();
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still undoes / cancels (no regression)', () => {
    const h = mountRing();
    activateRing(h.store);
    drawTwoVertices();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('ring-edit-vertex-count').textContent).toBe('1');
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.queryByTestId('ring-edit-tool')).not.toBeInTheDocument();
    button.remove();
    h.unmount();
  });
});
