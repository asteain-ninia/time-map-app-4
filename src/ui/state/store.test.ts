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

  // bughunt5 HOLE-1: a SURVIVE vertex-delete reports the FEATURE as survived (the
  // deleted vertex ids are NOT in `result.deleted` — makeCommand reports deletion at
  // feature-history level only, consistency-binding.ts). So reresolve CANNOT prune the
  // deleted vertex id — it lingers as a ghost. This proves BOTH halves of the App's
  // reconciliation: (1) the ghost genuinely survives applyCommandResult even with the
  // feature preference, and (2) the explicit replaceVertexSelection(owner, []) the
  // onConflictCommitted / direct path runs drops it while keeping the feature active.
  it('a survive vertex-delete leaves a ghost vertex id that the explicit clear must drop (HOLE-1)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('gone')]) },
    });
    // The delete SURVIVED the feature A; the vertex id is deleted at the geometry level
    // but the command result only reports A as survived (feature-history granularity).
    const result = createCommandResult({ survived: [f('A')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result, { featureId: f('A') });

    // reresolve could NOT prune the ghost vertex id (it is not in result.deleted).
    const mid = store.getState();
    expect(mid.activeFeature).toBe(f('A'));
    expect(mid.vertexSelection).not.toBeNull();
    expect([...mid.vertexSelection!.vertexIds]).toEqual([v('gone')]); // ghost survives!

    // The explicit clear the survive path runs (direct AND conflict-commit) drops the
    // ghost while KEEPING the feature active (withVertexSet drops the owner on empty).
    store.getState().replaceVertexSelection(f('A'), []);
    const after = store.getState();
    expect(after.activeFeature).toBe(f('A')); // feature stays active.
    expect(after.vertexSelection).toBeNull(); // no ghost vertex id remains.
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

  // --- 第10波 #5: anchor-level existence re-validation after a commit ---------
  //
  // A multi-anchor feature's TIME-SLICE vertex delete (a below-threshold delete at
  // ONE anchor) drops the feature ONLY at the current time — the OTHER anchors keep
  // its feature-history alive, so makeCommand reports it as `survived` (its
  // history-id is still in `final`). reresolveAfterStructureChange works at the
  // feature-history level (CommandResult), so it CANNOT prune a feature/vertex that
  // is absent at the current time but present at another anchor: a ghost
  // activeFeature / vertex selection survives, the map draws nothing at this time,
  // and a second Delete no-ops. applyCommandResult must therefore ALSO run the SAME
  // anchor-level revalidateForTime (the injected existence port + current time) the
  // time-change path uses — the single existence truth source — so a commit that
  // leaves the selection pointing at something absent at the current time drops it.
  it('drops an active feature that a commit left absent at the current time (multi-anchor time-slice delete)', () => {
    // Feature A is `survived` (another anchor keeps its history) but does NOT exist
    // at the current time (its territory was deleted at THIS anchor).
    const existence = resolverWith(new Set<string>(), new Set<string>());
    const store = makeStore(existence, { activeFeature: f('A') });

    // A commit that survives A at feature-history level (reresolve keeps it) …
    const result = createCommandResult({ survived: [f('A')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result, { featureId: f('A') });

    // …but anchor-level existence re-validation drops it (absent at current time),
    // so no ghost activeFeature lingers and a second Delete is not a no-op.
    expect(store.getState().activeFeature).toBeNull();
  });

  it('drops a ghost vertex selection whose owner is absent at the current time after a commit', () => {
    // Owner B survived at history level but is absent at the current time; its vertex
    // selection must be re-validated away (anchor-level), not left as a ghost.
    const existence = resolverWith(new Set<string>(), new Set<string>());
    const store = makeStore(existence, {
      vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) },
    });
    const result = createCommandResult({ survived: [f('B')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result);
    expect(store.getState().vertexSelection).toBeNull();
  });

  it('PRESERVES a promoted next-target that DOES exist at the current time (add/split/merge/reparent正常コミット)', () => {
    // The critical guard: a NORMAL commit (add / split / merge / reparent / drill /
    // drag / attribute-edit) whose promoted target EXISTS at the current time must
    // NOT be dropped by the anchor-level re-validation. revalidateForTime keeps what
    // is present, so the promoted feature + its vertex set survive.
    const existence = resolverWith(new Set(['M']), new Set(['nv1', 'nv2']));
    const store = makeStore(existence, { activeFeature: null });
    const result = createCommandResult({
      deleted: [f('A'), f('B')],
      created: [f('M'), v('nv1'), v('nv2')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result, {
      featureId: f('M'),
      vertexSelection: { ownerFeatureId: f('M'), vertexIds: new Set([v('nv1'), v('nv2')]) },
    });
    const s = store.getState();
    expect(s.activeFeature).toBe(f('M')); // present at current time → kept.
    expect(s.vertexSelection).not.toBeNull();
    expect(s.vertexSelection!.ownerFeatureId).toBe(f('M'));
    expect([...s.vertexSelection!.vertexIds]).toEqual([v('nv1'), v('nv2')]);
  });

  it('single-anchor delete (deleted reported) still drops selection — no regression', () => {
    // The existing single-anchor path: the feature IS in result.deleted, so reresolve
    // Step-1 drops it. With the default ALWAYS_PRESENT resolver, the extra
    // revalidateForTime is a no-op here — the deletion is honoured by reresolve alone.
    const store = makeStore(undefined, { activeFeature: f('A') });
    const result = createCommandResult({ deleted: [f('A')] });
    store.getState().applyCommandResult({ tag: 'd1' }, result);
    expect(store.getState().activeFeature).toBeNull();
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

  // 回帰 (bughunt2 finding): setCurrentTime did NOT clamp the incoming time into the
  // live [timelineMin, timelineMax] range — it committed the RAW time and
  // re-validated selection against it, unlike deriveTimelineState (which clamps via
  // clampTimeToRange on the LOAD / NEW + dialog paths). The contract was asymmetric:
  // a non-UI caller (or a playback edge overshooting a bound) could set currentTime
  // outside the range, resolving the domain at a time with no committed features
  // (空表示) while selection was revalidated at that same out-of-range time — a
  // "selection survives but nothing draws" mismatch. The store must enforce the
  // invariant itself rather than trusting every caller to pre-clamp.
  it('clamps an out-of-range time to the timeline bound (above max) before committing (finding)', () => {
    // Default range is 0..10000. Feature A exists ONLY inside the range (at the max
    // bound) but NOT at the out-of-range raw time the caller passes.
    const existence: ExistenceResolver = {
      featureExistsAt: (_fid, t) =>
        t.year >= 0 && t.year <= 10000,
      vertexExistsAt: () => false,
    };
    const store = makeStore(existence, { activeFeature: f('A') });

    // A future non-UI caller overshoots the upper bound (10000 -> 99999).
    store.getState().setCurrentTime(timePointYear(99999), TIME_CHANGE_SOURCE.Playback);

    const s = store.getState();
    // currentTime was clamped to the max bound, NOT committed as the raw 99999 —
    // so committed-features resolves inside the range and the map is not blank.
    expect(s.currentTime).toEqual(timePointYear(10000));
    // Selection was revalidated against the CLAMPED time (A exists there), so it
    // survives consistently with what is actually drawn — no "survives but blank".
    expect(s.activeFeature).toBe(f('A'));
    expect(s.lastTimeChangeSource).toBe(TIME_CHANGE_SOURCE.Playback);
  });

  it('clamps an out-of-range time to the timeline bound (below min) before committing (finding)', () => {
    const store = makeStore();
    // Undershoot the lower bound (0 -> -5000) on the slider path.
    store.getState().setCurrentTime(timePointYear(-5000), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().currentTime).toEqual(timePointYear(0));
  });

  it('leaves an in-range time unchanged (clamp is a no-op on shipped paths)', () => {
    const store = makeStore();
    // 9000 is inside the default 0..10000 range -> committed verbatim.
    store.getState().setCurrentTime(timePointYear(9000), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().currentTime).toEqual(timePointYear(9000));
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

  // 回帰 (bughunt: App 設定変更が dirty を立てず無警告で失われる). App settings are
  // persisted ONLY inside the project file's uiSettings (no separate app-settings
  // store), and the unsaved-changes guard reads projectDirty as its single basis. So
  // an app-setting change MUST arm projectDirty exactly like a project-setting change,
  // otherwise changing only an app setting (e.g. renderFps) and quitting passes the
  // guard with no warning and the change is silently lost (受け入れ基準 2 全経路).
  it('an app-setting change marks the project dirty (so the unsaved guard fires)', () => {
    const store = makeStore();
    expect(store.getState().projectDirty).toBe(false);
    store.getState().updateAppSetting('snapDistancePx', 80);
    const s = store.getState();
    expect(s.appSettings.snapDistancePx).toBe(80);
    expect(s.projectDirty).toBe(true);
    expect(s.lastSettingsChange).toEqual({
      scope: SETTINGS_SCOPE.App,
      key: 'snapDistancePx',
    });
  });

  it('a renderFps change also marks the project dirty', () => {
    const store = makeStore();
    store.getState().updateAppSetting('renderFps', 30);
    expect(store.getState().projectDirty).toBe(true);
  });

  // FR-74: the undo-stack depth limit round-trips through the app-settings slice as a
  // document-affecting app setting (it drives withLimit in App.tsx; the value lives in
  // appSettings and persists in the project file's uiSettings).
  it('an undoStackSize change round-trips through the app slice and marks the project dirty', () => {
    const store = makeStore();
    expect(store.getState().appSettings.undoStackSize).toBe(
      DEFAULT_APP_SETTINGS.undoStackSize,
    );
    store.getState().updateAppSetting('undoStackSize', 2);
    const s = store.getState();
    expect(s.appSettings.undoStackSize).toBe(2);
    expect(s.projectDirty).toBe(true);
    expect(s.lastSettingsChange).toEqual({
      scope: SETTINGS_SCOPE.App,
      key: 'undoStackSize',
    });
  });

  // 回帰 (bughunt2 finding): showConflictGuide is a PURE first-time / cosmetic UX
  // preference (FR-118). Dismissing the conflict-resolution guide hint INSIDE the
  // conflict modal routes through updateAppSetting('showConflictGuide', false). If
  // that dirtied the project, ticking "do not show this guide again" and then
  // CANCELLING the conflict resolution (no domain change) would leave the project
  // dirty and pop a surprising unsaved-changes warning on quit, caused only by
  // hiding a UI hint. So this cosmetic app preference must NOT, on its own, mark the
  // project dirty — while still updating the value and emitting the change so the
  // settings dialog / persistence bridge reflect it (it round-trips on a real save).
  it('suppressing the conflict guide (cosmetic app pref) does NOT mark the project dirty', () => {
    const store = makeStore();
    expect(store.getState().projectDirty).toBe(false);
    store.getState().updateAppSetting('showConflictGuide', false);
    const s = store.getState();
    // The value is applied and the change is observable...
    expect(s.appSettings.showConflictGuide).toBe(false);
    expect(s.lastSettingsChange).toEqual({
      scope: SETTINGS_SCOPE.App,
      key: 'showConflictGuide',
    });
    // ...but the document dirty flag is NOT armed by this cosmetic preference alone.
    expect(s.projectDirty).toBe(false);
  });

  // Guard the EXCEPTION's scope: re-enabling the guide is equally cosmetic and must
  // not dirty the project either, and a pre-existing dirty flag is left untouched
  // (the cosmetic write neither sets nor CLEARS projectDirty).
  it('toggling showConflictGuide leaves a pre-existing dirty flag unchanged', () => {
    const store = makeStore();
    store.getState().updateProjectSetting('gridSpacingDeg', 5);
    expect(store.getState().projectDirty).toBe(true);
    store.getState().updateAppSetting('showConflictGuide', false);
    expect(store.getState().projectDirty).toBe(true);
    store.getState().updateAppSetting('showConflictGuide', true);
    expect(store.getState().projectDirty).toBe(true);
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

  // bughunt (全 undo 後の dirty 解消): an undo / redo must RECOMPUTE projectDirty
  // against the last-saved baseline, not force it true. Pre-fix, undo/redo routed
  // through applyCommandResult which always set projectDirty=true, so a project fully
  // undone back to its saved state still warned about unsaved changes.
  describe('undo/redo dirty recomputation against the saved baseline (bughunt)', () => {
    // A store whose opaque domain equality compares the `tag` by value, so a restored
    // value-equal-but-new domain reference is recognised as equal to the saved one.
    function dirtyStore() {
      return createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        domainEquals: (a, b) => a.tag === b.tag,
      });
    }
    const edit = createCommandResult({ created: [f('A')] });
    const undoResult = createCommandResult({ deleted: [f('A')] });

    it('undo back to the saved state clears dirty; redo re-dirties', () => {
      const store = dirtyStore();
      // Establish a clean saved baseline at d0.
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // An edit advances the domain and marks dirty.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);

      // Undo restores a value-equal d0 (new reference) → back to saved → clean.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);

      // Redo away from the saved state → dirty again.
      store.getState().applyUndoRedoResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
    });

    it('undo keeps the project dirty when it has never been saved (no baseline)', () => {
      const store = dirtyStore();
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
      // Undo to d0 — but the project was never saved, so there is no clean baseline.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(true);
    });

    it('undo to a state that differs from the saved baseline stays dirty', () => {
      const store = dirtyStore();
      // Save at d1 (the baseline is d1, not d0).
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);
      store.getState().applyCommandResult({ tag: 'd2' }, edit);
      // Undo to d1 (the saved baseline) → clean.
      store.getState().applyUndoRedoResult({ tag: 'd1' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
      // A further undo to d0 (NOT the saved baseline) → dirty.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(true);
    });

    it('applyUndoRedoResult still re-resolves selection like applyCommandResult', () => {
      const store = createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        domainEquals: (a, b) => a.tag === b.tag,
        initial: { activeFeature: f('A') },
      });
      // An undo that deletes the active feature drops it from the selection (U22).
      store.getState().applyUndoRedoResult(
        { tag: 'd1' },
        createCommandResult({ deleted: [f('A')] }),
      );
      expect(store.getState().activeFeature).toBeNull();
    });

    it('a clean LOAD / NEW reflect re-arms the baseline so an undo back to it reads clean', () => {
      const store = dirtyStore();
      // Reflect a loaded project at d0 (clean baseline).
      store.getState().reflectLoadedProject({ tag: 'd0' }, {});
      expect(store.getState().projectDirty).toBe(false);
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // bughunt2: the clean/dirty baseline must account for BOTH the domain AND the
    // settings slice (the persisted file carries both). A project that is domain-
    // clean but settings-dirty (a setting changed after the last save) MUST NOT be
    // reported clean by an unrelated undo / redo — pre-fix it compared only the
    // domain, so the settings edit silently dropped out of the unsaved-changes guard.
    it('a settings-only change after save stays dirty across an unrelated undo/redo (Q4)', () => {
      const store = dirtyStore();
      // Clean baseline at d0 (domain + current settings).
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // Advance + save so there is a real saved baseline at d1.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // Change ONLY a setting — the domain is untouched, so a domain-only clean
      // check would call this clean after any undo/redo.
      store.getState().updateProjectSetting('gridSpacingDeg', 7);
      expect(store.getState().projectDirty).toBe(true);

      // An unrelated undo to d0 then redo to d1 (the saved domain) MUST keep the
      // project dirty: the live settings still differ from the saved baseline.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
    });

    it('an app-setting-only change after save stays dirty across an unrelated undo/redo (Q4)', () => {
      const store = dirtyStore();
      store.getState().markProjectSaved();
      store.getState().updateAppSetting('snapDistancePx', 80);
      expect(store.getState().projectDirty).toBe(true);
      // Undo/redo back to the exact saved domain must NOT clear the settings dirt.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(true);
    });

    // bughunt-review: the saved-settings comparison the undo/redo clean-check uses must
    // be CONSISTENT with updateAppSetting's cosmetic exception (appSettingDirtiesProject).
    // A pure cosmetic preference (showConflictGuide) deliberately does NOT dirty the
    // project, so dismissing it after a save and then UNDOING the domain back to the saved
    // state must still read CLEAN — the domain is fully restored and only a non-dirtying
    // cosmetic pref differs. Pre-fix, settingsMatchSaved compared ALL app keys (isAppNoOp),
    // so the differing showConflictGuide falsely re-dirtied the project and fired the
    // unsaved-changes guard on quit.
    it('dismissing showConflictGuide (cosmetic) does NOT re-dirty across an undo to saved (bughunt-review)', () => {
      const store = dirtyStore();
      // Clean baseline at d0 with showConflictGuide at its saved value (default true).
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // Dismiss the cosmetic guide — this does NOT dirty the project (appSettingDirtiesProject).
      store.getState().updateAppSetting('showConflictGuide', false);
      expect(store.getState().projectDirty).toBe(false);

      // An edit dirties; an undo restores the saved domain. Only the non-dirtying cosmetic
      // showConflictGuide still differs from the saved baseline, so the project reads CLEAN.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    it('a document-affecting app setting (snapDistancePx) DOES keep dirty after undo to saved (bughunt-review)', () => {
      const store = dirtyStore();
      store.getState().markProjectSaved();
      // A document-affecting app setting change dirties and must SURVIVE an undo to the
      // saved domain (it is part of the persisted document, unlike the cosmetic guide).
      store.getState().updateAppSetting('snapDistancePx', 80);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(true);
    });

    // bughunt2 (Q5): undo/redo back to the EXACT saved domain+settings reads clean,
    // and a save AFTER a settings change refreshes the baseline to include the new
    // settings (so a later undo/redo to that domain reads clean again).
    it('undo/redo to the exact saved domain+settings reads clean; re-save refreshes the settings baseline (Q5)', () => {
      const store = dirtyStore();
      store.getState().markProjectSaved(); // baseline: d0 + default settings.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);

      // Undo to d0 with settings still at their saved values → fully clean.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);

      // Now change a setting and SAVE: the new settings join the saved baseline.
      store.getState().updateProjectSetting('gridSpacingDeg', 7);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // An undo/redo back to the saved domain now reads clean (the saved baseline
      // includes gridSpacingDeg=7), and reverting the setting reads dirty again.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
      store.getState().updateProjectSetting('gridSpacingDeg', 5);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
    });
  });

  // --- 第11波 Fix C (#4=#5): applyUndoRedoResult anchor-level re-validation -----
  //
  // Symmetric with the 第10波 #5 guard on applyCommandResult (see above): a
  // multi-anchor feature's TIME-SLICE delete (or a ring-edit last-territory delete)
  // drops the feature ONLY at the current time — its OTHER anchors keep the
  // feature-history alive, so makeCommand reports it as `survived`. reresolveAfter-
  // StructureChange works at the feature-history level and CANNOT prune something
  // absent at the current time but present at another anchor. When such a commit is
  // UNDONE/REDONE, applyUndoRedoResult must run the SAME anchor-level revalidateForTime
  // (injected existence port + current time) applyCommandResult does — otherwise a
  // ghost activeFeature / vertex selection revives and lingers (#5 recurs on the
  // undo/redo path). Pre-fix applyUndoRedoResult ran reresolve ONLY, so these fail.
  describe('applyUndoRedoResult anchor-level existence re-validation (第11波 Fix C, #4=#5)', () => {
    it('drops an active feature that an undo/redo left absent at the current time (multi-anchor time-slice delete)', () => {
      // Feature A is `survived` at the feature-history level (another anchor keeps its
      // history) but does NOT exist at the current time.
      const existence = resolverWith(new Set<string>(), new Set<string>());
      const store = makeStore(existence, { activeFeature: f('A') });
      const result = createCommandResult({ survived: [f('A')] });
      store.getState().applyUndoRedoResult({ tag: 'd1' }, result, { featureId: f('A') });
      // Anchor-level re-validation drops the ghost so a second Delete is not a no-op.
      expect(store.getState().activeFeature).toBeNull();
    });

    it('drops a ghost vertex selection whose owner is absent at the current time after an undo/redo', () => {
      const existence = resolverWith(new Set<string>(), new Set<string>());
      const store = makeStore(existence, {
        vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) },
      });
      const result = createCommandResult({ survived: [f('B')] });
      store.getState().applyUndoRedoResult({ tag: 'd1' }, result);
      expect(store.getState().vertexSelection).toBeNull();
    });

    it('PRESERVES an undo/redo target that DOES exist at the current time (revive is kept)', () => {
      // An undo that REVIVES a feature present at the current time must NOT be dropped
      // by the anchor-level re-validation — the promoted target survives.
      const existence = resolverWith(new Set(['M']), new Set(['nv1', 'nv2']));
      const store = createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        domainEquals: (a, b) => a.tag === b.tag,
        existence,
        initial: { activeFeature: null },
      });
      const result = createCommandResult({
        deleted: [f('A')],
        created: [f('M'), v('nv1'), v('nv2')],
      });
      store.getState().applyUndoRedoResult({ tag: 'd1' }, result, {
        featureId: f('M'),
        vertexSelection: { ownerFeatureId: f('M'), vertexIds: new Set([v('nv1'), v('nv2')]) },
      });
      const s = store.getState();
      expect(s.activeFeature).toBe(f('M'));
      expect(s.vertexSelection).not.toBeNull();
      expect(s.vertexSelection!.ownerFeatureId).toBe(f('M'));
      expect([...s.vertexSelection!.vertexIds]).toEqual([v('nv1'), v('nv2')]);
    });

    it('does not disturb the dirty recomputation (revalidation only tightens selection)', () => {
      // The anchor-level tightening must not perturb the projectDirty recomputation:
      // an undo back to the saved domain still reads clean even when the (absent)
      // selection is pruned in the same transition.
      const existence = resolverWith(new Set<string>(), new Set<string>());
      const store = createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        domainEquals: (a, b) => a.tag === b.tag,
        existence,
        initial: { activeFeature: f('A') },
      });
      store.getState().markProjectSaved(); // clean baseline at d0.
      store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ created: [f('A')] }));
      // Undo back to the saved d0 while A is absent at the current time.
      store.getState().applyUndoRedoResult({ tag: 'd0' }, createCommandResult({ survived: [f('A')] }), {
        featureId: f('A'),
      });
      expect(store.getState().activeFeature).toBeNull(); // ghost pruned.
      expect(store.getState().projectDirty).toBe(false); // back to saved → clean.
    });
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

  // 回帰 (bughunt2): reflectLoadedProject is the ATOMIC LOAD / NEW reflect. The
  // previous two-call form — resetToDomain(project) THEN hydrateSettings(...) —
  // swapped the domain FIRST, so if the settings hydrate threw on an inverted
  // timeline range (timelineMin >= timelineMax, rejected by deriveTimelineState)
  // the throw escaped with the NEW domain already installed alongside the OLD
  // project's settings/range — a half-applied store. The atomic action derives the
  // timeline BEFORE any mutation, so an invalid project throws with the store
  // UNCHANGED: same domain, same settings, same range/time, same dirty flag.
  it('reflectLoadedProject rolls back FULLY when the incoming timeline range is inverted (no half-applied swap)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      mode: EDIT_MODE.Edit,
      activeTool: asToolId('add'),
    });
    // Establish a known-good baseline the failed reflect must not perturb.
    store.getState().hydrateSettings({
      projectSettings: {
        ...DEFAULT_PROJECT_SETTINGS,
        timelineMinYear: 0,
        timelineMaxYear: 100,
        zoomMax: 33,
      },
    });
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);
    const before = store.getState();
    const domainBefore = before.domain;
    const projectSettingsBefore = before.projectSettings;
    const appSettingsBefore = before.appSettings;

    // Attempt to reflect a project whose persisted timeline range is INVERTED
    // (min >= max). This is what a future repair / importer that bypasses the
    // persistence schema could synthesize. The derive must reject it.
    expect(() =>
      store.getState().reflectLoadedProject(
        { tag: 'inverted-load' },
        {
          projectSettings: {
            ...DEFAULT_PROJECT_SETTINGS,
            timelineMinYear: 500,
            timelineMaxYear: 100,
            zoomMax: 99,
          },
          appSettings: { ...DEFAULT_APP_SETTINGS, renderFps: 12 },
        },
      ),
    ).toThrow(/inverted timeline range/);

    // FULL ROLLBACK: nothing was mutated. The domain was NOT swapped (the bug left
    // it swapped), the settings did NOT change to the invalid project's values, and
    // the derived range / currentTime / session state are exactly as before.
    const after = store.getState();
    expect(after.domain).toBe(domainBefore);
    expect(after.domain.tag).toBe('d0');
    expect(after.projectSettings).toBe(projectSettingsBefore);
    expect(after.projectSettings.zoomMax).toBe(33);
    expect(after.appSettings).toBe(appSettingsBefore);
    expect(after.timelineMin).toEqual(timePointYear(0));
    expect(after.timelineMax).toEqual(timePointYear(100));
    expect(after.currentTime).toEqual(timePointYear(50));
  });

  it('reflectLoadedProject applies domain + settings + derived range/time atomically on a valid project', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      mode: EDIT_MODE.Edit,
      activeTool: asToolId('add'),
    });
    store.getState().updateProjectSetting('zoomMax', 9999);
    expect(store.getState().projectDirty).toBe(true);
    // currentTime near the right end of the default 0..10000 range.
    store.getState().setCurrentTime(timePointYear(9000), TIME_CHANGE_SOURCE.Slider);

    store.getState().reflectLoadedProject(
      { tag: 'loaded' },
      {
        projectSettings: {
          ...DEFAULT_PROJECT_SETTINGS,
          timelineMinYear: 0,
          timelineMaxYear: 100,
          zoomMax: 12,
        },
        appSettings: { ...DEFAULT_APP_SETTINGS, renderFps: 24 },
      },
    );

    const s = store.getState();
    // Domain swapped.
    expect(s.domain.tag).toBe('loaded');
    // Old session state discarded (resetToDomain半).
    expect(s.activeFeature).toBeNull();
    expect(s.activeTool).toBeNull();
    expect(s.mode).toBe(EDIT_MODE.View);
    // Settings hydrated to the loaded project (持ち越し防止).
    expect(s.projectSettings.zoomMax).toBe(12);
    expect(s.appSettings.renderFps).toBe(24);
    // Derived range reflects the NEW project; out-of-range currentTime clamped in.
    expect(s.timelineMin).toEqual(timePointYear(0));
    expect(s.timelineMax).toEqual(timePointYear(100));
    expect(s.currentTime).toEqual(timePointYear(100));
    // A LOAD / NEW is a clean baseline.
    expect(s.projectDirty).toBe(false);
  });

  // 回帰 (finding): a LIVE settings-dialog confirm changes the timeline range
  // through updateProjectSetting, NOT hydrateSettings. The slider reads the derived
  // timelineMin/Max mirror + currentTime, so a timeline-key change must re-derive
  // the range and re-clamp currentTime in the SAME transition. Pre-fix,
  // updateProjectSetting wrote only projectSettings, so narrowing the range via the
  // dialog left the slider on the OLD 0..10000 range (and currentTime outside the
  // new range) until a reload.
  it('updateProjectSetting re-derives the timeline range and clamps currentTime when timelineMaxYear changes (finding)', () => {
    const store = makeStore();
    // Default range is 0..10000. Slide near the right end of the OLD range.
    store.getState().setCurrentTime(timePointYear(9000), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().timelineMax).toEqual(timePointYear(10000));

    // Narrow the upper bound via the live dialog path (repro: 10000 -> 100).
    store.getState().updateProjectSetting('timelineMaxYear', 100);

    const s = store.getState();
    // The settings value is written...
    expect(s.projectSettings.timelineMaxYear).toBe(100);
    // ...AND the derived slider range mirror reflects it immediately (no reload).
    expect(s.timelineMax).toEqual(timePointYear(100));
    expect(s.timelineMin).toEqual(timePointYear(0));
    // currentTime (9000) was outside the new range and was clamped to the new max.
    expect(s.currentTime).toEqual(timePointYear(100));
    // A project-setting change still dirty-marks the document.
    expect(s.projectDirty).toBe(true);
  });

  it('updateProjectSetting re-derives the range when timelineMinYear changes (finding)', () => {
    const store = makeStore();
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);

    // Raise the lower bound past the current time.
    store.getState().updateProjectSetting('timelineMinYear', 200);

    const s = store.getState();
    expect(s.timelineMin).toEqual(timePointYear(200));
    // currentTime (50) was below the new min and clamped up to it.
    expect(s.currentTime).toEqual(timePointYear(200));
  });

  it('updateProjectSetting keeps an in-range currentTime unchanged on a timeline-key change', () => {
    const store = makeStore();
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);
    store.getState().updateProjectSetting('timelineMaxYear', 100);
    expect(store.getState().currentTime).toEqual(timePointYear(50));
  });

  it('updateProjectSetting on a NON-timeline key leaves the timeline range and currentTime untouched', () => {
    const store = makeStore();
    store.getState().setCurrentTime(timePointYear(9000), TIME_CHANGE_SOURCE.Slider);
    const before = store.getState();

    store.getState().updateProjectSetting('equatorLengthKm', 50000);

    const s = store.getState();
    expect(s.projectSettings.equatorLengthKm).toBe(50000);
    // Time state is the project-INDEPENDENT axis for a non-timeline key.
    expect(s.timelineMin).toEqual(before.timelineMin);
    expect(s.timelineMax).toEqual(before.timelineMax);
    expect(s.currentTime).toEqual(timePointYear(9000));
  });

  // finding (bughunt2): updateProjectSetting writes a timeline key and re-derives the
  // range, but the order rule timelineMinYear < timelineMaxYear lives only in U38's
  // validateProjectSettings, which the dialog runs BEFORE the store. A non-dialog
  // caller raising timelineMinYear above the current timelineMaxYear used to produce
  // an inverted (min>=max) range, and clampTimeToRange would silently snap currentTime
  // against it with no rejection (空表示). deriveTimelineState now asserts the
  // precondition and rejects an inverted range loudly instead of clamping.
  it('updateProjectSetting rejects an inverted timeline range (min above current max) instead of clamping (finding)', () => {
    const store = makeStore();
    // Default range is 0..10000; slide currentTime into the OLD range.
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);
    const before = store.getState();

    // Raise the lower bound ABOVE the current upper bound (10000) -> would invert.
    expect(() =>
      store.getState().updateProjectSetting('timelineMinYear', 20000),
    ).toThrow(/inverted timeline range/);

    // The rejection leaves the store untouched: no half-applied inverted range,
    // and currentTime was NOT snapped against a min>=max window.
    const after = store.getState();
    expect(after.projectSettings.timelineMinYear).toBe(
      before.projectSettings.timelineMinYear,
    );
    expect(after.timelineMin).toEqual(before.timelineMin);
    expect(after.timelineMax).toEqual(before.timelineMax);
    expect(after.currentTime).toEqual(timePointYear(50));
  });

  // The mirror case: lowering timelineMaxYear below the current timelineMinYear is
  // likewise an inverted range and must be rejected, not clamped.
  it('updateProjectSetting rejects lowering timelineMaxYear below the current min (finding)', () => {
    const store = makeStore();
    // First raise the min to a valid mid value (200 < 10000, still ordered).
    store.getState().updateProjectSetting('timelineMinYear', 200);
    // Now drop the max below that min -> inverted.
    expect(() =>
      store.getState().updateProjectSetting('timelineMaxYear', 100),
    ).toThrow(/inverted timeline range/);
    // The earlier valid min survives; nothing half-applied.
    expect(store.getState().projectSettings.timelineMinYear).toBe(200);
    expect(store.getState().projectSettings.timelineMaxYear).toBe(
      DEFAULT_PROJECT_SETTINGS.timelineMaxYear,
    );
  });

  // 回帰 (bughunt2 二巡目): the finding alleged that a single-key timeline write
  // which inverts the range "leaks a half-applied store" — committing the dirty
  // flags / change-notification while the inverted projectSettings is NOT written.
  // That is impossible by construction: deriveTimelineState is evaluated and the
  // patch assigned BEFORE the single set(), so an inverting write throws with NO
  // mutation at all. This test pins the COMPLETE no-partial-failure contract that
  // the earlier tests left implicit: projectDirty, lastSettingsChange, the
  // projectSettings slice AND the derived range/time mirror must ALL be exactly
  // their pre-call values after the throw — there is no stranded half-commit.
  it('updateProjectSetting commits NOTHING on an inverting single-key timeline write (no half-applied store: dirty flag + change notification + settings + derived mirror all untouched) (finding)', () => {
    const store = makeStore();
    // Start from a known-CLEAN baseline so a stray projectDirty=true would be
    // visible, and put currentTime inside the OLD range (would be snapped if the
    // inverted derive ran). Default range is 0..10000.
    store.getState().setCurrentTime(timePointYear(50), TIME_CHANGE_SOURCE.Slider);
    store.getState().markProjectSaved();
    const before = store.getState();
    expect(before.projectDirty).toBe(false);

    // Raise the lower bound above the current upper bound (10000) -> inversion.
    expect(() =>
      store.getState().updateProjectSetting('timelineMinYear', 20000),
    ).toThrow(/inverted timeline range/);

    const after = store.getState();
    // The dirty flag was NOT armed (the finding's "strand projectDirty" claim).
    expect(after.projectDirty).toBe(false);
    // No change notification was emitted (the finding's "lastSettingsChange unset").
    expect(after.lastSettingsChange).toEqual(before.lastSettingsChange);
    // The whole projectSettings slice is byte-for-byte the pre-call value (the
    // inverted timelineMinYear was NOT written — no partial commit).
    expect(after.projectSettings).toEqual(before.projectSettings);
    // The derived range mirror + currentTime were never re-derived/snapped.
    expect(after.timelineMin).toEqual(before.timelineMin);
    expect(after.timelineMax).toEqual(before.timelineMax);
    expect(after.currentTime).toEqual(timePointYear(50));
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

// --- bughunt2 再発防止: one camera change is ONE store transition ------------
// publishCameraHooks (App.tsx) once issued TWO separate set() calls per live
// camera change — updateCamera({...,centerLon}) then setCenterLon(centerLon) —
// firing the store subscription twice on the hottest path (every pan move /
// wheel notch). updateCamera now mirrors centerLon into the top-level FR-12
// longitude truth inside the SAME set(), so the subscription fires once and the
// two truths can never diverge between transitions (二重真実源を作らない, 教訓 5.29).
describe('bughunt2: updateCamera mirrors centerLon in a single set()', () => {
  it('a camera change carrying centerLon fires the subscription exactly once', () => {
    const store = makeStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.getState().updateCamera({ zoom: 3, centerLon: 42, centerLat: 7 });

    // ONE transition for the whole camera change (not updateCamera + setCenterLon).
    expect(notifications).toBe(1);
    // Both longitude truths advanced together in that single transition.
    const s = store.getState();
    expect(s.camera.centerLon).toBe(42);
    expect(s.centerLon).toBe(42);
    expect(s.camera.zoom).toBe(3);
    expect(s.camera.centerLat).toBe(7);
  });

  it('a zoom-only update leaves the top-level centerLon untouched', () => {
    const store = makeStore(undefined, { centerLon: 99 });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.getState().updateCamera({ zoom: 5 });

    expect(notifications).toBe(1);
    expect(store.getState().camera.zoom).toBe(5);
    // No centerLon in the patch -> the FR-12 longitude truth is not disturbed.
    expect(store.getState().centerLon).toBe(99);
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

  it('setActiveTool(tool, preserveSelection) re-arms WITHOUT broadcasting an empty selection (bughunt round-2 flicker)', () => {
    // Regression for: reArmActiveTool toggled the tool null→prev and CLEARED the
    // selection at the null step, restoring it only one microtask later. Every
    // subscriber (canvas redraw / property panel / sidebar) therefore observed a
    // transient activeFeature=null frame between the two transitions — an extra
    // empty-selection render that self-corrected one tick later. The fix pins the
    // committed selection to BOTH toggle steps via preserveSelection so no frame is
    // ever empty.
    const store = makeStore(undefined, { activeFeature: f('A') });
    store.getState().setActiveTool(asToolId('rect'));
    store.getState().setActiveFeature(f('A'));
    const retained = store.getState().selection;

    // Record every activeFeature value a subscriber sees during the re-arm.
    const observedActive: Array<ReturnType<typeof f> | null> = [];
    const observedTool: Array<ReturnType<typeof asToolId> | null> = [];
    const unsubscribe = store.subscribe((s) => {
      observedActive.push(s.activeFeature);
      observedTool.push(s.activeTool);
    });

    // The exact re-arm sequence App.reArmActiveTool runs (synchronous null step +
    // re-arm step; the microtask boundary does not affect what each set() emits).
    store.getState().setActiveTool(null, retained); // re-arm step 1
    store.getState().setActiveTool(asToolId('rect'), retained); // re-arm step 2
    unsubscribe();

    // The tool STILL toggles null→prev, so the add/knife controller reset funnel
    // (keyed on activeTool) fires exactly as before — the draft is still discarded.
    expect(observedTool).toEqual([null, asToolId('rect')]);
    // But NO subscriber ever observes an empty selection: the committed feature is
    // preserved across BOTH transitions (no flicker / no extra empty redraw).
    expect(observedActive).toEqual([f('A'), f('A')]);
    expect(observedActive).not.toContain(null);

    // Final state: tool re-armed, committed selection intact.
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().activeTool).toBe(asToolId('rect'));
  });

  it('setActiveTool(tool) without preserveSelection still clears (reset契約 default unchanged)', () => {
    const store = makeStore(undefined, { activeFeature: f('A') });
    store.getState().setActiveTool(asToolId('rect'));
    store.getState().setActiveFeature(f('A'));
    expect(store.getState().activeFeature).toBe(f('A'));
    // Default path (no second arg) keeps wiping the selection (教訓 5.2).
    store.getState().setActiveTool(asToolId('edit.knife'));
    expect(store.getState().activeFeature).toBeNull();
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

// --- setActiveFeature selection hygiene (第10波 #2) --------------------------
//
// setActiveFeature is called DIRECTLY (bypassing the U22 reducer's FeatureBody
// branch and promoteHitToSelection, both of which clear the vertex set) by four
// UI paths: the sidebar 地物一覧 / 詳細, the property-panel feature pick, and the
// search / help-tools promotion (SidebarContent / App / HelpToolsController). If
// setActiveFeature only re-applied withActiveFeature it would leave a stale
// vertex set (vertexIds + vertexOwner) owned by a DIFFERENT feature behind. The
// Delete导線 (runEditDelete) reads vertexOwner/vertexIds FIRST, so selecting
// feature A from a panel while a vertex of feature B is still selected, then
// pressing Delete, would delete B's vertex — acting on a feature the user did NOT
// pick. So setActiveFeature must clear the vertex selection when the new active
// feature is NOT the current vertex owner, while PRESERVING it for a re-select of
// the SAME feature (so a panel re-click of the owner does not wipe a live vertex
// edit). It re-uses U22's withoutVertexSet — it re-implements no rule.
describe('setActiveFeature selection hygiene (第10波 #2)', () => {
  it('clears a DIFFERENT owner\'s vertex selection when a new feature becomes active', () => {
    // A vertex of feature B is selected; the user then picks feature A from a panel.
    const store = makeStore(undefined, {
      vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) },
    });
    expect(store.getState().vertexSelection).not.toBeNull(); // B's vertex is selected.

    store.getState().setActiveFeature(f('A'));

    const s = store.getState();
    expect(s.activeFeature).toBe(f('A')); // A is now active...
    // ...and B's stale vertex selection is gone, so a Delete cannot hit B's vertex.
    expect(s.vertexSelection).toBeNull();
    expect(s.selection.vertexOwner).toBeNull();
    expect([...s.selection.vertexIds]).toEqual([]);
  });

  it('PRESERVES the vertex selection when re-selecting the SAME feature (its owner)', () => {
    // A vertex of feature A is selected AND A is already active; a panel re-click of
    // A must not wipe the live vertex selection (activeFeature === vertexOwner).
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1'), v('v2')]) },
    });

    store.getState().setActiveFeature(f('A'));

    const vs = store.getState().vertexSelection;
    expect(vs).not.toBeNull();
    expect(vs!.ownerFeatureId).toBe(f('A'));
    expect([...vs!.vertexIds]).toEqual([v('v1'), v('v2')]); // preserved, not wiped.
  });

  it('clears the vertex selection when the new active feature is NOT the owner even if it matches the OLD active feature', () => {
    // The vertex owner (B) differs from the active feature (A); re-selecting A must
    // STILL drop B's vertex selection — the guard keys off the vertex OWNER, not the
    // previous activeFeature (a食い違い activeFeature=A / vertexOwner=B must be healed).
    const store = makeStore(undefined, {
      activeFeature: f('A'),
    });
    // Force the食い違い: replace vertices under B (leaves activeFeature = A) …
    store.getState().replaceVertexSelection(f('B'), [v('v1')]);
    // (replaceVertices does not touch activeFeature, so activeFeature stays A.)
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().vertexSelection!.ownerFeatureId).toBe(f('B'));

    store.getState().setActiveFeature(f('A')); // re-select A (== old active, != owner B)

    const s = store.getState();
    expect(s.activeFeature).toBe(f('A'));
    expect(s.vertexSelection).toBeNull(); // B's vertex dropped despite A == old active.
  });

  it('clears a stale vertex selection when setting active feature to null', () => {
    const store = makeStore(undefined, {
      vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) },
    });
    store.getState().setActiveFeature(null);
    const s = store.getState();
    expect(s.activeFeature).toBeNull();
    // null differs from owner B → the stale vertex set is dropped.
    expect(s.vertexSelection).toBeNull();
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

  // bughunt3 regression: a NO-OP display-control write (same value) must PRESERVE
  // the `displayControl` reference. The display pipeline's shared memos
  // (resolveDisplayFor / buildCommittedFeatures) and the Canvas redraw subscription
  // all key on `displayControl` IDENTITY, treating reference == value. A slider drag
  // emits many events at the SAME integer depth; if each repeated-value call spread a
  // fresh-but-equal object, every memo would miss and the pipeline + redraw would re-run
  // for unchanged geometry. An unchanged depth/focus must therefore keep ONE identity.
  it('no-op display-control writes preserve the displayControl reference (identity stability)', () => {
    const store = makeStore();
    // Establish a non-default state once, then capture the reference.
    store.getState().setGlobalDepth(3);
    store.getState().setDisplayFocus({ originId: f('B'), depth: 5, emphasize: true });
    const ref = store.getState().displayControl;

    // Re-writing the SAME values (the slider-drag-at-same-step case) must NOT churn
    // a new object — the reference is unchanged, so the display memos / redraw stay hit.
    store.getState().setGlobalDepth(3);
    expect(store.getState().displayControl).toBe(ref);

    store.getState().setFocusOrigin(f('B'));
    expect(store.getState().displayControl).toBe(ref);

    store.getState().setFocusDepth(5);
    expect(store.getState().displayControl).toBe(ref);

    store.getState().setFocusEmphasize(true);
    expect(store.getState().displayControl).toBe(ref);

    store.getState().setDisplayFocus({ originId: f('B'), depth: 5, emphasize: true });
    expect(store.getState().displayControl).toBe(ref);

    // And a notifier subscriber is NOT fired by a no-op write (no spurious redraw).
    const seen = vi.fn();
    const unsub = store.subscribe((s) => seen(s.displayControl));
    store.getState().setGlobalDepth(3); // no-op
    store.getState().setFocusEmphasize(true); // no-op
    expect(seen).not.toHaveBeenCalled();
    unsub();

    // A genuine CHANGE still swaps the reference and fires the subscriber.
    store.getState().setGlobalDepth(4);
    expect(store.getState().displayControl).not.toBe(ref);
    expect(store.getState().displayControl.globalDepth).toBe(4);
  });

  it('clearDisplayFocus is a no-op (reference preserved) when focus is already cleared', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    const ref = store.getState().displayControl; // focus already NO_DISPLAY_FOCUS
    store.getState().clearDisplayFocus();
    expect(store.getState().displayControl).toBe(ref);
  });

  // bughunt3 regression: resetToDomain (LOAD / NEW) must PRESERVE the displayControl
  // reference when the focus is already cleared. The display pipeline's shared memos
  // (resolveDisplayFor / buildCommittedFeatures) and the Canvas redraw subscription
  // key on displayControl IDENTITY (reference == value). Before the fix the reset path
  // unconditionally spread `{ ...dc, focus: NO_DISPLAY_FOCUS }`, minting a value-EQUAL
  // but reference-NEW object on every load (even at the default globalDepth=0 / no
  // focus), busting every memo and forcing a redundant pipeline run + redraw although
  // depth and geometry were unchanged.
  it('resetToDomain preserves the displayControl reference when focus is already cleared (bughunt3 identity)', () => {
    const store = makeStore();
    // A typical load baseline: a global depth set, no individual focus.
    store.getState().setGlobalDepth(2);
    const ref = store.getState().displayControl; // focus already NO_DISPLAY_FOCUS
    expect(ref.focus.originId).toBeNull();

    store.getState().resetToDomain({ tag: 'loaded' });

    const after = store.getState().displayControl;
    // SAME reference: a load with no active focus is a memo HIT, not a new generation.
    expect(after).toBe(ref);
    // Global depth N (project-independent) preserved; focus still cleared.
    expect(after.globalDepth).toBe(2);
    expect(after.focus.originId).toBeNull();
  });

  it('resetToDomain still clears a STALE focus (and swaps the reference) on load', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    store.getState().setDisplayFocus({ originId: f('A'), depth: 4, emphasize: true });
    const ref = store.getState().displayControl; // focus is ACTIVE here

    store.getState().resetToDomain({ tag: 'loaded' });

    const after = store.getState().displayControl;
    // A real change (stale per-feature focus dropped) must swap the reference...
    expect(after).not.toBe(ref);
    // ...with the focus cleared and the global depth preserved (教訓 5.13).
    expect(after.focus.originId).toBeNull();
    expect(after.focus.depth).toBe(0);
    expect(after.focus.emphasize).toBe(false);
    expect(after.globalDepth).toBe(2);
  });

  // bughunt3 regression: applyCommandResult re-resolves the SELECTION against the
  // CommandResult (deleted IDs dropped, 教訓 5.11) but historically left the per-
  // feature display focus ALONE. A structure-changing command — e.g. a conflict
  // resolution that merges / deletes a feature — can remove the very feature the
  // focus origin points at. Without re-resolving the focus, focus.originId dangled
  // at a deleted feature after the edit, surviving until the next load. The focus is
  // now re-resolved on the SAME path: a deleted origin is cleared to global N.
  it('applyCommandResult clears a display focus whose origin the command deleted (bughunt3)', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    store.getState().setDisplayFocus({ originId: f('X'), depth: 4, emphasize: true });

    // The edit (conflict resolution merging X away) deletes the focused feature X.
    const result = createCommandResult({
      survived: [f('Y')],
      created: [f('M')],
      deleted: [f('X')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result);

    const dc = store.getState().displayControl;
    // The dangling per-feature focus is dropped (revert to global N)...
    expect(dc.focus.originId).toBeNull();
    expect(dc.focus.depth).toBe(0);
    expect(dc.focus.emphasize).toBe(false);
    // ...while the project-independent global depth N is preserved (教訓 5.13).
    expect(dc.globalDepth).toBe(2);
  });

  it('applyCommandResult keeps a display focus whose origin survived, preserving identity (bughunt3)', () => {
    const store = makeStore();
    store.getState().setGlobalDepth(2);
    store.getState().setDisplayFocus({ originId: f('X'), depth: 4, emphasize: true });
    const ref = store.getState().displayControl;

    // An ordinary edit that does NOT touch the focused feature X. The focus origin
    // survives, so the displayControl reference must be PRESERVED (no memo churn):
    // the display pipeline / redraw key on displayControl identity.
    const result = createCommandResult({
      survived: [f('X'), f('Y')],
      deleted: [f('Z')],
    });
    store.getState().applyCommandResult({ tag: 'd1' }, result);

    const dc = store.getState().displayControl;
    expect(dc).toBe(ref); // same reference: an unrelated edit is a focus memo HIT
    expect(dc.focus.originId).toBe(f('X'));
    expect(dc.focus.depth).toBe(4);
    expect(dc.focus.emphasize).toBe(true);
  });
});
