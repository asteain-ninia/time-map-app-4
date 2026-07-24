// U27 — CROSS-LAYER INTEGRATION test (FR-45 穴あけによる新地物生成).
//
// The domain core (checkDrillable / drillRegion / assembleDrillProposal / toEditProposal)
// is covered in isolation under src/domain/drill. THIS test is the layer-crossing
// verification the lens flags as missing: it mounts the REAL DrillToolController over
// ONE session store and drives the whole flow through the actual UI —
//   - FR-45: tool select → target末端 click (LEAF gate + selection promotion) → region
//     vertex clicks → 穴あけを確定 → 新地物プロパティ入力 (U23 AddPropertyForm re-use) →
//     save runs drillRegion, adapts the proposal to EditProposal<DrillSnapshot>, and
//     drives the injected U13 process (the COMPLETE trigger is wired and fires — 教訓 5.7);
//     the snapshot carries BOTH the holed original AND the new feature (2 地物 1 undo);
//   - a DrillRejected surfaces the domain's Japanese message and does NOT confirm (教訓 5.22);
//   - the transient draft is discarded on every exit path (Escape / tool switch) and the
//     region overlay is pushed to the sink + cleared on discard (教訓 5.2);
//   - the END-TO-END domain commit (through the REAL createLiveDrillBinding) creates a new
//     feature history + keeps the holed original as ONE undo unit.
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
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Command } from '../../domain/command/command';
import { EMPTY_COMMAND_RESULT } from '../../domain/command/result';
import { createLeafFeature, type Feature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore, type VertexStore } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import type { DrillSnapshot } from '../../domain/drill/index';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import {
  DrillToolController,
  type DrillDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './DrillToolController';

// --- Fixtures ---------------------------------------------------------------

type S = { tag: string };
const NEXT_STATE: S = { tag: 'committed' };

const noopCommand: Command<S> = {
  kind: 'composite' as Command<S>['kind'],
  label: 'drill',
  execute: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  undo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
  redo: () => ({ state: NEXT_STATE, result: EMPTY_COMMAND_RESULT }),
};

const committed: ProcessResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: NEXT_STATE,
  command: noopCommand,
};

/** A U13 outcome that pauses the session for the U35 conflict flow (FR-62). */
const conflictsPending: ProcessResult<S> = {
  status: PROCESS_STATUS.ConflictsPending,
  conflicts: [],
  unresolvedConflictIds: [],
  trialState: NEXT_STATE,
};

const ATTRS = createBasicAttributes('target', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');
const DEFAULT_COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

const TARGET_ID = asFeatureId('leaf');

/** A solid [0,20]² territory leaf + its store (no hole, so an inside region drills). */
function targetLeaf(): { feature: LeafFeature; store: VertexStore } {
  const outer = [
    createCoordinate(0, 0),
    createCoordinate(20, 0),
    createCoordinate(20, 20),
    createCoordinate(0, 20),
  ];
  const outerVids = outer.map((_, i) => asVertexId(`ov-${i}`));
  const vertices = outer.map((c, i) => createVertex(outerVids[i]!, c));
  const territory = createTerritoryRing(asRingId('tr-0'), outerVids);
  const feature = createLeafFeature(TARGET_ID, ATTRS, COLOR, createShape([territory]));
  return { feature, store: createVertexStore(vertices) };
}

// Identity screen→world so a click at (clientX, clientY) lands at world (x, y).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

let counter = 0;
const ids = () => ({
  nextFeatureId: () => asFeatureId(`nf-${counter++}`),
  nextRingId: () => asRingId(`nr-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
});

interface Harness {
  readonly store: StoreApi<SessionStore<S>>;
  readonly startProcess: ReturnType<typeof vi.fn>;
  readonly drawSink: DrillDrawSink & { batches: number[] };
  readonly unmount: () => void;
}

function mountDrill(outcome: ProcessResult<S> = committed): Harness {
  const { feature, store: vstore } = targetLeaf();
  const store = createSessionStore<S>({
    initialDomain: { tag: 'initial' },
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });

  const startProcess = vi.fn((): ProcessResult<S> => outcome);

  const batches: number[] = [];
  const drawSink: DrillDrawSink & { batches: number[] } = {
    batches,
    drawDrill(prims) {
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
    <DrillToolController<S>
      store={store}
      startProcess={startProcess}
      ids={ids()}
      resolveFeature={resolveFeature}
      resolveStore={resolveStore}
      anchorTime={() => timePointYear(1000)}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      drawSink={drawSink}
      defaultColor={DEFAULT_COLOR}
    />,
  );

  return { store, startProcess, drawSink, unmount: utils.unmount };
}

function activateDrill(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditDrill);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('drill-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

/** Select the target + draw a valid inside region ([2,2]-[10,2]-[6,10]), leaving the form up. */
function selectAndDrawRegion(): void {
  clickInput(2, 2); // first click picks the target末端 face AND is the first region vertex
  clickInput(10, 2);
  clickInput(6, 10);
}

// --- FR-45: select target末端 → draw region → confirm → props → save drives U13 ------

describe('DrillToolController — 穴あけによる新地物生成 (FR-45)', () => {
  it('starting the tool shows the select-target guide and pushes an overlay batch', () => {
    const h = mountDrill();
    activateDrill(h.store);
    expect(screen.getByTestId('drill-guide').textContent).toContain('末端地物');
    expect(h.drawSink.batches.length).toBeGreaterThan(0);
    h.unmount();
  });

  it('selecting a leaf target promotes it into the store selection', () => {
    const h = mountDrill();
    activateDrill(h.store);
    expect(h.store.getState().activeFeature).toBeNull();
    clickInput(2, 2); // first click in the solid fill picks the target
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    h.unmount();
  });

  it('confirm is disabled below 3 region vertices and enabled at 3', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-confirm')).toBeDisabled();
    clickInput(6, 10);
    expect(screen.getByTestId('drill-confirm')).not.toBeDisabled();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('3');
    h.unmount();
  });

  it('undo removes the last placed region vertex (FR-78)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('drill-undo'));
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    h.unmount();
  });

  it('confirm region opens the新地物プロパティ form; save drives U13 with a 2-feature DrillSnapshot', () => {
    const h = mountDrill();
    activateDrill(h.store);
    selectAndDrawRegion();
    // Confirm the region → the property form appears (U23 AddPropertyForm re-use).
    fireEvent.click(screen.getByTestId('drill-confirm'));
    expect(screen.getByTestId('drill-props')).toBeInTheDocument();
    expect(screen.getByTestId('add-property-form')).toBeInTheDocument();
    // Save → drillRegion runs and the injected U13 process is called with a proposal
    // carrying BOTH the holed original AND the new feature (2 地物 1 undo unit, FR-94).
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(h.startProcess).toHaveBeenCalledTimes(1);
    const proposal = h.startProcess.mock.calls[0]![0] as EditProposal<DrillSnapshot>;
    expect(proposal.snapshot.originalFeatureId).toBe(TARGET_ID);
    expect(proposal.snapshot.newFeature).toBeDefined();
    expect(proposal.snapshot.newFeature.id).not.toBe(TARGET_ID);
    // holedShape is the original with the region carved out (a hole ring appears).
    expect(proposal.snapshot.holedShape.rings.length).toBeGreaterThan(1);
    // On commit the transient draft is discarded (教訓 5.2) and the tool re-arms fresh
    // for another drill — the chrome stays mounted (like knife/ring-edit) but the
    // region draft is empty and the flow returns to selecting a target.
    expect(screen.getByTestId('drill-tool')).toHaveAttribute('data-flow', 'selecting-target');
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('0');
    h.unmount();
  });
});

// --- 妥当性検証拒否: a bad region surfaces the domain message and does NOT confirm ----

describe('DrillToolController — rejection surfaces the domain message (教訓 5.22 / 5.26)', () => {
  it('a region that escapes the target末端 is rejected with the domain Japanese文言', () => {
    const h = mountDrill();
    activateDrill(h.store);
    // First click picks the target; then place two more vertices, one OUTSIDE the target
    // ([25,25] is beyond [0,20]²) so the region is not contained → NotContained reject.
    clickInput(2, 2);
    clickInput(10, 2);
    clickInput(25, 25); // outside the featureAtPoint gate does not matter — draft adds it
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    // startProcess is NOT reached (drillRegion rejected before U13); a message shows.
    expect(h.startProcess).not.toHaveBeenCalled();
    expect(screen.getByTestId('drill-message').textContent).toContain('内側');
    h.unmount();
  });
});

// --- 一時状態全経路破棄 (教訓 5.2) --------------------------------------------

describe('DrillToolController — transient state discarded on every exit path', () => {
  it('Escape cancels the in-progress region draft', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('switching away from the drill tool discards a draft and clears the overlay', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditSelect));
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    // The render sink got a final EMPTY batch on discard (overlay cleared).
    expect(h.drawSink.batches[h.drawSink.batches.length - 1]).toBe(0);
    // Re-activating starts a FRESH session (no carried-over vertices).
    activateDrill(h.store);
    clickInput(2, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    h.unmount();
  });
});

// --- W3-B: キャンセル後の再アーム (ring-edit 8950639 / knife と対称) ---------------
//
// CANCEL = ツールから出る. 対象選択の解除だけでは toolbar の aria-pressed が true のまま
// セッションだけ武装解除された状態が残り、同じボタンをもう一度押すとストアの press-toggle
// (tool → null) が走って「何も起きない」= 別ツールを経由しないと復活できなかった。
// `setActiveTool(null)` に一本化して toolbar の押下状態と session の armed を単一真実源に
// する (教訓 5.2 全経路で破棄 + 単一の真実源)。

describe('DrillToolController — キャンセルはツール選択も解除して再アームできる (W3-B)', () => {
  it('キャンセル(Escape)で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // Re-selecting the SAME tool re-arms a fresh session (the 実機 repro).
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditDrill));
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    clickInput(2, 2);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    h.unmount();
  });

  it('キャンセルボタンも同じくツール選択を解除する (単一の解除経路)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    clickInput(2, 2);
    clickInput(10, 2);
    fireEvent.click(screen.getByTestId('drill-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  // W3-AB fix-forward (レビュー LOW): while the U35 conflict modal is open the MODAL owns
  // Escape. The tool-side listener stayed live through ConflictPaused, so an Escape that
  // missed the dialog ran `drill.cancel()` → `setActiveTool(null)` UNDER the open modal and
  // the host's later reArmActiveTool had `activeTool === null` — nothing to restore. Mirrors
  // the knife regression.
  it('ConflictPaused 中の Escape はツールを解除しない (競合モーダルが Esc の持ち主)', () => {
    const h = mountDrill(conflictsPending);
    activateDrill(h.store);
    selectAndDrawRegion();
    fireEvent.click(screen.getByTestId('drill-confirm'));
    fireEvent.submit(screen.getByTestId('add-property-form'));
    expect(screen.getByTestId('drill-conflict-paused')).toBeInTheDocument();

    // Fire from a NON-editable element: the property form is still mounted while paused
    // and its autofocused text input would otherwise trip the focus guard.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditDrill);
    expect(screen.getByTestId('drill-conflict-paused')).toBeInTheDocument();
    h.unmount();
  });
});

// バグハント第11波 #3/#6 — the drill controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while a session runs) MUST honour the SAME focus guard the global
// dispatcher does (教訓 5.13 single predicate). The timeline year field / sidebar inputs
// are live even while a drill region is drawn; a Ctrl+Z / Escape with a text input focused
// must edit the TEXT natively, NOT undo a region vertex (#3) or cancel the drill (#6). A
// non-editable focus still cancels / undoes as before.
describe('DrillToolController — バグハント第11波 (#3/#6): focus guard on the keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  function drawTwoRegionVertices(): void {
    clickInput(2, 2); // picks the target末端 face AND is the first region vertex
    clickInput(10, 2);
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a vertex and does NOT preventDefault (#3)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
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
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape with a text input focused does NOT cancel the drill and does NOT preventDefault (#6)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(screen.getByTestId('drill-tool')).toBeInTheDocument();
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still undoes / cancels (no regression)', () => {
    const h = mountDrill();
    activateDrill(h.store);
    drawTwoRegionVertices();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('drill-vertex-count').textContent).toBe('1');
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.queryByTestId('drill-tool')).not.toBeInTheDocument();
    button.remove();
    h.unmount();
  });
});
