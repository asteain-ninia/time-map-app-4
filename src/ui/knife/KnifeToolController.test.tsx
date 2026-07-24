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
      drawSink={drawSink}
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

  it('HB3-6/18: selecting a leaf target promotes it into the store selection', () => {
    const h = mountKnife();
    activateKnife(h.store);
    // Activating the knife tool runs the reset契約 → no selection yet.
    expect(h.store.getState().activeFeature).toBeNull();
    // Clicking inside the target leaf selects it AND promotes it into the store
    // selection (so the target is highlighted + drawn in the selection color).
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    h.unmount();
  });

  it('HB3-6/18 review: cancel (Escape) clears the promoted target selection (no leak)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    // Escape → knife.cancel() → onCancelled → clearSelection: the cancelled target must
    // NOT linger as the selection (else it stays highlighted + Delete-able).
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(h.store.getState().activeFeature).toBeNull();
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
    // Selecting piece 0 highlights it (aria-pressed flips); HB3-5/19 index-based.
    fireEvent.click(screen.getByTestId('knife-choose-0'));
    expect(screen.getByTestId('knife-choose-0')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('knife-choose-1')).toHaveAttribute('aria-pressed', 'false');
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

// --- W3-B: キャンセル後の再アーム (ring-edit 8950639 と対称) ---------------------
//
// CANCEL = ツールから出る. 対象選択の解除だけでは toolbar の aria-pressed が true のまま
// セッションだけ武装解除された状態が残り、同じボタンをもう一度押すとストアの press-toggle
// (tool → null) が走って「何も起きない」= 別ツールを経由しないと復活できなかった。
// `setActiveTool(null)` に一本化して toolbar の押下状態と session の armed を単一真実源に
// する (教訓 5.2 全経路で破棄 + 単一の真実源)。ring-edit と同じ規約。

describe('KnifeToolController — キャンセルはツール選択も解除して再アームできる (W3-B)', () => {
  it('キャンセル(Escape)で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // Re-selecting the SAME tool re-arms a fresh session (the 実機 repro: the user
    // pressed the same button again and nothing happened).
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditKnife));
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    clickInput(5, 5);
    expect(h.store.getState().activeFeature).toBe(TARGET_ID);
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('0');
    h.unmount();
  });

  it('分断線キャンセルボタンも同じくツール選択を解除する (単一の解除経路)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    fireEvent.click(screen.getByTestId('knife-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('継承先モーダルのキャンセルも同じ経路 (再アーム可能)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-modal-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditKnife));
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    h.unmount();
  });

  // W3-AB fix-forward (レビュー LOW): while the U35 conflict modal is open the MODAL owns
  // Escape (its own useModalKeydown → onConflictCancel → the host's reArmActiveTool). The
  // tool-side Escape listener stayed live through ConflictPaused, so an Escape that missed
  // the dialog's React handler ran `knife.cancel()` → `setActiveTool(null)` UNDER the still
  // open modal; the later reArmActiveTool then read `activeTool === null` and toggled
  // null→null, so the tool never came back after the conflict was resolved.
  it('ConflictPaused 中の Escape はツールを解除しない (競合モーダルが Esc の持ち主)', () => {
    const h = mountKnife(conflictsPending);
    activateKnife(h.store);
    clickInput(5, 5);
    clickInput(5, -5);
    clickInput(5, 15);
    fireEvent.click(screen.getByTestId('knife-confirm-cut'));
    fireEvent.click(screen.getByTestId('knife-confirm-inheritor'));
    fireEvent.click(screen.getByTestId('add-save'));
    expect(screen.getByTestId('knife-conflict-paused')).toBeInTheDocument();

    // Fire from a NON-editable element: the 非継承側 form is still mounted (the session
    // stays in EnteringProperties while paused) and its autofocused text input would
    // otherwise trip the focus guard, masking the listener entirely.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    // The session stays paused and the tool stays armed, so the host's reArmActiveTool
    // (which reads `activeTool` at conflict close) still has a tool to restore.
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditKnife);
    expect(screen.getByTestId('knife-conflict-paused')).toBeInTheDocument();
    h.unmount();
  });
});

// バグハント第11波 #3/#6 — the knife controller's OWN window keydown listener (Escape /
// Ctrl+Z, live while a session runs) MUST honour the SAME focus guard the global
// dispatcher does (教訓 5.13 single predicate). The timeline year field / sidebar inputs
// are live even while a cut is drawn; a Ctrl+Z / Escape with a text input focused must
// edit the TEXT natively, NOT undo a cut point (#3) or cancel the knife (#6). A
// non-editable focus still cancels / undoes as before.
describe('KnifeToolController — バグハント第11波 (#3/#6): focus guard on the keydown listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  /** Select the target + place 2 cut points (DrawingCut, count = 2). */
  function drawTwoCutPoints(): void {
    clickInput(5, 5); // select target
    clickInput(5, -5); // first cut point
    clickInput(5, 15); // second cut point (outside the固定円 → vertex add)
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
  }

  it('Ctrl+Z with a text input focused does NOT undo a cut point and does NOT preventDefault (#3)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
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
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape with a text input focused does NOT cancel the knife and does NOT preventDefault (#6)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The knife session is still up (not cancelled) with its 2 cut points.
    expect(screen.getByTestId('knife-tool')).toBeInTheDocument();
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('2');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape / Ctrl+Z from a NON-editable focus still undoes / cancels (no regression)', () => {
    const h = mountKnife();
    activateKnife(h.store);
    drawTwoCutPoints();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    // Ctrl+Z undoes one cut point (2 → 1).
    act(() => fireEvent.keyDown(button, { key: 'z', ctrlKey: true }));
    expect(screen.getByTestId('knife-cut-count').textContent).toBe('1');
    // Escape cancels the whole knife.
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.queryByTestId('knife-tool')).not.toBeInTheDocument();
    button.remove();
    h.unmount();
  });
});

// --- REGRESSION (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale) ----------
//
// ROOT BUG (bughunt): App.tsx passed `zoom={rendererRef.current?.zoom() ?? 1}` to
// this controller — read ONCE at React render time. The App does not re-render on a
// pan/wheel (the live draw path bypasses React, 技術方針 2.3), so after the user
// zoomed, the固定円 world radius (circleRadiusPx / zoom) and the閉線スナップ判定 stayed
// frozen at the first-render zoom and drifted from what the user sees.
//
// ROOT FIX (bughunt2): the controller SUBSCRIBES to store.camera.zoom INTERNALLY
// (useStore over its own `store` prop), so the zoom is no longer lifted to App and
// threaded down as a prop — lifting it put the zoom scalar on the App render path,
// re-rendering every overlay sibling once per wheel notch. The live render camera is
// still mirrored into store.camera on EVERY change, so the internal subscription sees
// the true zoom, but a wheel notch now re-renders ONLY this controller.
//
// This test proves the固定円閉線判定 follows the LIVE store zoom: a fixed click distance
// from the first point CLOSES at low zoom (large world radius) but is treated as a
// 頂点追加 at high zoom (small world radius) — i.e. the same gesture changes verdict
// purely because the store zoom changed, with NO re-mount.
describe('KnifeToolController — 固定円閉線判定 tracks the LIVE store camera zoom (回帰)', () => {
  // bughunt2: the controller now SUBSCRIBES to store.camera.zoom INTERNALLY (the
  // zoom scalar is no longer lifted to App / threaded as a prop — that put it on
  // the App render path and re-rendered every overlay sibling per wheel notch). So
  // the controller is rendered DIRECTLY here; a store camera change must re-render
  // it on its own and flip the固定円 verdict, with NO wrapper and NO re-mount.
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
      <KnifeToolController<S>
        store={store}
        startProcess={startProcess}
        ids={ids()}
        resolveFeature={resolveFeature}
        resolveStore={resolveStore}
        anchorTime={() => ANCHOR}
        screenToWorld={screenToWorld}
        featureAtPoint={featureAtPoint}
          drawSink={drawSink}
        defaultColor={DEFAULT_COLOR}
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

// --- REGRESSION (bughunt2: per-wheel-notch App re-render re-rendered ALL overlay
// controllers) ----------------------------------------------------------------
//
// ROOT BUG: App lifted the zoom subscription (useStore(store, s => s.camera.zoom))
// to its OWN body and threaded it to KnifeToolController as a `zoom` prop. Because
// the render-camera mirror writes a NEW store.camera.zoom on every wheel notch, that
// App-level subscription re-rendered App — and with it the ENTIRE overlay subtree
// (AddTool / Knife / FileOps / HelpTools / conflict modal) — once per notch, a
// partial regression of 技術方針 2.3 (the live draw path must bypass React).
//
// ROOT FIX: the zoom subscription moved INTO KnifeToolController (its only consumer).
// A wheel notch now re-renders ONLY the knife controller, NOT its overlay siblings.
//
// This test reproduces the App overlay shape: the knife controller mounted ALONGSIDE
// a sibling overlay that does NOT read camera.zoom. A store zoom change must re-render
// the knife controller (proven by the固定円 verdict tests above) WITHOUT re-rendering
// the sibling. Before the fix the shared App parent re-rendered, so the sibling's
// render count climbed per notch; after the fix it stays put.
describe('KnifeToolController — a wheel-notch zoom change does NOT re-render overlay siblings (回帰 bughunt2)', () => {
  it('the zoom subscription is local to the knife controller (sibling render count is flat)', () => {
    const { feature, store: vstore } = targetLeaf();
    const store = createSessionStore<S>({
      initialDomain: { tag: 'initial' },
      initial: {
        mode: EDIT_MODE.Edit,
        activeTool: null,
        camera: { zoom: 1, centerLon: 0, centerLat: 0, panX: 0, panY: 0 },
      },
    });
    const startProcess = vi.fn((): ProcessResult<S> => committed);
    const drawSink: KnifeDrawSink = { drawKnife() {} };
    const resolveFeature = (fid: typeof TARGET_ID): Feature | undefined =>
      fid === TARGET_ID ? feature : undefined;
    const resolveStore = (): VertexStore => vstore;
    const featureAtPoint: FeatureAtPoint = (p) =>
      p.lon >= 0 && p.lon <= 10 && p.lat >= 0 && p.lat <= 10 ? TARGET_ID : null;

    // A sibling overlay that subscribes to the SAME store but NOT to camera.zoom
    // (it reads mode, like the real AddTool / FileOps / HelpTools controllers). Its
    // render count is the regression probe: it must NOT climb on a zoom-only change.
    let siblingRenders = 0;
    function SiblingOverlay(): JSX.Element {
      useStore(store, (s) => s.mode);
      siblingRenders += 1;
      return <div data-testid="sibling-overlay" />;
    }

    const utils = render(
      <>
        <SiblingOverlay />
        <KnifeToolController<S>
          store={store}
          startProcess={startProcess}
          ids={ids()}
          resolveFeature={resolveFeature}
          resolveStore={resolveStore}
          anchorTime={() => ANCHOR}
          screenToWorld={screenToWorld}
          featureAtPoint={featureAtPoint}
              drawSink={drawSink}
          defaultColor={DEFAULT_COLOR}
        />
      </>,
    );

    activateKnife(store); // a real overlay state change — both may render here
    const baseline = siblingRenders;

    // Spin the wheel: 5 notch-equivalent zoom writes through the live camera mirror.
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        store.getState().updateCamera({ zoom: 1 + (i + 1) * 0.25 });
      }
    });

    // The sibling did NOT re-render on any of the zoom-only notches (the bug made it
    // climb by 5 because the shared App parent re-rendered each time).
    expect(siblingRenders).toBe(baseline);
    utils.unmount();
  });
});
