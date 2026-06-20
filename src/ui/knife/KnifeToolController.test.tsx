// U26 — CROSS-LAYER INTEGRATION test (受け入れ基準 1 / 5 / 8).
//
// The domain core (split-geometry / proposal / session) is covered in isolation
// under src/domain/knife. THIS test is the layer-crossing verification the lens
// flagged as missing: it mounts the REAL KnifeToolController over ONE session
// store and drives the whole knife flow through the actual UI —
//   - 受け入れ基準 1: tool select → target click (overlay + emphasis batch pushed)
//     → cut-point clicks → confirm cut splits the target into two (the COMPLETE
//     trigger is wired and fires — 教訓 5.7);
//   - 受け入れ基準 5: the継承先選択モーダル appears centered with the小さい方 boxed,
//     selecting a side highlights it, 確定 advances to非継承側プロパティ入力 (U23 form
//     re-used), and SAVE invokes the injected U13 process-start adapter (a logic
//     method existing but never called from the UI is caught here);
//   - 受け入れ基準 8: the transient session is discarded on EVERY exit path —
//     confirm→inheritor cancel→re-start, target→cut→tool switch→re-start, and the
//     provisional render batch is pushed to the sink and cleared on discard
//     (render 接続 + 教訓 5.2 全経路で破棄).
//
// Runs in jsdom (no Electron, no GUI): the renderer transform + draw sink are
// faked so the test is deterministic and non-interactive; the WIRING under test is
// the production component graph.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  PROCESS_STATUS,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { createLeafFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import {
  createShape,
  createTerritoryRing,
} from '../../domain/ring';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  KnifeToolController,
  type KnifeDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './KnifeToolController';

// --- Fixtures ---------------------------------------------------------------

type S = { tag: string };
const NEXT_STATE: S = { tag: 'committed' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'split',
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
const DEFAULT_COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const ANCHOR = timePointYearMonthDay(1000, 1, 1);

const TARGET_ID = asFeatureId('leaf');

/** A [0,10]² leaf feature + its store. */
function targetLeaf(): { feature: Feature; store: VertexStore } {
  const coords = [
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(0, 10),
  ];
  const vids = coords.map((_, i) => asVertexId(`tv-${i}`));
  const vertices = coords.map((coord, i) => createVertex(vids[i]!, coord));
  const ring = createTerritoryRing(asRingId('tr-0'), vids);
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape([ring]));
  return { feature, store: createVertexStore(vertices) };
}

// Identity screen→world so a click at (clientX, clientY) lands at world (x, y).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

let counter = 0;
const ids = () => ({
  nextFeatureId: () => asFeatureId(`nf-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
  nextRingId: () => asRingId(`nr-${counter++}`),
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly drawSink: KnifeDrawSink & { batches: number[] };
  readonly unmount: () => void;
}

function mountKnife(
  startResult: ProcessResult<S> = committed,
): Harness {
  const { feature, store: vstore } = targetLeaf();
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ProcessResult<S> => startResult);

  const batches: number[] = [];
  const drawSink: KnifeDrawSink & { batches: number[] } = {
    batches,
    drawKnife(prims) {
      batches.push(prims.length);
    },
  };

  const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
    fid === TARGET_ID ? feature : undefined;
  const resolveStore = (): VertexStore => vstore;
  // Clicking anywhere inside [0,10]² resolves the target; outside → miss.
  const featureAtPoint: FeatureAtPoint = (p) =>
    p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

  const utils = render(
    <KnifeToolController<S>
      store={store}
      startProcess={startProcess}
      ids={ids()}
      resolveFeature={resolveFeature}
      resolveStore={resolveStore}
      anchorTime={() => ANCHOR}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      targetShape={undefined}
      drawSink={drawSink}
      zoom={10}
      defaultColor={DEFAULT_COLOR}
    />,
  );

  return { store, startProcess, drawSink, unmount: utils.unmount };
}

function activateKnife(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditKnife);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('knife-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

// --- 受け入れ基準 1: target select + cut + confirm splits --------------------

describe('KnifeToolController — target select → cut → confirm (受け入れ基準 1)', () => {
  it('starting the tool shows the overlay batch and the select-target guide', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // The guide for SelectingTarget is shown (FR-92 日本語ガイド).
    expect(screen.getByTestId('knife-guide').textContent).toContain('末端地物を選択');
    // The render sink received at least one batch (overlay drawn; FR-90).
    expect(h.drawSink.batches.length).toBeGreaterThan(0);
    h.unmount();
  });

  it('clicking a leaf selects it, then cut points + confirm splits into two', () => {
    const h = mountKnife();
    activateKnife(h.store);

    // Select the target by clicking inside it.
    clickInput(5, 5);
    // Now drawing: place a vertical cut from below to above through x=5.
    clickInput(5, -5); // first point (outside, below)
    // A click at (5, 15) is outside the固定円 → a vertex add, not a close.
    clickInput(5, 15);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');

    // CONFIRM the cut (the COMPLETE trigger; 教訓 5.7) → 継承先選択モーダル appears.
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    h.unmount();
  });

  it('a non-piercing cut shows a Japanese rejection message and does not advance', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5); // select
    // Two points entirely below the square: does not pierce.
    clickInput(-5, -5);
    clickInput(15, -5);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    // No modal; a rejection message is shown (FR-90 / FR-115).
    expect(screen.queryByTestId('knife-inheritor-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('knife-message').textContent).toContain('貫く');
    h.unmount();
  });
});

// --- 受け入れ基準 5: inheritor modal + smaller-side preview + U13 ------------

describe('KnifeToolController — inheritor modal + save → U13 (受け入れ基準 5)', () => {
  function splitToModal(h: Harness): void {
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
  }

  it('the modal is centered, boxes the smaller side, and highlights the chosen side', () => {
    const h = mountKnife();
    splitToModal(h);
    expect(screen.getByTestId('knife-inheritor-modal-root')).toBeInTheDocument();
    expect(screen.getByTestId('knife-backdrop')).toBeInTheDocument();
    // The smaller-side preview box exists (FR-93 小さい方プレビュー).
    expect(screen.getByTestId('knife-smaller-box')).toBeInTheDocument();
    // Selecting side A highlights it (aria-pressed flips).
    fireEvent.click(screen.getByTestId('knife-choose-a'));
    expect(screen.getByTestId('knife-choose-a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('knife-choose-b')).toHaveAttribute('aria-pressed', 'false');
    h.unmount();
  });

  it('confirm inheritor → property form (U23 re-used) → save invokes U13', () => {
    const h = mountKnife();
    splitToModal(h);
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    // The U23 add property form is re-used for非継承側 props (FR-93 / 教訓 5.30).
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    // SAVE the form → the injected U13 adapter is called (受け入れ基準 5 / 教訓 5.7).
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

// --- 受け入れ基準 8: transient state discarded on every exit path ------------

describe('KnifeToolController — 一時状態全経路破棄 (受け入れ基準 8)', () => {
  it('inheritor cancel discards the session (modal gone; back to inactive chrome)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    expect(screen.getByTestId('knife-inheritor-dialog')).toBeInTheDocument();
    // Cancel from the modal → ALL transient state dropped (教訓 5.2).
    fireEvent.click(screen.getByTestId('knife-modal-cancel'));
    expect(screen.queryByTestId('knife-inheritor-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('switching away from the knife tool discards a cut in progress', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('1');
    // Tool switch → reset (教訓 5.2 (d)). The chrome disappears.
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    // The render sink got a final EMPTY batch on discard (overlay cleared).
    expect(h.drawSink.batches[h.drawSink.batches.length - 1]).toBe(0);
    // Re-activating starts a FRESH session (no carried-over cut points).
    activateKnife(h.store);
    clickInput(5, 5); // re-select target
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    h.unmount();
  });

  it('Escape cancels the in-progress cut (全経路破棄)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    h.unmount();
  });
});

// --- REGRESSION (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale) ----------
//
// ROOT BUG: App.tsx passed `zoom={rendererRef.current?.zoom() ?? 1}` to this
// controller — read ONCE at React render time. The App does not re-render on a
// pan/wheel (the live draw path bypasses React, 技術方針 2.3), so after the user
// zoomed, the固定円 world radius (circleRadiusPx / zoom) and the閉線スナップ判定 stayed
// frozen at the first-render zoom and drifted from what the user sees. ROOT FIX:
// App subscribes to store.camera.zoom (useStore) and the live render camera is
// mirrored into store.camera on EVERY change, so the zoom prop tracks the true zoom.
//
// This test reproduces the App wiring (a wrapper that feeds the controller
// `useStore(store, s => s.camera.zoom)`, exactly as App does) and proves the固定円
// 閉線判定 follows the LIVE store zoom: a fixed click distance from the first point
// CLOSES at low zoom (large world radius) but is treated as a頂点追加 at high zoom
// (small world radius) — i.e. the same gesture changes verdict purely because the
// store zoom changed, with NO re-mount.
describe('KnifeToolController — 固定円閉線判定 tracks the LIVE store camera zoom (回帰)', () => {
  // A wrapper mirroring App.tsx's wiring: the zoom prop is DERIVED from the live
  // store camera via useStore, so a store camera change re-renders the controller
  // with the new zoom (the exact contract the bug broke).
  function ZoomWiredKnife(props: {
    readonly store: StoreApi<SessionStore<S>>;
    readonly startProcess: ReturnType<typeof vi.fn>;
    readonly resolveFeature: (fid: typeof TARGET_ID) => Feature | undefined;
    readonly resolveStore: () => VertexStore;
    readonly featureAtPoint: FeatureAtPoint;
    readonly drawSink: KnifeDrawSink;
  }): JSX.Element {
    const zoom = useStore(props.store, (s) => s.camera.zoom);
    return (
      <KnifeToolController<S>
        store={props.store}
        startProcess={props.startProcess}
        ids={ids()}
        resolveFeature={props.resolveFeature}
        resolveStore={props.resolveStore}
        anchorTime={() => ANCHOR}
        screenToWorld={screenToWorld}
        featureAtPoint={props.featureAtPoint}
        targetShape={undefined}
        drawSink={props.drawSink}
        zoom={zoom}
        defaultColor={DEFAULT_COLOR}
      />
    );
  }

  function mountZoomWired(initialZoom: number): Harness {
    const { feature, store: vstore } = targetLeaf();
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: {
        mode: EDIT_MODE.Edit,
        activeTool: null,
        camera: {
          zoom: initialZoom,
          centerLon: 0,
          centerLat: 0,
          panX: 0,
          panY: 0,
        },
      },
    });
    const startProcess = vi.fn((): ProcessResult<S> => committed);
    const batches: number[] = [];
    const drawSink: KnifeDrawSink & { batches: number[] } = {
      batches,
      drawKnife(prims) {
        batches.push(prims.length);
      },
    };
    const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
      fid === TARGET_ID ? feature : undefined;
    const resolveStore = (): VertexStore => vstore;
    const featureAtPoint: FeatureAtPoint = (p) =>
      p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

    const utils = render(
      <ZoomWiredKnife
        store={store}
        startProcess={startProcess}
        resolveFeature={resolveFeature}
        resolveStore={resolveStore}
        featureAtPoint={featureAtPoint}
        drawSink={drawSink}
      />,
    );
    return { store, startProcess, drawSink, unmount: utils.unmount };
  }

  // The固定円 world radius is DEFAULT_KNIFE_STYLE.circleRadiusPx / zoom. We click a
  // fixed CLOSE_GAP degrees from the first point; it lands INSIDE the circle iff
  // CLOSE_GAP <= circleRadiusPx / zoom. With circleRadiusPx = 28 and CLOSE_GAP = 5:
  //   zoom = 1  → radius 28 ≥ 5 → INSIDE  → closes (cut-count stays 3)
  //   zoom = 20 → radius 1.4 < 5 → OUTSIDE → 頂点追加 (cut-count becomes 4)
  const CLOSE_GAP = 5;
  const FIRST = { lon: 5, lat: -2 };

  /** Select the target then place exactly 3 cut points (closeable count). */
  function drawThreePoints(): void {
    clickInput(5, 5); // select target (inside the square)
    clickInput(FIRST.lon, FIRST.lat); // first cut point
    clickInput(5, 12); // pierces upward
    clickInput(6, 12); // third point — now ≥ MIN_POINTS_TO_CLOSE
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('3');
  }

  it('at low zoom a near-first click CLOSES the line (no extra vertex)', () => {
    const h = mountZoomWired(1);
    activateKnife(h.store);
    drawThreePoints();
    // Click CLOSE_GAP degrees from the first point → inside the (radius 28) circle.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    // Closed: the line did NOT gain a vertex (count stays 3).
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('3');
    h.unmount();
  });

  it('at high zoom the SAME click is OUTSIDE the circle → 頂点追加 (not a close)', () => {
    const h = mountZoomWired(20);
    activateKnife(h.store);
    drawThreePoints();
    // Same gesture, but radius is now 1.4 deg → the click is outside → vertex add.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('4');
    h.unmount();
  });

  it('changing the LIVE store zoom mid-session flips the verdict (the stale-zoom bug)', () => {
    // Start zoomed OUT (radius 28): the gesture would close. Then zoom IN via the
    // store (camera mirror) — WITHOUT re-mounting — and the SAME gesture must now be
    // a頂点追加. Before the fix the controller held the first-render zoom and the
    // verdict never changed (the stale固定円).
    const h = mountZoomWired(1);
    activateKnife(h.store);
    drawThreePoints();

    // Zoom in on the LIVE store (the path the render-camera mirror drives in App).
    act(() => {
      h.store.getState().updateCamera({ zoom: 20 });
    });

    // The near-first click is now OUTSIDE the (radius 1.4) circle → vertex add.
    clickInput(FIRST.lon, FIRST.lat + CLOSE_GAP);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('4');
    h.unmount();
  });
});
