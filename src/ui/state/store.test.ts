// U16 tests: thin Zustand store, domain bridge, time re-validation, settings
// boundary, and the React-free Canvas subscription contract.
//
// All tests inject FAKE existence predicates (existence.ts) to prove this store
// contains no independent time-resolution logic (受け入れ基準 3 / 5: 依存注入で
// 再実装していないことを確認, 単一の真実源).

import { describe, expect, it, vi } from 'vitest';

import { createCommandResult } from '../../domain/command/result';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';

import type { ExistenceResolver } from './existence';
import {
  APP_SETTING_KEYS,
  PROJECT_SETTING_KEYS,
  SETTINGS_SCOPE,
  classifySettingKey,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
} from './settings';
import { EDIT_MODE, asToolId } from './session';
import {
  TIME_CHANGE_SOURCE,
  type TimeChangeSource,
  createSessionStore,
} from './store';

// --- Test fixtures ----------------------------------------------------------

// A trivial opaque domain-state root for the bridge tests (U03 owns the real
// shape; the store treats S opaquely).
interface TestDomain {
  readonly tag: string;
}

const f = (s: string) => asFeatureId(s);
const v = (s: string) => asVertexId(s);

/** An existence resolver where a fixed set of features/vertices is "present". */
function resolverWith(
  presentFeatures: ReadonlySet<string>,
  presentVertices: ReadonlySet<string>,
): ExistenceResolver {
  return {
    featureExistsAt: (fid) => presentFeatures.has(fid),
    vertexExistsAt: (_fid, vid) => presentVertices.has(vid),
  };
}

function makeStore(
  existence?: ExistenceResolver,
  initial?: Parameters<typeof createSessionStore<TestDomain>>[0]['initial'],
) {
  return createSessionStore<TestDomain>({
    initialDomain: { tag: 'd0' },
    ...(existence ? { existence } : {}),
    ...(initial ? { initial } : {}),
  });
}

// --- 受け入れ基準 1: thin store holds session state -------------------------

describe('受け入れ基準 1: UI/session state held thinly', () => {
  it('holds selection, mode, tool, time, camera, centerLon', () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.activeFeature).toBeNull();
    expect(s.vertexSelection).toBeNull();
    expect(s.mode).toBe(EDIT_MODE.View);
    expect(s.activeTool).toBeNull();
    expect(s.currentTime).toBeDefined();
    expect(s.camera.zoom).toBe(1);
    expect(s.centerLon).toBe(0);
  });

  it('stores only a domain REFERENCE, not a copy of the truth', () => {
    const domain = { tag: 'shared' };
    const store = createSessionStore<TestDomain>({ initialDomain: domain });
    // Same reference identity: the store did not clone the domain truth.
    expect(store.getState().domain).toBe(domain);
  });
});

// --- 受け入れ基準 2: bridge + single truth source ---------------------------

describe('受け入れ基準 2: domain bridge via subscribe', () => {
  it('subscribers observe a new domain state when it is swapped', () => {
    const store = makeStore();
    const observed: string[] = [];
    store.subscribe((state) => observed.push(state.domain.tag));

    store.getState().setDomainState({ tag: 'd1' });
    store.getState().setDomainState({ tag: 'd2' });

    expect(observed).toEqual(['d1', 'd2']);
    expect(store.getState().domain.tag).toBe('d2');
  });

  it('resetToDomain swaps domain AND discards old session state atomically (finding 4)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
      mode: EDIT_MODE.Edit,
      activeTool: asToolId('add'),
      displayControl: {
        globalDepth: 3,
        focus: { originId: f('A'), depth: 2, emphasize: true },
      },
    });
    // Dirty the project first so we can prove the swap clears it.
    store.getState().updateProjectSetting('gridSpacingDeg', 7);
    expect(store.getState().projectDirty).toBe(true);

    store.getState().resetToDomain({ tag: 'loaded' });

    const s = store.getState();
    expect(s.domain.tag).toBe('loaded');
    // The stale selection / tool / mode / focus from the old project are gone.
    expect(s.activeFeature).toBeNull();
    expect(s.vertexSelection).toBeNull();
    expect(s.activeTool).toBeNull();
    expect(s.mode).toBe(EDIT_MODE.View);
    expect(s.displayControl.focus.originId).toBeNull();
    // The project-independent global depth N is preserved (教訓 5.13).
    expect(s.displayControl.globalDepth).toBe(3);
    // A load / new is a CLEAN baseline.
    expect(s.projectDirty).toBe(false);
  });

  it('re-resolves selection from a command result (NOT a blanket clear, 教訓 5.11)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1'), v('v2')]) },
    });

    // A structure-changing command deletes v1 (and feature B which isn't selected),
    // survives A and v2, creates C. Selection of A + v2 must survive.
    const result = createCommandResult({
      survived: [f('A'), v('v2')],
      created: [f('C')],
      deleted: [f('B'), v('v1')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result);

    const s = store.getState();
    expect(s.domain.tag).toBe('d1');
    expect(s.activeFeature).toBe(f('A')); // survived: kept, not cleared
    expect(s.vertexSelection).not.toBeNull();
    expect([...s.vertexSelection!.vertexIds]).toEqual([v('v2')]); // v1 dropped, v2 kept
  });

  it('drops the active feature when the command deletes it', () => {
    const store = makeStore(undefined, { activeFeature: f('A') });
    const result = createCommandResult({ deleted: [f('A')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result);
    expect(store.getState().activeFeature).toBeNull();
  });

  it('resolves the vertex context away when its owner feature is deleted', () => {
    const store = makeStore(undefined, {
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
    });
    const result = createCommandResult({ deleted: [f('A')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result);
    expect(store.getState().vertexSelection).toBeNull();
  });

  // 二重の真実源 回帰 (U22 integration): the store re-resolves via U22's
  // reresolveAfterStructureChange, so 教訓 5.11's NEXT-TARGET promotion works —
  // the previous store-local re-implementation only pruned deleted IDs and could
  // NOT promote the operation's result element. This test fails on that退化版.
  it('promotes the command preference as the next active feature (教訓 5.11 次対象昇格)', () => {
    // Nothing was selected before a merge; the merge creates feature M and the
    // caller prefers M as the next active feature. A prune-only re-resolution
    // would leave activeFeature null; U22 promotes M.
    const store = makeStore(undefined, { activeFeature: null });
    const result = createCommandResult({
      deleted: [f('A'), f('B')],
      created: [f('M')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result, {
      featureId: f('M'),
    });
    expect(store.getState().activeFeature).toBe(f('M'));
  });

  it('promotes a preferred created vertex set (教訓 5.11), keying off created/touched', () => {
    const store = makeStore(undefined, { activeFeature: null });
    // A split creates new vertices nv1/nv2 on the surviving feature S.
    const result = createCommandResult({
      survived: [f('S')],
      created: [v('nv1'), v('nv2')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result, {
      vertexSelection: { ownerFeatureId: f('S'), vertexIds: new Set([v('nv1'), v('nv2')]) },
    });
    const vs = store.getState().vertexSelection!;
    expect(vs.ownerFeatureId).toBe(f('S'));
    expect([...vs.vertexIds]).toEqual([v('nv1'), v('nv2')]);
  });

  it('keeps the stored SelectionState in lockstep with the derived mirrors (single truth)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1'), v('v2')]) },
    });
    const s = store.getState();
    // The mirrors are DERIVED from the one SelectionState truth.
    expect(s.selection.activeFeature).toBe(s.activeFeature);
    expect(s.selection.vertexOwner).toBe(s.vertexSelection!.ownerFeatureId);
    expect([...s.selection.vertexIds]).toEqual([...s.vertexSelection!.vertexIds]);
  });
});

// --- 受け入れ基準 3: time re-validation (教訓 5.5 / 5.6) --------------------

describe('受け入れ基準 3: time-change re-validation', () => {
  const ALL_SOURCES: TimeChangeSource[] = [
    TIME_CHANGE_SOURCE.Slider,
    TIME_CHANGE_SOURCE.NumericJump,
    TIME_CHANGE_SOURCE.AnchorSync,
    TIME_CHANGE_SOURCE.Playback,
  ];

  it.each(ALL_SOURCES)(
    'deselects an active feature absent at the new time via the %s path',
    (source) => {
      // Feature A does NOT exist at the new time.
      const existence = resolverWith(new Set<string>(), new Set<string>());
      const store = makeStore(existence, { activeFeature: f('A') });

      store.getState().setCurrentTime(timePointYear(500), source);

      expect(store.getState().activeFeature).toBeNull();
      expect(store.getState().lastTimeChangeSource).toBe(source);
    },
  );

  it.each(ALL_SOURCES)(
    'keeps an active feature still present at the new time via the %s path',
    (source) => {
      const existence = resolverWith(new Set(['A']), new Set<string>());
      const store = makeStore(existence, { activeFeature: f('A') });

      store.getState().setCurrentTime(timePointYear(500), source);

      expect(store.getState().activeFeature).toBe(f('A'));
    },
  );

  it('removes vertices absent at the new time and resolves empty context away', () => {
    // owner A present; only v1 present at the new time, v2 gone.
    const existence = resolverWith(new Set(['A']), new Set(['v1']));
    const store = makeStore(existence, {
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1'), v('v2')]) },
    });

    store.getState().setCurrentTime(timePointYear(100), TIME_CHANGE_SOURCE.Slider);
    const vs = store.getState().vertexSelection;
    expect(vs).not.toBeNull();
    expect([...vs!.vertexIds]).toEqual([v('v1')]);

    // Now move to a time where no vertex exists -> context resolved away.
    const store2 = makeStore(resolverWith(new Set(['A']), new Set<string>()), {
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
    });
    store2.getState().setCurrentTime(timePointYear(100), TIME_CHANGE_SOURCE.Playback);
    expect(store2.getState().vertexSelection).toBeNull();
  });

  it('delegates existence to the injected resolver (no re-implementation)', () => {
    const featureExistsAt = vi.fn(() => false);
    const vertexExistsAt = vi.fn(() => false);
    const store = makeStore({ featureExistsAt, vertexExistsAt }, { activeFeature: f('A') });

    store.getState().setCurrentTime(timePointYear(1), TIME_CHANGE_SOURCE.NumericJump);
    // The store called the injected predicate rather than computing existence itself.
    expect(featureExistsAt).toHaveBeenCalledWith(f('A'), timePointYear(1));
  });
});

// --- 受け入れ基準 4: settings boundary --------------------------------------

describe('受け入れ基準 4: settings boundary + immediate reflection', () => {
  it('classifies every FR-109 key as project and every FR-110 key as app', () => {
    for (const key of PROJECT_SETTING_KEYS) {
      expect(classifySettingKey(key)).toBe(SETTINGS_SCOPE.Project);
    }
    for (const key of APP_SETTING_KEYS) {
      expect(classifySettingKey(key)).toBe(SETTINGS_SCOPE.App);
    }
  });

  it('project + app key sets are disjoint', () => {
    const proj = new Set<string>(PROJECT_SETTING_KEYS);
    for (const key of APP_SETTING_KEYS) expect(proj.has(key)).toBe(false);
  });

  it('a project-setting change marks the project dirty and notifies', () => {
    const store = makeStore();
    expect(store.getState().projectDirty).toBe(false);

    const changes: string[] = [];
    store.subscribe((s) => {
      if (s.lastSettingsChange) changes.push(s.lastSettingsChange.key);
    });

    store.getState().updateProjectSetting('equatorLengthKm', 50000);

    const s = store.getState();
    expect(s.projectSettings.equatorLengthKm).toBe(50000);
    expect(s.projectDirty).toBe(true);
    expect(s.lastSettingsChange).toEqual({
      scope: SETTINGS_SCOPE.Project,
      key: 'equatorLengthKm',
    });
    expect(changes).toContain('equatorLengthKm');
  });

  it('an app-setting change does NOT mark the project dirty', () => {
    const store = makeStore();
    store.getState().updateAppSetting('snapDistancePx', 80);
    const s = store.getState();
    expect(s.appSettings.snapDistancePx).toBe(80);
    expect(s.projectDirty).toBe(false);
    expect(s.lastSettingsChange).toEqual({
      scope: SETTINGS_SCOPE.App,
      key: 'snapDistancePx',
    });
  });

  it('applies FR-110 defaults (snap 50px, 60 FPS) and clamps FPS to [1,60]', () => {
    const store = makeStore();
    expect(DEFAULT_APP_SETTINGS.snapDistancePx).toBe(50);
    expect(DEFAULT_APP_SETTINGS.renderFps).toBe(60);

    store.getState().updateAppSetting('renderFps', 120);
    expect(store.getState().appSettings.renderFps).toBe(60);
    store.getState().updateAppSetting('renderFps', 0);
    expect(store.getState().appSettings.renderFps).toBe(1);
  });

  it('markProjectSaved clears the dirty flag', () => {
    const store = makeStore();
    store.getState().updateProjectSetting('gridSpacingDeg', 5);
    expect(store.getState().projectDirty).toBe(true);
    store.getState().markProjectSaved();
    expect(store.getState().projectDirty).toBe(false);
  });

  // 回帰 (finding): hydrateSettings is the LOAD / NEW project-settings half. The
  // timeline RANGE the slider reads (timelineMin/timelineMax) is a derived mirror
  // of projectSettings.timelineMin/MaxYear, and currentTime must be re-clamped into
  // the new range — otherwise a previous project's wide range and an out-of-range
  // currentTime survive a LOAD / NEW and the domain resolves at a time outside the
  // new range (空表示). Pre-fix, hydrateSettings replaced only the settings slice
  // and left timelineMin/Max/currentTime untouched.
  it('hydrateSettings re-derives the timeline range and clamps currentTime into it (finding)', () => {
    // Default range is 0..10000. Slide near the right end of the OLD range.
    const store = makeStore();
    store.getState().setCurrentTime(timePointYear(9000), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().currentTime).toEqual(timePointYear(9000));

    // Load a NEW project whose timeline is a NARROW, shifted range 0..100.
    store.getState().hydrateSettings({
      projectSettings: {
        ...DEFAULT_PROJECT_SETTINGS,
        timelineMinYear: 0,
        timelineMaxYear: 100,
      },
    });

    const s = store.getState();
    // The slider range now reflects the NEW project, not the previous 0..10000.
    expect(s.timelineMin).toEqual(timePointYear(0));
    expect(s.timelineMax).toEqual(timePointYear(100));
    // currentTime (9000) was outside the new range and was clamped to the max bound.
    expect(s.currentTime).toEqual(timePointYear(100));
    // A LOAD / NEW is a clean baseline.
    expect(s.projectDirty).toBe(false);
  });

  it('hydrateSettings keeps an in-range currentTime unchanged', () => {
    const store = makeStore();
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);
    store.getState().hydrateSettings({
      projectSettings: {
        ...DEFAULT_PROJECT_SETTINGS,
        timelineMinYear: 0,
        timelineMaxYear: 100,
      },
    });
    expect(store.getState().currentTime).toEqual(timePointYear(50));
  });

  it('hydrateSettings with no project slice derives the range from the kept settings (pre-`ui` manifest)', () => {
    // Start from a project with a narrow range, then move current time inside it.
    const store = makeStore();
    store.getState().hydrateSettings({
      projectSettings: {
        ...DEFAULT_PROJECT_SETTINGS,
        timelineMinYear: 0,
        timelineMaxYear: 100,
      },
    });
    store.getState().setCurrentTime(timePointYear(80), TIME_CHANGE_SOURCE.Slider);
    // A pre-`ui` manifest carries no settings: the kept settings still drive the
    // derived range, and an in-range currentTime is preserved.
    store.getState().hydrateSettings({});
    const s = store.getState();
    expect(s.timelineMin).toEqual(timePointYear(0));
    expect(s.timelineMax).toEqual(timePointYear(100));
    expect(s.currentTime).toEqual(timePointYear(80));
  });
});

// --- 受け入れ基準 5: Canvas subscribes only (no React path) -----------------

describe('受け入れ基準 5: Canvas-style subscriber receives updates', () => {
  it('a plain subscriber observes camera / time / centerLon changes', () => {
    const store = makeStore();
    const frames: Array<{ zoom: number; lon: number }> = [];
    store.subscribe((s) => frames.push({ zoom: s.camera.zoom, lon: s.centerLon }));

    store.getState().updateCamera({ zoom: 4 });
    store.getState().setCenterLon(120);

    expect(frames).toEqual([
      { zoom: 4, lon: 0 },
      { zoom: 4, lon: 120 },
    ]);
  });

  it('the store is framework-free (getState/setState/subscribe present)', () => {
    const store = makeStore();
    expect(typeof store.getState).toBe('function');
    expect(typeof store.setState).toBe('function');
    expect(typeof store.subscribe).toBe('function');
  });
});

// --- mode/tool reset契約 (教訓 5.2) ----------------------------------------

describe('mode/tool switch discards transient selection (教訓 5.2)', () => {
  it('setMode clears selection and active tool on every path', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
      activeTool: asToolId('pen'),
    });
    store.getState().setMode(EDIT_MODE.Edit);
    const s = store.getState();
    expect(s.mode).toBe(EDIT_MODE.Edit);
    expect(s.activeFeature).toBeNull();
    expect(s.vertexSelection).toBeNull();
    expect(s.activeTool).toBeNull();
  });

  it('setActiveTool clears selection (select -> cancel -> recreate has no residue)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
    });
    store.getState().setActiveTool(asToolId('rect'));
    expect(store.getState().activeFeature).toBeNull();
    expect(store.getState().activeTool).toBe(asToolId('rect'));
  });

  it('restoreSelection re-applies a captured selection across a tool re-arm (教訓 5.11 retain)', () => {
    // Simulate the post-conflict-commit re-arm: a feature is selected with a tool
    // armed, then the re-arm toggle null→prev clears the selection;
    // restoreSelection brings it back so only the tool DRAFT is discarded while the
    // committed selection survives (the 軽微UX fix in App.reArmActiveTool).
    const store = makeStore(undefined, { activeFeature: f('A') });
    store.getState().setActiveTool(asToolId('rect'));
    store.getState().setActiveFeature(f('A'));
    const retained = store.getState().selection; // captured before the re-arm

    store.getState().setActiveTool(null); // re-arm step 1: clears selection
    expect(store.getState().activeFeature).toBeNull();
    store.getState().setActiveTool(asToolId('rect')); // re-arm step 2: still cleared
    expect(store.getState().activeFeature).toBeNull();

    store.getState().restoreSelection(retained); // retain the committed selection
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().activeTool).toBe(asToolId('rect'));
  });
});

// --- vertex selection update rules (FR-80 / FR-81) --------------------------

describe('vertex selection update rules (FR-80 / FR-81)', () => {
  it('replace sets the whole selection set', () => {
    const store = makeStore();
    store.getState().replaceVertexSelection(f('A'), [v('v1'), v('v2')]);
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1'), v('v2')]);
  });

  it('toggle adds then removes a vertex; emptying resolves the context away', () => {
    const store = makeStore();
    store.getState().toggleVertexSelection(f('A'), v('v1'));
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1')]);
    store.getState().toggleVertexSelection(f('A'), v('v1'));
    expect(store.getState().vertexSelection).toBeNull();
  });

  it('add merges vertices into an existing same-owner context', () => {
    const store = makeStore();
    store.getState().replaceVertexSelection(f('A'), [v('v1')]);
    store.getState().addVerticesToSelection(f('A'), [v('v2'), v('v3')]);
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1'), v('v2'), v('v3')]);
  });

  it('switching owner starts a fresh context (FR-81: one owner)', () => {
    const store = makeStore();
    store.getState().replaceVertexSelection(f('A'), [v('v1')]);
    store.getState().toggleVertexSelection(f('B'), v('v9'));
    const vs = store.getState().vertexSelection!;
    expect(vs.ownerFeatureId).toBe(f('B'));
    expect([...vs.vertexIds]).toEqual([v('v9')]);
  });
});

// =============================================================================
// Display control: hierarchy depth focus, independent axis (FR-42 / FR-43, U34)
// =============================================================================
describe('display control — independent axis (FR-42 非干渉, U34)', () => {
  it('defaults to global depth 0 and no focus', () => {
    const dc = makeStore().getState().displayControl;
    expect(dc.globalDepth).toBe(0);
    expect(dc.focus.originId).toBeNull();
  });

  it('global depth + focus setters never touch mode / tool / selection (受け入れ基準 2)', () => {
    const store = makeStore();
    // Put the session into an edit-in-progress shape first.
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(asToolId('edit.vertex'));
    store.getState().setActiveFeature(f('A'));
    const before = store.getState();

    store.getState().setGlobalDepth(3);
    store.getState().setFocusOrigin(f('B'));
    store.getState().setFocusDepth(5);
    store.getState().setFocusEmphasize(true);

    const after = store.getState();
    // Display control changed...
    expect(after.displayControl.globalDepth).toBe(3);
    expect(after.displayControl.focus).toEqual({
      originId: f('B'),
      depth: 5,
      emphasize: true,
    });
    // ...but mode / tool / selection are untouched (no interference).
    expect(after.mode).toBe(before.mode);
    expect(after.activeTool).toBe(before.activeTool);
    expect(after.activeFeature).toBe(before.activeFeature);
    expect(after.domain).toBe(before.domain);
  });

  it('switching mode does NOT destroy the display-control state (受け入れ基準 2)', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    store.getState().setDisplayFocus({ originId: f('X'), depth: 4, emphasize: true });
    const dcBefore = store.getState().displayControl;

    store.getState().setMode(EDIT_MODE.Add);
    store.getState().setActiveTool(asToolId('add.point'));

    expect(store.getState().displayControl).toEqual(dcBefore);
  });

  it('clearDisplayFocus reverts focus to none but keeps global depth (教訓 5.2)', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    store.getState().setDisplayFocus({ originId: f('X'), depth: 4, emphasize: true });
    store.getState().clearDisplayFocus();
    const dc = store.getState().displayControl;
    expect(dc.globalDepth).toBe(2);
    expect(dc.focus.originId).toBeNull();
  });

  it('setFocusOrigin(null) clears just the origin', () => {
    const store = makeStore();
    store.getState().setDisplayFocus({ originId: f('X'), depth: 4, emphasize: true });
    store.getState().setFocusOrigin(null);
    expect(store.getState().displayControl.focus.originId).toBeNull();
    // depth / emphasize preserved.
    expect(store.getState().displayControl.focus.depth).toBe(4);
  });
});
