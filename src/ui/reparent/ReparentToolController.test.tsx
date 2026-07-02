// U28 — CROSS-LAYER INTEGRATION test (bughunt3: reparent-dead-button 回帰防止).
//
// REGRESSION CONTEXT (bughunt3): the 所属変更 (reparent, edit.reparent) toolbar tool was
// a DEAD button — it armed (aria-pressed toggled) but performed NO action. The whole
// src/domain/affiliation core (buildAffiliationProposal / allowedParentCandidates /
// isLegalNewParent / decision / command) was unit-tested but UNREACHABLE: NO UI consumed
// it (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」). Selecting a child face then
// clicking a different ancestor did nothing — the child's parentId never changed and no
// reparent occurred. The fix wired the missing消費する ui コンシューマ —
// {@link ReparentToolController} + {@link useReparentTool} + the LIVE U13 affiliation
// binding (createLiveAffiliationBinding) + U44's applyAffiliationProposal — so 所属変更
// actually repoints a feature's上位領域.
//
// THIS test mounts the REAL ReparentToolController over ONE session store wired to the
// REAL createLiveAffiliationBinding (the production graph, no stub U13), drives the whole
// reparent flow through the actual UI (pick target → pick new parent → 確定), and asserts
// the committed project's effective feature gains the new parentId (the exact reparent the
// dead button never produced). Runs in jsdom: the renderer transform + featureAtPoint are
// faked so the test is deterministic; the WIRING + the domain pipeline under test are
// production code.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type Feature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import { createGeoParams } from '../../domain/geo/geo-params';
import { applyAddProposal } from '../../domain/editing/apply-proposal';

import { createSessionStore, TIME_CHANGE_SOURCE, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';
import { AppShell } from '../shell';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';
import { createLiveAffiliationBinding, type DomainRoot } from '../consistency-binding';
import { featuresAt, leafShapeAt } from '../live-lookup';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';

import type { DrawPrimitive } from '../../render/map-renderer';
import {
  DEFAULT_REPARENT_PARENT_STYLE,
  DEFAULT_REPARENT_TARGET_STYLE,
} from '../../render/reaffiliation-batch';

import {
  ReparentToolController,
  type ScreenToWorld,
  type FeatureAtPoint,
  type ReparentDrawSink,
  type ResolveLeafShape,
} from './ReparentToolController';

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

/** A project with TWO disjoint top-level leaves at year 1000 (both 親なし). */
function twoTopLevelLeaves(): DomainRoot {
  const a = rectLeaf('leaf-a', 'va', 0, 2); // [0,2]×[0,2]
  const b = rectLeaf('leaf-b', 'vb', 4, 2); // [4,6]×[0,2] — disjoint from A
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
  readonly unmount: () => void;
}

function mountReparent(): Harness {
  const store = createSessionStore<DomainRoot>({
    initialDomain: twoTopLevelLeaves(),
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });
  // Park the timeline at the leaves' anchor year so they are effective (the reparent
  // anchor time the controller reads = store.currentTime).
  act(() => {
    store.getState().setCurrentTime(ANCHOR, TIME_CHANGE_SOURCE.Slider);
  });

  // The REAL live U13 affiliation binding (production pipeline; applyAffiliationProposal
  // under it). No id ports: the existing-parent reparent mints nothing.
  const live = createLiveAffiliationBinding({ getRoot: () => store.getState().domain });

  const resolveFeatures = () => featuresAt(store.getState().domain, store.getState().currentTime);

  // A click inside [0,2]² → leaf-a; inside [4,6]×[0,2] → leaf-b; else miss. HB3-16: this
  // mirrors the live `leafAtPoint` port — an INDIVIDUAL leaf is resolved per click, so two
  // siblings resolve to DISTINCT ids (the fix for HB3-15(b)).
  const featureAtPoint: FeatureAtPoint = (p) => {
    if (p.lat < 0 || p.lat > 2) return null;
    if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
    if (p.lon >= 4 && p.lon <= 6) return asFeatureId('leaf-b');
    return null;
  };

  // HB3-15(c): the live leaf-shape resolver (the SAME live-lookup the App bootstrap uses).
  const resolveLeafShape: ResolveLeafShape = (id) =>
    leafShapeAt(store.getState().domain, store.getState().currentTime, id) ?? undefined;

  // Capture the highlight batch the controller pushes on every selection change.
  let highlight: readonly DrawPrimitive[] = [];
  const drawSink: ReparentDrawSink = {
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

  const utils = render(
    <ReparentToolController<DomainRoot>
      store={store}
      startProcess={live.startProcess}
      resolveFeatures={resolveFeatures}
      anchorTime={() => store.getState().currentTime}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      resolveLeafShape={resolveLeafShape}
      drawSink={drawSink}
      onCommitted={onCommitted}
    />,
  );

  return { store, lastHighlight: () => highlight, unmount: utils.unmount };
}

function activateReparent(store: StoreApi<SessionStore<DomainRoot>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditReparent);
  });
}

function clickInput(lon: number, lat: number): void {
  const layer = screen.getByTestId('reparent-input-layer');
  fireEvent.pointerDown(layer, { clientX: lon, clientY: lat, button: 0 });
}

function effectiveById(
  store: StoreApi<SessionStore<DomainRoot>>,
  id: string,
): Feature | undefined {
  return featuresAt(store.getState().domain, store.getState().currentTime).find(
    (f) => f.id === asFeatureId(id),
  );
}

function parentIdOf(feature: Feature | undefined): FeatureId | undefined {
  return feature?.parentId;
}

describe('ReparentToolController — 所属変更 actually reparents (bughunt3 reparent-dead-button 回帰防止)', () => {
  it('arming the tool shows the pick-target guide and a disabled confirm button', () => {
    const h = mountReparent();
    activateReparent(h.store);
    expect(screen.getByTestId('reparent-guide').textContent).toContain('所属を変更する地物');
    // Confirm is disabled until both a target and a new parent are chosen.
    expect(screen.getByTestId('reparent-confirm')).toBeDisabled();
    h.unmount();
  });

  it('picking a target then a new parent then 所属変更を確定 repoints the parentId', () => {
    const h = mountReparent();
    activateReparent(h.store);
    // Both leaves start 親なし (top-level).
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBeUndefined();

    // First click = target (leaf-a); guide flips to pick-parent.
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    expect(screen.getByTestId('reparent-guide').textContent).toContain('新しい上位領域');
    // Confirm still disabled (no parent yet).
    expect(screen.getByTestId('reparent-confirm')).toBeDisabled();

    // Second click = new parent (leaf-b); confirm enables (legal new parent).
    clickInput(5, 1);
    expect(screen.getByTestId('reparent-parent').textContent).toBe('leaf-b');
    expect(screen.getByTestId('reparent-confirm')).not.toBeDisabled();

    // CONFIRM (the COMPLETE trigger; 教訓 5.7) → leaf-a is reparented under leaf-b.
    fireEvent.click(screen.getByTestId('reparent-confirm'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBe(asFeatureId('leaf-b'));
    h.unmount();
  });

  it('picking the target twice clears it (no reparent possible with no target)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // pick leaf-a
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    clickInput(1, 1); // click leaf-a again → cleared, back to pick-target
    expect(screen.getByTestId('reparent-target').textContent).toBe('');
    expect(screen.getByTestId('reparent-confirm')).toBeDisabled();
    h.unmount();
  });

  it('picking sibling A then a different sibling B keeps BOTH (HB3-15(b) 後から選択が消えない)', () => {
    // HB3-15(b): the symptom was that selecting one feature then a DIFFERENT one as the
    // reparent target dropped the first. The root cause was the drawn-AGGREGATE hit-test
    // resolving both siblings to the SAME parent id, so pick()'s same-id rule toggled the
    // first back off. With per-leaf resolution the two clicks return DISTINCT ids, so the
    // first stays as the target and the second becomes the new parent — both survive.
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // leaf-a → target
    clickInput(5, 1); // leaf-b (a DISTINCT id) → new parent
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    expect(screen.getByTestId('reparent-parent').textContent).toBe('leaf-b');
    // Neither selection was dropped, so confirm is enabled (legal new parent).
    expect(screen.getByTestId('reparent-confirm')).not.toBeDisabled();
    h.unmount();
  });

  it('the picked target + new parent render in DISTINCT tool-specific colours (HB3-15(c))', () => {
    const h = mountReparent();
    activateReparent(h.store);
    // No selection yet → empty highlight frame (教訓 5.18).
    expect(h.lastHighlight()).toEqual([]);

    // Pick the target: ONE highlight shape in the reparent TARGET colour.
    clickInput(1, 1); // leaf-a
    let shapes = h.lastHighlight().filter((p) => p.kind === 'shape');
    expect(shapes).toHaveLength(1);
    if (shapes[0]!.kind === 'shape') {
      expect(shapes[0]!.stroke).toBe(DEFAULT_REPARENT_TARGET_STYLE.stroke);
    }

    // Pick the new parent: TWO highlight shapes, target then parent, in DISTINCT colours so
    // the two roles read apart on the map.
    clickInput(5, 1); // leaf-b
    shapes = h.lastHighlight().filter((p) => p.kind === 'shape');
    expect(shapes).toHaveLength(2);
    if (shapes[0]!.kind === 'shape' && shapes[1]!.kind === 'shape') {
      expect(shapes[0]!.stroke).toBe(DEFAULT_REPARENT_TARGET_STYLE.stroke);
      expect(shapes[1]!.stroke).toBe(DEFAULT_REPARENT_PARENT_STYLE.stroke);
      expect(shapes[0]!.stroke).not.toBe(shapes[1]!.stroke);
    }
    h.unmount();
  });

  it('choosing the target itself as its new parent keeps confirm disabled (循環/同一拒否)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // target = leaf-a
    // Clicking leaf-a again toggles it OFF (same-id rule), so it never becomes its own
    // parent — confirm stays disabled. The legality predicate also rejects self-parent.
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-confirm')).toBeDisabled();
    h.unmount();
  });

  it('最上位へ (detach / parentNone) button: enabled with a target alone, detaches a nested leaf (bughunt parentNone wiring)', () => {
    const h = mountReparent();
    activateReparent(h.store);

    // First reparent leaf-a UNDER leaf-b so it is nested (gives us something to detach).
    clickInput(1, 1); // target = leaf-a
    clickInput(5, 1); // new parent = leaf-b
    fireEvent.click(screen.getByTestId('reparent-confirm'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBe(asFeatureId('leaf-b'));

    // Re-arm (the confirm re-armed at pick-target) and pick the nested leaf-a as the target.
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    // The detach button is enabled with ONLY a target (no new parent needed), unlike confirm.
    expect(screen.getByTestId('reparent-confirm')).toBeDisabled();
    expect(screen.getByTestId('reparent-confirm-none')).not.toBeDisabled();

    // Click 最上位へ → leaf-a returns to top level (parentId cleared). This whole path
    // (parentNone) was previously UNREACHABLE from the UI.
    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBeUndefined();
    h.unmount();
  });

  it('the detach button is disabled until a target is picked', () => {
    const h = mountReparent();
    activateReparent(h.store);
    expect(screen.getByTestId('reparent-confirm-none')).toBeDisabled();
    clickInput(1, 1); // pick leaf-a
    expect(screen.getByTestId('reparent-confirm-none')).not.toBeDisabled();
    h.unmount();
  });

  it('leaving the reparent tool discards the transient selection (教訓 5.2 全経路で破棄)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    // Switch to another edit tool: the controller unmounts its chrome (idle).
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditSelect);
    });
    expect(screen.queryByTestId('reparent-tool')).not.toBeInTheDocument();
    // Re-arming starts fresh with no leaked selection.
    act(() => {
      h.store.getState().setActiveTool(TOOL_ID.EditReparent);
    });
    expect(screen.getByTestId('reparent-target').textContent).toBe('');
    h.unmount();
  });
});

// bughunt-review — the e63c8b9 global-shortcut suspension MISSED the reparent flow too.
// While a reparent session owns the keyboard, a global window-level Ctrl+Z would fire
// EditUndo straight through to a domain op. This block mounts the REAL production graph
// (AppShell wiring useShortcuts + ReparentToolController) over ONE store, with the host
// derivation (suspended = reparentDrawing) the App uses, plus a live EditUndo on the
// SAME registry the shell dispatches — the exact production mechanism, no stand-in.
describe('ReparentToolController bughunt-review: Ctrl+Z does NOT leak through the reparent flow', () => {
  function mountWithGlobalUndo(): {
    store: StoreApi<SessionStore<DomainRoot>>;
    globalUndo: ReturnType<typeof vi.fn>;
  } {
    const store = createSessionStore<DomainRoot>({
      initialDomain: twoTopLevelLeaves(),
      initial: { mode: EDIT_MODE.Edit, activeTool: null },
    });
    act(() => {
      store.getState().setCurrentTime(ANCHOR, TIME_CHANGE_SOURCE.Slider);
    });

    const registry = new CommandRegistry();
    const globalUndo = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run: globalUndo });

    const live = createLiveAffiliationBinding({ getRoot: () => store.getState().domain });
    const resolveFeatures = () =>
      featuresAt(store.getState().domain, store.getState().currentTime);
    const featureAtPoint: FeatureAtPoint = (p) => {
      if (p.lat < 0 || p.lat > 2) return null;
      if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
      if (p.lon >= 4 && p.lon <= 6) return asFeatureId('leaf-b');
      return null;
    };

    // Mirror the App.tsx host wiring: hold the reparent-drawing flag, thread it as
    // `suspended` into AppShell, and feed the controller's onDrawingChange back into it.
    function Host(): JSX.Element {
      const [reparentDrawing, setReparentDrawing] = useState(false);
      return (
        <AppShell
          store={store}
          registry={registry}
          suspended={reparentDrawing}
          overlay={
            <ReparentToolController<DomainRoot>
              store={store}
              startProcess={live.startProcess}
              resolveFeatures={resolveFeatures}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={featureAtPoint}
              onDrawingChange={setReparentDrawing}
            />
          }
        />
      );
    }
    render(<Host />);
    return { store, globalUndo };
  }

  it('the global EditUndo never fires while a reparent session is active', () => {
    const { store, globalUndo } = mountWithGlobalUndo();
    activateReparent(store);

    // Pick a target: a session is now active (PickParent) → suspended.
    clickInput(1, 1); // leaf-a
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');

    // Ctrl+Z while the reparent flow owns the keyboard: the global EditUndo (which would
    // roll back a committed domain op) is suspended because the flow reported drawing=true.
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).not.toHaveBeenCalled();
  });

  it('the global EditUndo re-arms once the reparent session ends (back to Idle)', () => {
    const { store, globalUndo } = mountWithGlobalUndo();
    activateReparent(store);
    clickInput(1, 1); // session active → suspended
    // Leaving the reparent tool ends the session → suspension lifts; the global undo is live.
    act(() => store.getState().setActiveTool(TOOL_ID.EditSelect));
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(1);
  });
});

// バグハント第11波 #6 — the reparent controller's OWN window keydown listener (Escape, live
// while a session runs) MUST honour the SAME focus guard the global dispatcher does
// (教訓 5.13 single predicate). The timeline year field / sidebar inputs are live even while
// a reparent target is being picked; an Escape with a text input focused must edit the TEXT
// natively, NOT cancel the reparent. A non-editable focus still cancels as before.
describe('ReparentToolController — バグハント第11波 (#6): focus guard on the Escape listener', () => {
  function focusedInput(type = 'text'): HTMLInputElement {
    const input = document.createElement('input');
    input.type = type;
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  it('Escape with a text input focused does NOT cancel the reparent and does NOT preventDefault', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // pick leaf-a → session active (PickParent)
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    const input = focusedInput('text');
    const ev = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(ev);
    });
    // The reparent session is still up with its picked target (not cancelled).
    expect(screen.getByTestId('reparent-tool')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
    h.unmount();
  });

  it('Escape from a NON-editable focus still cancels the reparent (no regression)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.queryByTestId('reparent-tool')).not.toBeInTheDocument();
    button.remove();
    h.unmount();
  });
});
