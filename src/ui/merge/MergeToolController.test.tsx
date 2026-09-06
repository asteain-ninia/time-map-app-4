// U30 — CROSS-LAYER INTEGRATION test (bughunt3: merge-no-reduction 回帰防止).
//
// REGRESSION CONTEXT (bughunt3): the 結合 (merge, edit.merge) toolbar tool was a DEAD
// button — it armed (aria-pressed toggled) but performed NO action. The whole
// src/domain/merge core (buildMergeProposal / MergeProposal / precondition / decision /
// command) was unit-tested but UNREACHABLE: NO UI consumed it (教訓 5.7「ロジックがあっても
// UI から呼ばれず機能しない」). Clicking two adjacent split-sibling faces left the feature
// count unchanged (9→9). The fix wired the missing消費する ui コンシューマ —
// {@link MergeToolController} + {@link useMergeTool} + the LIVE U13 merge binding
// (createLiveMergeBinding) + U44's applyMergeProposal — so 結合 actually folds the
// selected faces into one.
//
// THIS test mounts the REAL MergeToolController over ONE session store wired to the
// REAL createLiveMergeBinding (the production graph, no stub U13), drives the whole
// merge flow through the actual UI, and asserts the committed project's effective
// feature count DROPS (the exact reduction the dead button never produced). Runs in
// jsdom: the renderer transform + featureAtPoint are faked so the test is deterministic;
// the WIRING + the domain pipeline under test are production code.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import { createGeoParams } from '../../domain/geo/geo-params';
import { applyAddProposal } from '../../domain/editing/apply-proposal';

import { createSessionStore, TIME_CHANGE_SOURCE, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { OptionBar } from '../shell/OptionBar';
import { OptionBarStore } from '../shell/option-bar';
import { TOOL_ID } from '../shell/tools';
import { AppShell } from '../shell';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';
import {
  createLiveMergeBinding,
  type DomainRoot,
} from '../consistency-binding';
import { featuresAt, verticesAt, leafShapeAt } from '../live-lookup';
import { createSharedIdMint } from '../App';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';

import type { DrawPrimitive } from '../../render/map-renderer';
import { DEFAULT_MERGE_TARGET_STYLE } from '../../render/reaffiliation-batch';

import {
  MergeToolController,
  type ScreenToWorld,
  type FeatureAtPoint,
  type MergeDrawSink,
  type ResolveLeafShape,
} from './MergeToolController';
import { MERGE_STRINGS } from './strings';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const ANCHOR = timePointYear(1000);

function emptyProject(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

/** An axis-aligned [ox,ox+w]×[0,2] leaf + its vertices. */
function rectLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  w: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [ox, 0],
    [ox + w, 0],
    [ox + w, 2],
    [ox, 2],
  ];
  return leafFromCorners(idRaw, vPrefix, corners);
}

/** Build a single-territory leaf from explicit [lon, lat] corners. */
function leafFromCorners(
  idRaw: string,
  vPrefix: string,
  corners: readonly (readonly number[])[],
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 1000, 1000),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

/** A project with TWO edge-adjacent leaves (share the x=2 boundary) at year 1000. */
function twoAdjacentLeaves(): DomainRoot {
  const a = rectLeaf('leaf-a', 'va', 0, 2); // [0,2]×[0,2]
  const b = rectLeaf('leaf-b', 'vb', 2, 2); // [2,4]×[0,2] — adjacent on x=2
  let project = applyAddProposal(emptyProject(), {
    featureId: a.feature.id,
    anchorTime: ANCHOR,
    snapshot: { feature: a.feature, vertices: a.vertices, sharedCandidateIds: new Map() },
  });
  project = applyAddProposal(project, {
    featureId: b.feature.id,
    anchorTime: ANCHOR,
    snapshot: { feature: b.feature, vertices: b.vertices, sharedCandidateIds: new Map() },
  });
  return project;
}

/**
 * 経度 [-170,0] と [0,170] に広がる、辺を接した 2 つの横長の面 (緯度は [0,2])。途中に頂点が
 * あるのでどちらも 1 辺は 90 度以下 ―― それぞれ単体では保存できる。だが論理和は一直線上に
 * 並ぶ途中の頂点を落とすので、結合後の上下の辺が「1 本で 340 度」に化ける (N-51)。
 */
function twoWideLeaves(): DomainRoot {
  const a = leafFromCorners('leaf-a', 'va', [
    [-170, 0],
    [-90, 0],
    [0, 0],
    [0, 2],
    [-90, 2],
    [-170, 2],
  ]);
  const b = leafFromCorners('leaf-b', 'vb', [
    [0, 0],
    [90, 0],
    [170, 0],
    [170, 2],
    [90, 2],
    [0, 2],
  ]);
  let project = applyAddProposal(emptyProject(), {
    featureId: a.feature.id,
    anchorTime: ANCHOR,
    snapshot: { feature: a.feature, vertices: a.vertices, sharedCandidateIds: new Map() },
  });
  project = applyAddProposal(project, {
    featureId: b.feature.id,
    anchorTime: ANCHOR,
    snapshot: { feature: b.feature, vertices: b.vertices, sharedCandidateIds: new Map() },
  });
  return project;
}

// Identity screen→world so a click at (clientX, clientY) lands at world (lon, lat).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

interface Harness {
  readonly store: StoreApi<SessionStore<DomainRoot>>;
  /** The LAST highlight batch the controller pushed to the render sink (HB3-15(c)). */
  readonly lastHighlight: () => readonly DrawPrimitive[];
  /** オプションバー（設計書 §C.4）。対象欄への押し込みを見るために持たせる。 */
  readonly optionBar: OptionBarStore;
  readonly unmount: () => void;
}

/** 隣り合う 2 面 ([0,2]² と [2,4]×[0,2]) 用の当たり判定 (本番の leafAtPoint の代役)。 */
const adjacentFeatureAtPoint: FeatureAtPoint = (p) => {
  if (p.lat < 0 || p.lat > 2) return null;
  if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
  if (p.lon > 2 && p.lon <= 4) return asFeatureId('leaf-b');
  return null;
};

/** 横長の 2 面 ([-170,0] と [0,170]) 用の当たり判定。 */
const wideFeatureAtPoint: FeatureAtPoint = (p) => {
  if (p.lat < 0 || p.lat > 2) return null;
  if (p.lon >= -170 && p.lon < 0) return asFeatureId('leaf-a');
  if (p.lon >= 0 && p.lon <= 170) return asFeatureId('leaf-b');
  return null;
};

function mountMerge(
  project: DomainRoot = twoAdjacentLeaves(),
  featureAtPoint: FeatureAtPoint = adjacentFeatureAtPoint,
): Harness {
  const store = createSessionStore<DomainRoot>({
    initialDomain: project,
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });
  // Park the timeline at the leaves' anchor year so they are effective (the merge
  // anchor time the controller reads = store.currentTime).
  act(() => {
    store.getState().setCurrentTime(ANCHOR, TIME_CHANGE_SOURCE.Slider);
  });

  // The SHARED id minter (the SAME factory App uses) over the live root, so merge-minted
  // ids never collide with loaded ones (教訓 5.37).
  const mint = createSharedIdMint(() => store.getState().domain);
  const ids = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  // The REAL live U13 merge binding (production pipeline; applyMergeProposal under it).
  const live = createLiveMergeBinding({
    getRoot: () => store.getState().domain,
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  });

  const resolveFeatures = () => featuresAt(store.getState().domain, store.getState().currentTime);
  const resolveStore = () => verticesAt(store.getState().domain, store.getState().currentTime);

  // The per-click leaf hit-test (HB3-16: this mirrors the live `leafAtPoint` port — an
  // INDIVIDUAL leaf is resolved per click). Injected so a fixture with a different
  // layout (横長の 2 面) can supply its own.

  // HB3-15(c): the live leaf-shape resolver (the SAME live-lookup the App bootstrap uses).
  const resolveLeafShape: ResolveLeafShape = (id) =>
    leafShapeAt(store.getState().domain, store.getState().currentTime, id) ?? undefined;

  // Capture the highlight batch the controller pushes on every selection change.
  let highlight: readonly DrawPrimitive[] = [];
  const drawSink: MergeDrawSink = {
    drawHighlight(primitives): void {
      highlight = primitives;
    },
  };

  // On commit, record the committed project back into the store (the SAME single
  // store-write App's recordCommit performs — applyCommandResult swaps the domain).
  const onCommitted = (result: ProcessResult<DomainRoot>): void => {
    if (result.status !== PROCESS_STATUS.Committed) return;
    const outcome = result.command.execute(store.getState().domain);
    act(() => {
      store.getState().applyCommandResult(outcome.state, outcome.result);
    });
  };

  // オプションバー（設計書 §C.4）。本番の合成ルートでは `ToolOptionBar` が持っている
  // 同じ帯を渡す（この道具は持たずに対象欄だけを押し込む）。
  const optionBar = new OptionBarStore();

  // **増分 5d: 確定の列はオプションバーの確定欄に出る**（地図の上には無い）。
  // 帯そのものを一緒に載せないと確定ボタンが DOM に現れない ―― 検査の都合ではなく、
  // **実物がそうなっている**ということである。
  const utils = render(
    <>
      <OptionBar store={optionBar} />
      <MergeToolController<DomainRoot>
        store={store}
        startProcess={live.startProcess}
        ids={ids}
        resolveFeatures={resolveFeatures}
        resolveStore={resolveStore}
        anchorTime={() => store.getState().currentTime}
        screenToWorld={screenToWorld}
        featureAtPoint={featureAtPoint}
        resolveLeafShape={resolveLeafShape}
        drawSink={drawSink}
        optionBar={optionBar}
        onCommitted={onCommitted}
      />
    </>,
  );

  return { store, lastHighlight: () => highlight, optionBar, unmount: utils.unmount };
}

function activateMerge(store: StoreApi<SessionStore<DomainRoot>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditMerge);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('merge-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

function effectiveCount(store: StoreApi<SessionStore<DomainRoot>>): number {
  return featuresAt(store.getState().domain, store.getState().currentTime).length;
}

describe('MergeToolController — 結合 actually merges (bughunt3 merge-no-reduction 回帰防止)', () => {
  it('arming the tool shows the select guide and the disabled confirm button', () => {
    const h = mountMerge();
    activateMerge(h.store);
    expect(screen.getByTestId('merge-guide').textContent).toContain('2 つ以上');
    // Confirm is disabled with fewer than 2 targets.
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();
    h.unmount();
  });

  it('clicking two adjacent faces then 結合を確定 → options dialog → 結合を実行 folds them into ONE (count 2→1)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    expect(effectiveCount(h.store)).toBe(2);

    // Toggle both adjacent leaves into the target set.
    clickInput(1, 1); // leaf-a
    clickInput(3, 1); // leaf-b
    expect(screen.getByTestId('merge-target-count').textContent).toBe('2');
    // With 2 valid, non-vertically-related targets present at the time, confirm enables.
    expect(screen.getByTestId('merge-confirm')).not.toBeDisabled();

    // CONFIRM opens the FR-52 options dialog (it no longer commits directly).
    fireEvent.click(screen.getByTestId('merge-confirm'));
    expect(screen.getByTestId('merge-options-dialog')).toBeInTheDocument();

    // Accept the seeded defaults (親なし + inherit-first) and run → count drops.
    fireEvent.click(screen.getByTestId('merge-options-confirm'));
    expect(effectiveCount(h.store)).toBe(1);
    h.unmount();
  });

  it('clicking the same face twice toggles it OUT (no merge possible with <2)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1); // add leaf-a
    clickInput(1, 1); // remove leaf-a
    expect(screen.getByTestId('merge-target-count').textContent).toBe('0');
    expect(screen.getByTestId('merge-confirm')).toBeDisabled();
    h.unmount();
  });

  it('toggled targets render a tool-specific highlight; clearing empties it (HB3-15(c))', () => {
    const h = mountMerge();
    activateMerge(h.store);
    // No targets yet → an empty highlight frame (教訓 5.18).
    expect(h.lastHighlight()).toEqual([]);

    // Toggle both adjacent leaves: each picked LEAF (HB3-16) gets an emphasis shape in the
    // merge tool colour, so the user SEES the chosen targets even when aggregated.
    clickInput(1, 1); // leaf-a
    clickInput(3, 1); // leaf-b
    const shapes = h.lastHighlight().filter((p) => p.kind === 'shape');
    expect(shapes).toHaveLength(2);
    for (const s of shapes) {
      expect(s.kind).toBe('shape');
      if (s.kind === 'shape') expect(s.fill).toBe(DEFAULT_MERGE_TARGET_STYLE.fill);
    }

    // Untoggling one leaf drops its highlight (single truth: highlight == selection).
    clickInput(1, 1); // remove leaf-a
    expect(h.lastHighlight().filter((p) => p.kind === 'shape')).toHaveLength(1);
    h.unmount();
  });

  it('leaving the merge tool discards the transient target set (教訓 5.2 全経路で破棄)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('merge-target-count').textContent).toBe('1');
    // Switch to another edit tool: the controller unmounts its chrome (idle).
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditSelect);
    });
    expect(screen.queryByTestId('merge-tool')).not.toBeInTheDocument();
    // Re-arming starts fresh with no leaked targets.
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditMerge);
    });
    expect(screen.getByTestId('merge-target-count').textContent).toBe('0');
    h.unmount();
  });
});

// --- W3-AB fix-forward: キャンセル後の再アーム (knife / drill / ring-edit と対称) --------
//
// W3-B は knife / drill を ring-edit と同じ `setActiveTool(null)` に揃えたが merge /
// reparent は `onCancelled` フックすら持たず、cancel が `reset(Idle)` だけだった。
// コントローラは Idle で `return null` なので、キャンセル後は **activeTool が EditMerge の
// まま(toolbar は aria-pressed=true)でセッションだけ消える** — 同じボタンをもう一度押すと
// ストアの press-toggle が tool→null を走らせて「何も起きない」。knife/drill で潰したのと
// 完全に同一の dead-button バグが 2 ツールに残っていた (規約が 5 ツール中 3 でしか成立して
// いなかった)。
describe('MergeToolController — キャンセルはツール選択も解除して再アームできる (W3-AB)', () => {
  // **増分 5 の手直し B1: 道具を降りるのは［やめる］ボタンだけになった。** Escape は
  // 1 回で 1 段戻る階段で、道具を降りるのは大域の階段のいちばん下（設計書 §D.4）。
  // ここが固定したいのは「取りやめたあと同じボタンをもう一度押せば構え直せる」ことである。
  it('キャンセル（［やめる］）で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('merge-target-count').textContent).toBe('1');

    act(() => {
      fireEvent.click(screen.getByTestId('merge-cancel'));
    });
    expect(screen.queryByTestId('merge-tool')).not.toBeInTheDocument();
    // The toolbar's aria-pressed mirrors `activeTool`; it must NOT stay pressed.
    expect(h.store.getState().activeTool).toBeNull();

    // 実機 repro: the user pressed the SAME button again and nothing happened.
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditMerge));
    expect(screen.getByTestId('merge-tool')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-count').textContent).toBe('0');
    h.unmount();
  });

  it('キャンセルボタンも同じ経路 (単一の解除経路)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    fireEvent.click(screen.getByTestId('merge-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('merge-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('FR-52 ダイアログの取消 (cancelChoose) はツールを解除しない (対象選択へ戻るだけ)', () => {
    // cancelChoose は「セッションを畳む」ではなく「選択へ戻る」なので cancel とは別経路。
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    clickInput(3, 1);
    fireEvent.click(screen.getByTestId('merge-confirm'));
    expect(screen.getByTestId('merge-options-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('merge-options-cancel'));
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditMerge);
    expect(screen.getByTestId('merge-target-count').textContent).toBe('2');
    h.unmount();
  });
});

// bughunt-review — the e63c8b9 global-shortcut suspension MISSED the merge flow. The
// FR-52 MergeOptionsDialog (opened at MERGE_FLOW.Choosing) is a real keyboard-owning
// modal that handles ONLY Esc via React onKeyDown, transparent to the global window
// keydown listener. Without the controller reporting onDrawingChange(true), a global
// Ctrl+Z would fire EditUndo straight THROUGH the open dialog and undo the last
// committed domain op. This block mounts the REAL production graph (AppShell wiring
// useShortcuts + MergeToolController) over ONE store, with the host derivation
// (suspended = mergeDrawing) the App uses, plus a live EditUndo on the SAME registry
// the shell dispatches — the exact production mechanism, no stand-in for the suspension.
describe('MergeToolController bughunt-review: Ctrl+Z does NOT leak through the merge flow', () => {
  function mountWithGlobalUndo(): {
    store: StoreApi<SessionStore<DomainRoot>>;
    globalUndo: ReturnType<typeof vi.fn>;
  } {
    const store = createSessionStore<DomainRoot>({
      initialDomain: twoAdjacentLeaves(),
      initial: { mode: EDIT_MODE.Edit, activeTool: null },
    });
    act(() => {
      store.getState().setCurrentTime(ANCHOR, TIME_CHANGE_SOURCE.Slider);
    });

    const registry = new CommandRegistry();
    const globalUndo = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run: globalUndo });

    const mint = createSharedIdMint(() => store.getState().domain);
    const ids = {
      nextFeatureId: () => asFeatureId(mint('f')),
      nextVertexId: () => asVertexId(mint('v')),
      nextRingId: () => asRingId(mint('r')),
    };
    const live = createLiveMergeBinding({
      getRoot: () => store.getState().domain,
      nextVertexId: ids.nextVertexId,
      nextRingId: ids.nextRingId,
    });
    const resolveFeatures = () =>
      featuresAt(store.getState().domain, store.getState().currentTime);
    const resolveStore = () =>
      verticesAt(store.getState().domain, store.getState().currentTime);
    const featureAtPoint: FeatureAtPoint = (p) => {
      if (p.lat < 0 || p.lat > 2) return null;
      if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
      if (p.lon > 2 && p.lon <= 4) return asFeatureId('leaf-b');
      return null;
    };

    // Mirror the App.tsx host wiring: hold the merge-drawing flag, thread it as
    // `suspended` into AppShell, and feed the controller's onDrawingChange back into it.
    // **増分 5d: 確定の列はオプションバーの確定欄に出る**ので、シェルの
    // `optionBar` スロットへ帯を載せる（本番の合成ルートと同じ形）。
    const optionBar = new OptionBarStore();
    function Host(): JSX.Element {
      const [mergeDrawing, setMergeDrawing] = useState(false);
      return (
        <AppShell
          store={store}
          registry={registry}
          suspended={mergeDrawing}
          optionBar={<OptionBar store={optionBar} />}
          overlay={
            <MergeToolController<DomainRoot>
              store={store}
              optionBar={optionBar}
              startProcess={live.startProcess}
              ids={ids}
              resolveFeatures={resolveFeatures}
              resolveStore={resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={featureAtPoint}
              onDrawingChange={setMergeDrawing}
            />
          }
        />
      );
    }
    render(<Host />);
    return { store, globalUndo };
  }

  it('the global EditUndo never fires while the MergeOptionsDialog is open', () => {
    const { store, globalUndo } = mountWithGlobalUndo();
    activateMerge(store);

    // Pick two adjacent leaves and open the FR-52 options dialog (Choosing).
    clickInput(1, 1); // leaf-a
    clickInput(3, 1); // leaf-b
    act(() => {
      fireEvent.click(screen.getByTestId('merge-confirm'));
    });
    expect(screen.getByTestId('merge-options-dialog')).toBeInTheDocument();

    // Ctrl+Z while the dialog is open: the global EditUndo (which would roll back a
    // committed domain op) is suspended because the merge flow reported drawing=true.
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).not.toHaveBeenCalled();
  });

  it('the global EditUndo re-arms once the merge session ends (back to Idle)', () => {
    const { store, globalUndo } = mountWithGlobalUndo();
    activateMerge(store);
    clickInput(1, 1); // a session is now active (Selecting) → suspended
    // Leaving the merge tool ends the session → suspension lifts; the global undo is live.
    act(() => store.getState().setActiveTool(TOOL_ID.EditSelect));
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(1);
  });
});

// バグハント第11波 #6 — the merge controller's OWN window keydown listener (Escape, live
// while Selecting) MUST honour the SAME focus guard the global dispatcher does (教訓 5.13
// single predicate). The timeline year field / sidebar inputs are live even while merge
// targets are being picked; an Escape with a text input focused must edit the TEXT
// natively, NOT cancel the merge. A non-editable focus still cancels as before.
describe('MergeToolController — バグハント第11波 (#6): focus guard on the Escape listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  it('Escape with a text input focused does NOT cancel the merge and does NOT preventDefault', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1); // one target → Selecting
    expect(screen.getByTestId('merge-target-count').textContent).toBe('1');
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The merge session is still up with its target (not cancelled).
    expect(screen.getByTestId('merge-tool')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-count').textContent).toBe('1');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  // 増分 5 の手直し B1: Escape は道具を降りず、**対象を全部外す** ―― 結ぶ道具は
  // 対象の集合そのものが下書きなので、階段は 1 段しか無い（設計書 §D.4）。
  it('Escape from a NON-editable focus still clears the merge targets (no regression)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('merge-target-count').textContent).toBe('1');
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.getByTestId('merge-tool')).toBeInTheDocument();
    expect(screen.getByTestId('merge-target-count').textContent).toBe('0');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditMerge);
    button.remove();
    h.unmount();
  });

  // 1 段目を降りたあとの Escape は、**道具が何もせず大域の階段へ譲る**。
  it('対象が 0 件の Escape は preventDefault せず、大域の階段へ譲る', () => {
    const h = mountMerge();
    activateMerge(h.store);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditMerge);
    h.unmount();
  });
});

// --- 1 辺で経度 180 度以上を渡る結合 (N-51 / 技術方針 §6.8) -------------------

describe('MergeToolController — 保存できない長さの辺は画面で断る (N-51)', () => {
  it('横長の面どうしの結合は断られ、理由が日本語で出て地物は減らない', () => {
    const h = mountMerge(twoWideLeaves(), wideFeatureAtPoint);
    activateMerge(h.store);
    expect(effectiveCount(h.store)).toBe(2);

    clickInput(-50, 1); // leaf-a
    clickInput(50, 1); // leaf-b
    expect(screen.getByTestId('merge-target-count').textContent).toBe('2');

    fireEvent.click(screen.getByTestId('merge-confirm'));
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    // 論理和の結果が「1 本で 340 度」の辺を持つので確定しない ―― 何も変わらない (教訓 5.22)。
    expect(effectiveCount(h.store)).toBe(2);
    expect(screen.getByTestId('merge-message').textContent).toContain('世界を半周以上');
    expect(screen.getByTestId('merge-message').textContent).toContain('別の組み合わせで結合');
    h.unmount();
  });
});

// --- オプションバーの対象欄 (設計書 §C.4) ------------------------------------
//
// 実機の欠陥（増分 4）: 「結ぶ」を構えると、地物を選んでもオプションバーの対象欄が
// 「（選んでいません）」のままだった。この道具は自前の選択（`targetIds`）を持ち、セッションの
// `activeFeature` を書かないので、帯を持っている `ToolOptionBar` からは見えない。だから
// **この道具が自分で対象欄へ押し込む**。結合は **複数** を相手にするので、何件選んだのかが
// 読める文にする（1 件なら名前だけ、2 件以上なら「◯◯ ほか N 件」）。

/** 横に並んだ 3 つの面 ([0,2] / [2,4] / [4,6]、緯度は [0,2])。件数の文を見るための材料。 */
function threeAdjacentLeaves(): DomainRoot {
  const parts = [
    rectLeaf('leaf-a', 'va', 0, 2),
    rectLeaf('leaf-b', 'vb', 2, 2),
    rectLeaf('leaf-c', 'vc', 4, 2),
  ];
  let project = emptyProject();
  for (const part of parts) {
    project = applyAddProposal(project, {
      featureId: part.feature.id,
      anchorTime: ANCHOR,
      snapshot: { feature: part.feature, vertices: part.vertices, sharedCandidateIds: new Map() },
    });
  }
  return project;
}

/** 3 つ並んだ面の当たり判定。 */
const threeFeatureAtPoint: FeatureAtPoint = (p) => {
  if (p.lat < 0 || p.lat > 2) return null;
  if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
  if (p.lon > 2 && p.lon <= 4) return asFeatureId('leaf-b');
  if (p.lon > 4 && p.lon <= 6) return asFeatureId('leaf-c');
  return null;
};

describe('MergeToolController — オプションバーの対象欄（設計書 §C.4）', () => {
  it('1 件だけ選んだときは、その地物の名前と種類だけが出る', () => {
    const h = mountMerge();
    activateMerge(h.store);
    // 構えただけでは何も選んでいない（器が「（選んでいません）」を出す）。
    expect(h.optionBar.get().target.name).toBeNull();

    clickInput(1, 1); // leaf-a
    // 段階表示は「手順 1/2」（増分 5 の手直し B3 / 設計書 §C.4）。「2 件中 1 件」と
    // 誤読されないよう「手順」の 2 文字を含む。
    expect(h.optionBar.get().target).toEqual({
      stage: MERGE_STRINGS.stage(1),
      name: 'leaf-a（末端地物）',
    });
    h.unmount();
  });

  it('2 件以上選ぶと、何件選んだかが分かる文になる', () => {
    const h = mountMerge(threeAdjacentLeaves(), threeFeatureAtPoint);
    activateMerge(h.store);

    clickInput(1, 1); // leaf-a
    clickInput(3, 1); // leaf-b
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物） ほか 1 件');

    clickInput(5, 1); // leaf-c
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物） ほか 2 件');

    // 外すと件数も戻る（「ほか 0 件」にはしない）。
    clickInput(5, 1); // leaf-c を外す
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物） ほか 1 件');
    h.unmount();
  });

  it('「選択を外す」で対象欄が空へ戻る', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    clickInput(3, 1);
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物） ほか 1 件');

    fireEvent.click(screen.getByTestId('merge-clear'));
    expect(h.optionBar.get().target.name).toBeNull();
    h.unmount();
  });

  it('道具を降りると対象欄が空へ戻る', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物）');

    act(() => {
      h.store.getState().setActiveTool(null);
    });
    expect(h.optionBar.get().target.name).toBeNull();
    h.unmount();
  });

  it('Escape で対象を外しても対象欄が空へ戻る（道具は持ったまま）', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物）');

    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(h.optionBar.get().target.name).toBeNull();
    // 帯はまだこの道具のものなので、段階表示は残る（「手順 1/2」へ戻る）。
    expect(h.optionBar.get().target.stage).toBe(MERGE_STRINGS.stage(1));
    h.unmount();
  });

  it('部品ごと外れても対象欄が空へ戻る（教訓 5.2 全経路で破棄）', () => {
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).toBe('leaf-a（末端地物）');

    h.unmount();
    expect(h.optionBar.get().target.name).toBeNull();
  });

  it('帯を奪わない（`claim` しない）― 持ち主は ToolOptionBar のまま', () => {
    // 押し込みの API は持ち主を見ない規約（`option-bar.ts` の claim 注記 3）。ここで
    // `claim` すると帯が空へ戻り、`ToolOptionBar` が入れた道具名まで消える。
    const h = mountMerge();
    activateMerge(h.store);
    clickInput(1, 1);
    expect(h.optionBar.hasOwner()).toBe(false);
    h.unmount();
  });
});
