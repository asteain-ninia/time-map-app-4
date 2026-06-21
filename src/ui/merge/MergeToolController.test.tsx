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
import { describe, expect, it } from 'vitest';
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
import { TOOL_ID } from '../shell/tools';
import {
  createLiveMergeBinding,
  type DomainRoot,
} from '../consistency-binding';
import { featuresAt, verticesAt } from '../live-lookup';
import { createSharedIdMint } from '../App';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';

import {
  MergeToolController,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './MergeToolController';

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

// Identity screen→world so a click at (clientX, clientY) lands at world (lon, lat).
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

interface Harness {
  readonly store: StoreApi<SessionStore<DomainRoot>>;
  readonly unmount: () => void;
}

function mountMerge(): Harness {
  const store = createSessionStore<DomainRoot>({
    initialDomain: twoAdjacentLeaves(),
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

  // A click inside [0,2]² → leaf-a; inside [2,4]×[0,2] → leaf-b; else miss.
  const featureAtPoint: FeatureAtPoint = (p) => {
    if (p.lat < 0 || p.lat > 2) return null;
    if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
    if (p.lon > 2 && p.lon <= 4) return asFeatureId('leaf-b');
    return null;
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

  const utils = render(
    <MergeToolController<DomainRoot>
      store={store}
      startProcess={live.startProcess}
      ids={ids}
      resolveFeatures={resolveFeatures}
      resolveStore={resolveStore}
      anchorTime={() => store.getState().currentTime}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      onCommitted={onCommitted}
    />,
  );

  return { store, unmount: utils.unmount };
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

  it('clicking two adjacent faces then 結合を確定 folds them into ONE (count 2→1)', () => {
    const h = mountMerge();
    activateMerge(h.store);
    expect(effectiveCount(h.store)).toBe(2);

    // Toggle both adjacent leaves into the target set.
    clickInput(1, 1); // leaf-a
    clickInput(3, 1); // leaf-b
    expect(screen.getByTestId('merge-target-count').textContent).toBe('2');
    // With 2 valid, non-vertically-related targets present at the time, confirm enables.
    expect(screen.getByTestId('merge-confirm')).not.toBeDisabled();

    // CONFIRM (the COMPLETE trigger; 教訓 5.7) → the merge commits and the count drops.
    fireEvent.click(screen.getByTestId('merge-confirm'));
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
