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
import type { DisplayGrabbabilityResolver } from './grabbability';
import {
  APP_SETTING_KEYS,
  PROJECT_SETTING_KEYS,
  SETTINGS_SCOPE,
  classifySettingKey,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
} from './settings';
import { EDIT_MODE, asToolId, type EditMode, type ToolId } from './session';
import { ALL_TOOLS, TOOL_ID, modeForTool, toolShowsVertexHandles } from '../shell/tools';
import {
  FEATURE_KIND_AXIS,
  KIND_LABEL_TOGGLE,
  LEDGER_MODE,
} from '../discovery/index';
import { EMPTY_HIT, IDLE_TRANSIENT, replaceVertices } from '../../domain/selection';
// A5 の結合検査で「その mode だと地図の左クリックがどこへ行くか」まで見るため、
// U40 の行き先の決定（同じ 1 本）を引く。行き先を自前で書き写すと二重の真実源になる。
import { DISPATCH_TARGET, POINTER_BUTTON, decideDispatch } from '../map/dispatch';
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

/** 頂点を選んでいられるのは「頂点」「動かす」の道具のあいだだけ（B114）。 */
const VERTEX_TOOL = { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditVertex } as const;

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

  it('replaceBaseMap (FR-04): swaps domain + marks dirty + bumps the replace nonce, WITHOUT a whole-state reset', () => {
    // F2: a base-map replace is a base-map-only edit, not an external load/new. It must
    // mark the project dirty (教訓 5.36) and SIGNAL itself (basemapReplaceNonce) so the
    // history owner (App) preserves the edit undo/redo stacks — but it must NOT discard
    // selection / tool / mode the way resetToDomain (load/new) does.
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      mode: EDIT_MODE.Edit,
      activeTool: asToolId('add'),
    });
    expect(store.getState().basemapReplaceNonce).toBe(0);

    store.getState().replaceBaseMap({ tag: 'basemap-swapped' });

    const s = store.getState();
    expect(s.domain.tag).toBe('basemap-swapped');
    // A base-map replace dirties the project (like any edit).
    expect(s.projectDirty).toBe(true);
    // The distinguishing signal: the monotonic nonce bumped (App reads it to preserve
    // history instead of re-rooting).
    expect(s.basemapReplaceNonce).toBe(1);
    // The session state is NOT reset (this is not a load/new whole-state swap).
    expect(s.activeFeature).toEqual(f('A'));
    expect(s.mode).toBe(EDIT_MODE.Edit);
    expect(s.activeTool).toBe(asToolId('add'));

    // A second replace bumps the nonce again (each replace is a distinct signal).
    store.getState().replaceBaseMap({ tag: 'basemap-swapped-2' });
    expect(store.getState().basemapReplaceNonce).toBe(2);
  });

  it('re-resolves selection from a command result (NOT a blanket clear, 教訓 5.11)', () => {
    const store = makeStore(undefined, {
      activeFeature: f('A'),
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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
    const store = makeStore(undefined, { ...VERTEX_TOOL, activeFeature: null });
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
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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
    const store = makeStore(existence, { ...VERTEX_TOOL, activeFeature: null });
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
      ...VERTEX_TOOL,
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1'), v('v2')]) },
    });

    store.getState().setCurrentTime(timePointYear(100), TIME_CHANGE_SOURCE.Slider);
    const vs = store.getState().vertexSelection;
    expect(vs).not.toBeNull();
    expect([...vs!.vertexIds]).toEqual([v('v1')]);

    // Now move to a time where no vertex exists -> context resolved away.
    const store2 = makeStore(resolverWith(new Set(['A']), new Set<string>()), {
      ...VERTEX_TOOL,
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

  // --- F2 確認レビュー 点4: byte-only base-map replace dirty tracking ----------
  //
  // The base-map IMAGE BYTES live OUTSIDE the domain snapshot: App holds them
  // (baseMapImageRef 表示 / loadedAssetsRef 保存) and the domain carries only
  // baseMap.source/meta. So the injected domainEquals (App wires projectsEqual →
  // baseMapsEqual) compares the base map by source/meta ONLY, never the bytes. A replace
  // of an ALREADY-user project with different bytes KEEPS source/meta (basemap-replace
  // stamps REPLACED_BASEMAP_SOURCE only for a preset/empty project, else preserves
  // source/meta), so ONLY the bytes change — invisible to domainEquals. Pre-fix, an
  // undo/redo AFTER such a replace found the domain value-equal to the saved baseline and
  // FALSELY cleared projectDirty (applyUndoRedoResult), so the unsaved byte replacement
  // read as saved and was lost on close. The store keeps a baseMapBytesDirtySinceSave
  // flag: SET by replaceBaseMap, CLEARED by EVERY clean baseline (save + LOAD / NEW),
  // NEVER cleared by an undo/redo, and OR-ed into the undo/redo clean check. These tests
  // pin all three points (set / clear / OR) so a missing one (= wrong-clean or
  // wrong-dirty) is caught.
  describe('byte-only base-map replace dirty tracking (F2 review 点4)', () => {
    // Same value-equality helper as the undo/redo bughunt block: a byte-only replace
    // keeps the SAME tag (source/meta unchanged), so domainEquals cannot see it.
    function replaceStore() {
      return createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        domainEquals: (a, b) => a.tag === b.tag,
      });
    }
    const edit = createCommandResult({ created: [f('A')] });
    const undoResult = createCommandResult({ deleted: [f('A')] });

    // CORE (the previous hole, set + OR): a byte-only replace whose source/meta are
    // UNCHANGED (same tag) must keep the project dirty across an edit + undo.
    // domainEquals(d0,d0)=true would falsely clear it; the byte-since-save flag holds
    // dirty until an actual save. Pre-fix this is the failing (red) case.
    it('a byte-only replace stays dirty across an edit + undo (previous hole)', () => {
      const store = replaceStore();
      store.getState().markProjectSaved(); // clean saved baseline at d0 (already-user map).
      expect(store.getState().projectDirty).toBe(false);

      // Replace the base-map BYTES only — source/meta (hence the tag) are unchanged.
      store.getState().replaceBaseMap({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(true);

      // Edit a feature, then undo it back to the saved domain value (d0).
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);

      // The unsaved byte replacement must SURVIVE the undo: domainEquals(d0,d0)=true but
      // the bytes still differ from the saved file, so the project stays dirty.
      expect(store.getState().projectDirty).toBe(true);
    });

    // CLEAR (save): a save persists the bytes (buildSaveRequest ships loadedAssetsRef →
    // assets/basemap.img), so markProjectSaved clears the byte flag; the project is then
    // clean and a later edit + undo returns to clean (the flag is not re-armed).
    it('a save after a byte-only replace clears dirty, and a later edit + undo returns clean', () => {
      const store = replaceStore();
      store.getState().markProjectSaved();
      store.getState().replaceBaseMap({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(true);

      // Save persists the new bytes → clean (the byte flag is cleared).
      store.getState().markProjectSaved();
      expect(store.getState().projectDirty).toBe(false);

      // A later edit + undo back to the saved domain reads clean (byte flag stays false):
      // the only dirt was the edit, which was undone.
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // CLEAR (LOAD): reflectLoadedProject is a fresh baseline with its own on-disk bytes,
    // so it clears the byte flag — a later edit + undo on the loaded project reads clean.
    it('a LOAD (reflectLoadedProject) clears the byte-replace flag', () => {
      const store = replaceStore();
      store.getState().markProjectSaved();
      store.getState().replaceBaseMap({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(true);

      store.getState().reflectLoadedProject({ tag: 'd0' }, {});
      expect(store.getState().projectDirty).toBe(false);
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // CLEAR (NEW): resetToDomain is the whole-state NEW path; it likewise clears the flag.
    it('a NEW (resetToDomain) clears the byte-replace flag', () => {
      const store = replaceStore();
      store.getState().markProjectSaved();
      store.getState().replaceBaseMap({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(true);

      store.getState().resetToDomain({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(false);
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // CLEAR (settings hydrate): hydrateSettings also establishes a clean baseline (it
    // writes savedDomain and clears projectDirty), so it must clear the byte flag too —
    // the same invariant every savedDomain-writing path shares.
    it('a settings hydrate (hydrateSettings) clears the byte-replace flag', () => {
      const store = replaceStore();
      store.getState().markProjectSaved();
      store.getState().replaceBaseMap({ tag: 'd0' });
      expect(store.getState().projectDirty).toBe(true);

      store.getState().hydrateSettings({});
      expect(store.getState().projectDirty).toBe(false);
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // 回帰: a normal edit + undo WITHOUT any replace is unaffected — the byte flag is
    // never armed, so an undo back to the saved domain still reads clean (no wrong-dirty).
    it('a normal edit + undo without a replace still reads clean (flag not falsely armed)', () => {
      const store = replaceStore();
      store.getState().markProjectSaved();
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      expect(store.getState().projectDirty).toBe(true);
      store.getState().applyUndoRedoResult({ tag: 'd0' }, undoResult);
      expect(store.getState().projectDirty).toBe(false);
    });

    // 二重で安全: a replace that ALSO changes source/meta (preset→user: the tag differs)
    // is dirty through domainEquals too — the domain compare and the flag agree, so it
    // stays dirty across an edit + undo exactly as before the fix.
    it('a source/meta-changing replace stays dirty across an edit + undo (domain compare + flag)', () => {
      const store = replaceStore();
      store.getState().markProjectSaved(); // baseline at d0.
      // A preset→user replace changes source (→ a different tag than the saved d0).
      store.getState().replaceBaseMap({ tag: 'd-user' });
      store.getState().applyCommandResult({ tag: 'd1' }, edit);
      // Undo returns to the post-replace state d-user, which differs from the saved d0.
      store.getState().applyUndoRedoResult({ tag: 'd-user' }, undoResult);
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
        ...VERTEX_TOOL,
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
        initial: { ...VERTEX_TOOL, activeFeature: null },
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
  it('setMode は道具を必ず外し、「直せる ⇄ 直せる」では選択も捨てる', () => {
    const store = makeStore(undefined, {
      mode: EDIT_MODE.Add,
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

  // 増分 4 の手直し B12 / 所有者の裁定「読むだけでも選べる・読める・直せない」。
  // 鍵を掛けて掛け直すと選択が消えていたので、束のカーソルだけが残って食い違った。
  it('setMode は「読むだけ ⇄ 直せる」では選択を捨てない（道具だけ外す）', () => {
    const store = makeStore(undefined, {
      mode: EDIT_MODE.Edit,
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
      activeTool: asToolId('pen'),
    });
    store.getState().setMode(EDIT_MODE.View);
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().activeTool).toBeNull();
    store.getState().setMode(EDIT_MODE.Edit);
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  // **増分 5c で既定が反転した**（`docs/現状.md` B28）。旧版は「道具を替えたら選択を
  // 全消しする」が既定で、一覧で目的の地物を選んでからナイフを構えると **構えた瞬間に
  // 対象が消えて**選び直しになっていた（実測 2.65 秒／回）。教訓 5.2 が捨てろと言って
  // いるのは一時的な UI 状態であって、選択は利用者の作業文脈そのものである
  // （設計書 §D.7 / 開発ガイド §5.2 の読み替え）。
  it('道具を持ち替えても地物の選択は残る（B28 の解消）', () => {
    const store = makeStore(undefined, {
      // **鍵は開けておく**（増分 5b）。ストアの既定は「読むだけ」で、そのあいだは
      // 道具を構えられない（K-6 の関門）。
      mode: EDIT_MODE.Edit,
      activeFeature: f('A'),
    });
    store.getState().setActiveTool(asToolId('rect'));
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().activeTool).toBe(asToolId('rect'));
    // 別の道具へ持ち替えても残る（「1 回目だけ残る」ではない）。
    store.getState().setActiveTool(asToolId('edit.knife'));
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('頂点の選択は「頂点の道具から出るとき」だけ捨てる（設計書 §D.2）', () => {
    const store = makeStore(undefined, {
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditVertex,
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
    });
    // 頂点の道具の中で持ち替えない限り、頂点は掴んだまま。
    store.getState().setActiveTool(TOOL_ID.EditVertex);
    expect(store.getState().vertexSelection?.vertexIds.size).toBe(1);
    // 出ると捨てる（地物の選択は残る）。
    store.getState().setActiveTool(TOOL_ID.EditKnife);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('restoreSelection は捕まえた選択をそのまま戻せる（教訓 5.11 の口は残す）', () => {
    // **増分 5c で前提が変わった**: 再武装の null→prev で選択が消えなくなったので、
    // この口は「消えたものを戻す」ためではなく「捕まえた値をそのまま適用し直す」
    // ためのものになった（競合解決の確定が昇格させた地物を明示的に指す経路）。
    const store = makeStore(undefined, { mode: EDIT_MODE.Edit, activeFeature: f('A') });
    store.getState().setActiveTool(asToolId('rect'));
    store.getState().setActiveFeature(f('A'));
    const retained = store.getState().selection;

    store.getState().setActiveTool(null); // 再武装 1 段目
    expect(store.getState().activeFeature).toBe(f('A')); // もう消えない
    store.getState().setActiveTool(asToolId('rect')); // 再武装 2 段目

    store.getState().restoreSelection(retained);
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
    const store = makeStore(undefined, { mode: EDIT_MODE.Edit, activeFeature: f('A') });
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

  it('掴んでいる最中の一時状態は、道具を持ち替えたら必ず捨てる（教訓 5.2 の本体）', () => {
    const store = makeStore(undefined, { mode: EDIT_MODE.Edit, activeFeature: f('A') });
    store.getState().setActiveTool(asToolId('rect'));
    store.getState().setActiveFeature(f('A'));
    expect(store.getState().activeFeature).toBe(f('A'));
    // 選択は残るが、`transient`（掴みかけ）は残さない ―― 残すと次の押下が
    // 前の掴みの続きになる。捨てる契約そのものは変えていない。
    store.getState().setActiveTool(asToolId('edit.knife'));
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().selection.transient).toBe(IDLE_TRANSIENT);
  });
});

// --- vertex selection update rules (FR-80 / FR-81) --------------------------

describe('vertex selection update rules (FR-80 / FR-81)', () => {
  it('replace sets the whole selection set', () => {
    const store = makeStore(undefined, VERTEX_TOOL);
    store.getState().replaceVertexSelection(f('A'), [v('v1'), v('v2')]);
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1'), v('v2')]);
  });

  it('toggle adds then removes a vertex; emptying resolves the context away', () => {
    const store = makeStore(undefined, VERTEX_TOOL);
    store.getState().toggleVertexSelection(f('A'), v('v1'));
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1')]);
    store.getState().toggleVertexSelection(f('A'), v('v1'));
    expect(store.getState().vertexSelection).toBeNull();
  });

  it('add merges vertices into an existing same-owner context', () => {
    const store = makeStore(undefined, VERTEX_TOOL);
    store.getState().replaceVertexSelection(f('A'), [v('v1')]);
    store.getState().addVerticesToSelection(f('A'), [v('v2'), v('v3')]);
    expect([...store.getState().vertexSelection!.vertexIds]).toEqual([v('v1'), v('v2'), v('v3')]);
  });

  it('switching owner starts a fresh context (FR-81: one owner)', () => {
    const store = makeStore(undefined, VERTEX_TOOL);
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
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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
      ...VERTEX_TOOL,
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

  // === 選択 heal の対称性 (root / time / control ↔ 選択, S4c で全枝完成) =======
  //
  // Any display-resolution input change — a displayControl setter, a time change, or
  // a domain swap — can make selected vertices vanish from the display owner lookup,
  // and the property panel would show「選択頂点の所有地物を特定できません」
  // (CONTEXT_KIND.Unknown). The store heals through the ONE revalidateDisplay funnel
  // (U22 revalidateForDisplay over the INJECTED displayOwnersAt port) — the
  // display-axis sibling of setCurrentTime's revalidateForTime (教訓 5.5/5.6). It
  // re-implements NO display-verdict logic (単一真実源): tests inject fake lookups,
  // proving the dependency injection.

  /**
   * A display-owner port over a fixed vid→owner map, with `hidden` features treated
   * as not drawn (their vertices resolve to nothing) — mirrors owners membership.
   */
  function displayOwners(
    entries: Record<string, string>,
    hidden: readonly string[] = [],
  ): DisplayGrabbabilityResolver {
    const hiddenSet = new Set(hidden);
    return {
      displayOwnersAt: () => ({
        ownerOf: (vid) => {
          const owner = entries[vid as unknown as string];
          return owner !== undefined && !hiddenSet.has(owner) ? f(owner) : null;
        },
      }),
    };
  }

  function storeWithVertexSelection(
    grabbability: DisplayGrabbabilityResolver,
    owner: string,
    vertexIds: readonly string[],
    activeFeature?: string,
  ) {
    return createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      grabbability,
      initial: {
        // Start at a NON-default depth so the tests' setGlobalDepth(0) is an actual
        // change (the default is already globalDepth 0 → a no-op that would skip the heal).
        displayControl: { globalDepth: 5, focus: { originId: null, depth: 0, emphasize: false } },
        ...VERTEX_TOOL,
        vertexSelection: { ownerFeatureId: f(owner), vertexIds: new Set(vertexIds.map(v)) },
        ...(activeFeature ? { activeFeature: f(activeFeature) } : {}),
      },
    });
  }

  it('prunes the vertex selection when a DEPTH change hides its owner (Unknown 回避)', () => {
    const store = storeWithVertexSelection(
      displayOwners({ v0: 'A', v1: 'A' }, ['A']),
      'A',
      ['v0', 'v1'],
    );
    // Owner A is rolled up into an aggregate at this depth → its vertices no longer
    // resolve, so the dangling selection is pruned (would otherwise be Unknown).
    store.getState().setGlobalDepth(0);
    const s = store.getState();
    expect(s.selection.vertexOwner).toBeNull();
    expect(s.selection.vertexIds.size).toBe(0);
    expect(s.vertexSelection).toBeNull();
  });

  it('prunes the vertex selection when a FOCUS change hides its owner', () => {
    const store = storeWithVertexSelection(displayOwners({ v0: 'A' }, ['A']), 'A', ['v0']);
    store.getState().setDisplayFocus({ originId: f('B'), depth: 5, emphasize: false });
    expect(store.getState().selection.vertexOwner).toBeNull();
    expect(store.getState().selection.vertexIds.size).toBe(0);
  });

  it('KEEPS the vertex selection when its owner still draws its own shape (not a blanket clear)', () => {
    // Only B is hidden; the selection owner A still owns its vertices → untouched.
    const store = storeWithVertexSelection(
      displayOwners({ v0: 'A', v1: 'A' }, ['B']),
      'A',
      ['v0', 'v1'],
    );
    const before = store.getState().selection;
    store.getState().setGlobalDepth(3);
    const after = store.getState().selection;
    // Selection truth is preserved by reference (revalidateForDisplay is idempotent),
    // so no redundant selection re-derive fired.
    expect(after).toBe(before);
    expect(after.vertexIds.size).toBe(2);
  });

  it('[Codex MED] a SHARED vertex surviving through another owner is KEPT with vertexOwner rewritten', () => {
    // v0 is A's own vertex, v1 is SHARED with B (first-wins owner was A). Hiding A
    // re-resolves v1 → B while v0 resolves to nothing: the heal keeps {v1} under the
    // surviving owner B instead of blanket-pruning the whole set.
    const store = storeWithVertexSelection(
      displayOwners({ v1: 'B' }),
      'A',
      ['v0', 'v1'],
    );
    store.getState().setGlobalDepth(0);
    const s = store.getState();
    expect([...s.selection.vertexIds]).toEqual([v('v1')]);
    expect(s.selection.vertexOwner).toBe(f('B'));
    expect(s.vertexSelection?.ownerFeatureId).toBe(f('B'));
  });

  it('NEVER prunes vertices owned by the ACTIVE feature, even when it is hidden (handles persist)', () => {
    // A is active AND the vertex owner, and hidden (aggregation-omitted). Its edit
    // handles are still drawn (draw ⊇ hit), so its vertex selection survives.
    const store = storeWithVertexSelection(
      displayOwners({ v0: 'A' }, ['A']),
      'A',
      ['v0'],
      'A',
    );
    store.getState().setGlobalDepth(0);
    const s = store.getState();
    expect(s.selection.activeFeature).toBe(f('A'));
    expect(s.selection.vertexOwner).toBe(f('A'));
    expect(s.selection.vertexIds.size).toBe(1);
  });

  it('prunes a stale vertex set owned by a NON-active hidden feature but keeps the active feature', () => {
    // Active = A (kept); vertex owner = B (hidden) → B's dangling vertices drop, A stays.
    const store = storeWithVertexSelection(
      displayOwners({ v0: 'B' }, ['B']),
      'B',
      ['v0'],
      'A',
    );
    store.getState().setGlobalDepth(0);
    const s = store.getState();
    expect(s.selection.activeFeature).toBe(f('A'));
    expect(s.selection.vertexOwner).toBeNull();
    expect(s.selection.vertexIds.size).toBe(0);
  });

  it('heals through EVERY display-control setter (setFocusDepth / Emphasize / clearDisplayFocus)', () => {
    for (const apply of [
      (st: ReturnType<typeof storeWithVertexSelection>) => st.getState().setFocusDepth(5),
      (st: ReturnType<typeof storeWithVertexSelection>) =>
        st.getState().setFocusEmphasize(true),
      (st: ReturnType<typeof storeWithVertexSelection>) =>
        st.getState().setFocusOrigin(f('Z')),
    ]) {
      const store = storeWithVertexSelection(displayOwners({ v0: 'A' }, ['A']), 'A', ['v0']);
      apply(store);
      expect(store.getState().selection.vertexIds.size).toBe(0);
    }
    // clearDisplayFocus only fires when a focus is currently set — arm one first, then
    // the clear write runs the heal against the hidden-A lookup.
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      grabbability: displayOwners({ v0: 'A' }, ['A']),
      initial: {
        displayControl: { globalDepth: 1, focus: { originId: f('A'), depth: 2, emphasize: true } },
        ...VERTEX_TOOL,
        vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v0')]) },
      },
    });
    store.getState().clearDisplayFocus();
    expect(store.getState().selection.vertexIds.size).toBe(0);
  });

  it('a NO-OP display-control write does not run the heal (display unchanged ⇒ selection untouched)', () => {
    // Even with the owner "hidden", a no-op write (same value) returns early WITHOUT a
    // heal — the display did not change, so there is nothing to re-validate, and the
    // displayControl reference is preserved (bughunt3 identity stability). The heal only
    // fires on an ACTUAL depth/focus change.
    const store = storeWithVertexSelection(displayOwners({ v0: 'A' }, ['A']), 'A', ['v0']);
    const dcRef = store.getState().displayControl; // globalDepth 5 (from the fixture)
    store.getState().setGlobalDepth(5); // no-op (already 5)
    expect(store.getState().displayControl).toBe(dcRef);
    expect(store.getState().selection.vertexIds.size).toBe(1);
  });

  // --- S4c (Codex [HIGH]): the heal runs on EVERY display-resolution input change —
  // time changes and domain swaps, not only displayControl setters. The fakes key on
  // the TIME / the LIVE DOMAIN to prove the store passes the post-change inputs.

  it('[Codex HIGH] setCurrentTime re-validates against the display owners at the NEW time', () => {
    const t1 = timePointYear(10);
    const t2 = timePointYear(200);
    // The owner lookup resolves v0 → A ONLY at t1: at any other time A is rolled up
    // (e.g. it became an aggregate's child at the later time) and v0 resolves to nothing.
    const timeKeyed: DisplayGrabbabilityResolver = {
      displayOwnersAt: (time) => ({
        ownerOf: (vid) => (time === t1 && vid === v('v0') ? f('A') : null),
      }),
    };
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      grabbability: timeKeyed,
      initial: {
        currentTime: t1,
        ...VERTEX_TOOL,
        vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v0')]) },
      },
    });
    // Existence keeps everything (default resolver); only the display heal can prune.
    store.getState().setCurrentTime(t2, TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().selection.vertexIds.size).toBe(0);
    expect(store.getState().selection.vertexOwner).toBeNull();
  });

  it('[Codex HIGH] applyCommandResult / applyUndoRedoResult re-validate against the LIVE post-commit root', () => {
    for (const apply of ['command', 'undoRedo'] as const) {
      // The owner lookup reads the LIVE domain tag at ownerOf time: v0 resolves only
      // while the committed domain is d0 (in d1 the owner is aggregated away). The
      // port is consulted AFTER the domain swap, so it must see d1 → prune.
      const seenTags: string[] = [];
      let liveTag = 'd0';
      const domainKeyed: DisplayGrabbabilityResolver = {
        displayOwnersAt: () => ({
          ownerOf: (vid) => {
            seenTags.push(liveTag);
            return liveTag === 'd0' && vid === v('v0') ? f('A') : null;
          },
        }),
      };
      const store = createSessionStore<TestDomain>({
        initialDomain: { tag: 'd0' },
        grabbability: domainKeyed,
        initial: {
          ...VERTEX_TOOL,
          vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v0')]) },
        },
      });
      store.subscribe((s) => {
        liveTag = s.domain.tag; // mirror of App's live getRoot (post-commit visibility)
      });

      const result = createCommandResult({ survived: [f('A'), v('v0')] });
      if (apply === 'command') {
        store.getState().applyCommandResult({ tag: 'd1' }, result);
      } else {
        store.getState().applyUndoRedoResult({ tag: 'd1' }, result);
      }
      // The heal consulted the port AFTER the commit (it saw d1) and pruned.
      expect(seenTags).toContain('d1');
      expect(store.getState().selection.vertexIds.size).toBe(0);
    }
  });

  it('[Codex HIGH] the timeline re-derive (setProjectTimelineRangeYears) heals at the CLAMPED time', () => {
    const t1 = timePointYear(500);
    // v0 resolves ONLY at the initial t1 reference; the clamp to the new max (year
    // 100) passes a DIFFERENT TimePoint → the owner no longer resolves → prune.
    const timeKeyed: DisplayGrabbabilityResolver = {
      displayOwnersAt: (time) => ({
        ownerOf: (vid) => (time === t1 && vid === v('v0') ? f('A') : null),
      }),
    };
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      grabbability: timeKeyed,
      initial: {
        currentTime: t1,
        ...VERTEX_TOOL,
        vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v0')]) },
      },
    });
    // Shrink the timeline so currentTime (500) clamps to the new max (100).
    store.getState().setProjectTimelineRangeYears(0, 100);
    expect(store.getState().selection.vertexIds.size).toBe(0);
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

// ============================================================================
// A5: `activeTool` と `mode` は必ず一緒に動く ―― 不変条件の全操作走査
// ============================================================================
//
// 増分 5 の手直し A5 / GPT #1・反証 ①。`activeTool` を書く場所は `setActiveTool` だけ
// ではなかった ―― 測量を始めるときにも「地図を覆う入力層を 1 枚に保つ」ために
// `activeTool: null` を書いており、**そこだけ `mode` を書き忘れていた**。結果、面を
// 描いている最中に測量を入り切りすると「画面は選ぶ・内部は追加」になり、左クリックは
// 追加の経路へ送られるのに追加のコントローラは居らず、**選ぶことも追加することも
// できなくなった**。
//
// 個別の操作を 1 つずつ検査しても、この型の欠陥は **次に足された操作**で必ず再発する。
// だから検査を「操作ごと」ではなく **不変条件**にする ―― 「どの操作のあとでも、
// `mode` と `activeTool` は導出式のとおりである」。
//
// そのうえで **新しい操作を足したのに検査へ足し忘れたら落ちる**ようにする:
// 下の TOOL_MODE_OPERATIONS は `SessionStoreActions` のキーを 1 つ残らず並べた表で、
// `Object.keys(store.getState())` の関数値と **集合として一致すること**を検査する。
// ストアに操作を足すとキーが増え、表に無ければその場で落ちる。

/**
 * 不変条件そのもの（設計書 §D.1 の導出式）。
 *
 * 「`mode === modeForTool(mode === 読むだけ, activeTool)`」は **そのままでは読むだけの
 * 側が素通りする**（`locked` が真なら導出式は道具を見ずに `view` を返すので、道具が
 * 何であれ等式が成り立つ）。ここが A5 の穴の隣にある落とし穴なので、2 つの節に
 * 展開して書く:
 *
 *   1. 読むだけなら、道具は必ず外れている（K-6 の関門の裏側 ―― 道具だけ入ると
 *      道具のコントローラが立ち上がって編集の入口が開く）。
 *   2. 読むだけでないなら、`mode` は道具から導いた値と一致する
 *      （面／線／点なら追加、それ以外なら編集）。
 */
function expectToolModeInvariant(
  state: { readonly mode: EditMode; readonly activeTool: ToolId | null },
  label: string,
): void {
  if (state.mode === EDIT_MODE.View) {
    // (1) 読むだけ ⇒ 道具は null。
    expect({ where: label, mode: state.mode, toolIsNull: state.activeTool === null }).toEqual({
      where: label,
      mode: EDIT_MODE.View,
      toolIsNull: true,
    });
    return;
  }
  // (2) 読むだけでない ⇒ 道具から導いた mode と一致する。
  expect({ where: label, mode: state.mode }).toEqual({
    where: label,
    mode: modeForTool(false, state.activeTool),
  });
}

/** 表の 1 行の分け方。**なぜその分類か**は各行の `why` に書く。 */
type OperationGroup =
  /**
   * 不変条件をその場で確かめる操作。引数に文脈が要らない（または固定の値で足りる）
   * ので、**すべての開始状態から一括で呼んで**不変条件を見る。
   */
  | 'invariant'
  /**
   * 引数の選び方そのものが不変条件の要になる操作（道具・鍵・測量・読み込み）。
   * 一括でも回すが、**専用の it で組み合わせを作って**確かめる。
   */
  | 'scenario'
  /**
   * 道具にも鍵にも触らない別の軸の操作で、かつ **呼ぶと走査そのものの前提を
   * 作り替えてしまう**もの。表には理由付きで載せるが、一括ループでは回さない。
   * （いまは該当なし。将来そういう操作が足されたときの置き場として型に残す。）
   */
  | 'unrelated';

interface OperationEntry {
  readonly group: OperationGroup;
  /** なぜこの分類なのか（表を読む人への説明。分類の根拠を必ず書く）。 */
  readonly why: string;
  /** 一括ループで呼ぶ形。`unrelated` は持たない。 */
  readonly run?: (store: ReturnType<typeof makeStore>) => void;
}

const A_FEATURE = f('A');
const A_VERTEX = v('v1');

/**
 * `SessionStoreActions` の **全キー**の表。ここに無いキーがストアにあれば
 * 「表に載っていないキーがある」で落ちる（＝操作を足したら必ずここへ来る）。
 */
const TOOL_MODE_OPERATIONS: Readonly<Record<string, OperationEntry>> = {
  // -- ドメインの橋渡し ------------------------------------------------------
  applyCommandResult: {
    group: 'invariant',
    why: '確定はモードを動かさない約束。動かす形へ書き換わったら落ちてほしい。',
    run: (s) =>
      s.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ survived: [A_FEATURE] })),
  },
  applyUndoRedoResult: {
    group: 'invariant',
    why: '取り消し・やり直しも確定と同じ経路。モードは動かさない。',
    run: (s) =>
      s.getState().applyUndoRedoResult({ tag: 'd1' }, createCommandResult({ survived: [A_FEATURE] })),
  },
  setDomainState: {
    group: 'invariant',
    why: '参照の差し替えだけ。道具にも鍵にも触れない。',
    run: (s) => s.getState().setDomainState({ tag: 'd1' }),
  },
  replaceBaseMap: {
    group: 'invariant',
    why: '下地の差し替えは「道具・鍵を保つ」と明示された経路なので、保った結果が式に合うかを見る。',
    run: (s) => s.getState().replaceBaseMap({ tag: 'd1' }),
  },
  resetToDomain: {
    group: 'scenario',
    why: '読み込み・新規は鍵を読むだけへ戻し道具を外す ―― まさに 2 つを一緒に書く操作。',
    run: (s) => s.getState().resetToDomain({ tag: 'd1' }),
  },
  // -- 選択 -----------------------------------------------------------------
  setActiveFeature: {
    group: 'invariant',
    why: '選択は道具と別の軸。触らないことを式で押さえる。',
    run: (s) => s.getState().setActiveFeature(A_FEATURE),
  },
  replaceVertexSelection: {
    group: 'invariant',
    why: '同上（頂点の選択）。',
    run: (s) => s.getState().replaceVertexSelection(A_FEATURE, [A_VERTEX]),
  },
  toggleVertexSelection: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().toggleVertexSelection(A_FEATURE, A_VERTEX),
  },
  addVerticesToSelection: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().addVerticesToSelection(A_FEATURE, [A_VERTEX]),
  },
  clearSelection: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().clearSelection(),
  },
  restoreSelection: {
    group: 'invariant',
    why: '捕まえた選択を戻す口。道具の軸へ漏れないことを見る。',
    run: (s) => s.getState().restoreSelection(s.getState().selection),
  },
  // -- 鍵と道具（A5 の本体）--------------------------------------------------
  setMode: {
    group: 'scenario',
    why: '鍵そのもの。3 値すべてを専用の it で回す。',
    run: (s) => s.getState().setMode(EDIT_MODE.Edit),
  },
  setActiveTool: {
    group: 'scenario',
    why: '道具そのもの。全道具 × 全開始状態を専用の it で回す。',
    run: (s) => s.getState().setActiveTool(TOOL_ID.AddArea),
  },
  // -- 時刻 -----------------------------------------------------------------
  addTimeChangeGate: {
    group: 'invariant',
    why: '時刻の変更を止める関門を足すだけ。道具・鍵には触らない。',
    run: (s) => s.getState().addTimeChangeGate(() => false)(),
  },
  setCurrentTime: {
    group: 'invariant',
    why: '年は別の軸。動かしても道具・鍵は変わらない。',
    run: (s) => s.getState().setCurrentTime(timePointYear(5), TIME_CHANGE_SOURCE.NumericJump),
  },
  setTimelineRange: {
    group: 'invariant',
    why: '同上（帯の範囲）。',
    run: (s) => s.getState().setTimelineRange(timePointYear(0), timePointYear(9000)),
  },
  // -- 視点 -----------------------------------------------------------------
  setCamera: {
    group: 'invariant',
    why: '視点は別の軸。',
    run: (s) => s.getState().setCamera({ centerLon: 1, centerLat: 2, zoom: 3, panX: 0, panY: 0 }),
  },
  updateCamera: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().updateCamera({ zoom: 2 }),
  },
  setCenterLon: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setCenterLon(10),
  },
  // -- 表示の深さ・焦点 ------------------------------------------------------
  setGlobalDepth: {
    group: 'invariant',
    why: '見せ方の軸。道具と無関係。',
    run: (s) => s.getState().setGlobalDepth(2),
  },
  setFocusOrigin: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFocusOrigin(A_FEATURE),
  },
  setFocusDepth: { group: 'invariant', why: '同上。', run: (s) => s.getState().setFocusDepth(1) },
  setFocusEmphasize: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFocusEmphasize(true),
  },
  setDisplayFocus: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setDisplayFocus({ originId: A_FEATURE, depth: 1, emphasize: true }),
  },
  clearDisplayFocus: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().clearDisplayFocus(),
  },
  // -- 測量（A5 の穴が空いていた場所）---------------------------------------
  surveyEnable: {
    group: 'scenario',
    why: '**穴そのもの**。道具を外す副作用があるので mode も一緒に導き直さなければならない。',
    run: (s) => s.getState().surveyEnable(),
  },
  surveyDisable: {
    group: 'invariant',
    why: '入れる側が道具を外すので、切る側が勝手に戻さないことも押さえる。',
    run: (s) => s.getState().surveyDisable(),
  },
  surveyClickPoint: {
    group: 'invariant',
    why: '測量の作図。道具の軸に触れない。',
    run: (s) => s.getState().surveyClickPoint({ lon: 1, lat: 2 }),
  },
  surveyUpdateHover: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().surveyUpdateHover({ lon: 1, lat: 2 }),
  },
  surveyCancelDraft: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().surveyCancelDraft(),
  },
  surveyClear: { group: 'invariant', why: '同上。', run: (s) => s.getState().surveyClear() },
  surveyRemoveLine: {
    group: 'invariant',
    why: '同上（増分 8C。測量の線を 1 本消すだけで、道具にもモードにも触らない）。',
    run: (s) => s.getState().surveyRemoveLine(1),
  },
  surveyRestoreRemovedLine: {
    group: 'invariant',
    why: '同上（増分 8C の手直し。直前に消した線を戻すだけで、道具にもモードにも触らない）。',
    run: (s) => s.getState().surveyRestoreRemovedLine(),
  },
  // -- 絞り込み・強調（FR-113）----------------------------------------------
  setFilterKindVisible: {
    group: 'invariant',
    why: '見せ方の軸。道具と無関係。',
    run: (s) => s.getState().setFilterKindVisible(FEATURE_KIND_AXIS.Area, false),
  },
  setFilterDepthThreshold: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFilterDepthThreshold(2),
  },
  setFilterOpacity: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFilterOpacity(0.5),
  },
  setFeatureHidden: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFeatureHidden(A_FEATURE, true),
  },
  showAllHiddenFeatures: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().showAllHiddenFeatures(),
  },
  setFilterKindEmphasized: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Line, true),
  },
  setFeatureEmphasized: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFeatureEmphasized(A_FEATURE, true),
  },
  clearAllEmphasis: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().clearAllEmphasis(),
  },
  setKindLabelToggle: {
    group: 'invariant',
    why: '同上（種別の札のトグル）。',
    run: (s) => s.getState().setKindLabelToggle('島国', KIND_LABEL_TOGGLE.Dim, true),
  },
  setFilterEmphasizedDepth: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setFilterEmphasizedDepth(1),
  },
  // -- 地物一覧・束 ---------------------------------------------------------
  setLedgerMode: {
    group: 'invariant',
    why: '一覧は別の軸。',
    run: (s) => s.getState().setLedgerMode(LEDGER_MODE.History),
  },
  setLedgerTree: { group: 'invariant', why: '同上。', run: (s) => s.getState().setLedgerTree(true) },
  setLedgerQuery: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setLedgerQuery('あ'),
  },
  toggleLedgerExpanded: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().toggleLedgerExpanded(A_FEATURE, false),
  },
  expandLedgerPath: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().expandLedgerPath([A_FEATURE]),
  },
  setBundle: {
    group: 'invariant',
    why: '束は別の軸。null で解除しても道具は動かない。',
    run: (s) => s.getState().setBundle(null),
  },
  setBundleCursor: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setBundleCursor(0),
  },
  setBundleOnlyUnfinished: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().setBundleOnlyUnfinished(true),
  },
  // -- 対象の印（`markedFeatures`。増分 7 / 設計書 §D.5）-----------------------
  // 表示状態と同じ扱い（保存ファイルに載らない）ので、不変条件の走査に入れる。
  toggleFeatureMark: {
    group: 'invariant',
    why: '対象の印はセッション限りの集合で、選択も時刻も動かさない。',
    run: (s) => s.getState().toggleFeatureMark(asFeatureId('f-1')),
  },
  setFeatureMarks: {
    group: 'invariant',
    why: '同上（まとめて置き換える）。',
    run: (s) => s.getState().setFeatureMarks([asFeatureId('f-1')]),
  },
  clearFeatureMarks: {
    group: 'invariant',
    why: '同上（全部外す）。',
    run: (s) => s.getState().clearFeatureMarks(),
  },
  // -- 設定 -----------------------------------------------------------------
  setGridVisibleOverride: {
    group: 'invariant',
    why: '設定は別の軸。',
    run: (s) => s.getState().setGridVisibleOverride(false),
  },
  // 増分 8E（G-12）: 赤道・0 度・180 度の強調の見え方。グリッドの上書きと同じ軸。
  setGridEmphasisVisible: {
    group: 'invariant',
    why: '設定は別の軸。',
    run: (s) => s.getState().setGridEmphasisVisible(false),
  },
  setSnapSettings: {
    group: 'invariant',
    why: '同上（作図中の吸着）。',
    run: (s) => s.getState().setSnapSettings({ enabled: false }),
  },
  updateProjectSetting: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().updateProjectSetting('gridSpacingDeg', 5),
  },
  setProjectTimelineRangeYears: {
    group: 'invariant',
    why: '同上（帯の両端を一度に）。',
    run: (s) => s.getState().setProjectTimelineRangeYears(0, 9000),
  },
  updateAppSetting: {
    group: 'invariant',
    why: '同上。',
    run: (s) => s.getState().updateAppSetting('renderFps', 30),
  },
  hydrateSettings: {
    group: 'invariant',
    why: '読み込みの設定流し込み。道具・鍵は resetToDomain 側の仕事なので、ここでは動かない。',
    run: (s) => s.getState().hydrateSettings({}),
  },
  reflectLoadedProject: {
    group: 'scenario',
    why: '読み込みの原子版。resetToDomain と同じ意味を持つので鍵と道具を一緒に書く。',
    run: (s) => s.getState().reflectLoadedProject({ tag: 'd1' }, {}),
  },
  markProjectSaved: { group: 'invariant', why: '未保存の印だけ。', run: (s) => s.getState().markProjectSaved() },
};

/** 不変条件の走査に使う開始状態（鍵の開閉 × 道具の群を代表で覆う）。 */
const START_STATES: readonly {
  readonly label: string;
  readonly initial: Parameters<typeof makeStore>[1];
}[] = [
  { label: '読むだけ（既定）', initial: undefined },
  { label: '編集・道具なし', initial: { mode: EDIT_MODE.Edit } },
  { label: '編集・選ぶ', initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditSelect } },
  { label: '編集・頂点', initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditVertex } },
  { label: '編集・ナイフ', initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditKnife } },
  { label: '追加・面', initial: { mode: EDIT_MODE.Add, activeTool: TOOL_ID.AddArea } },
  { label: '追加・点', initial: { mode: EDIT_MODE.Add, activeTool: TOOL_ID.AddPoint } },
];

describe('A5: 表の網羅（新しい操作を足したら必ずここへ来る）', () => {
  it('ストアの操作は 1 つ残らず表に載っている（載っていなければ落ちる）', () => {
    const state = makeStore().getState() as unknown as Record<string, unknown>;
    const actual = Object.keys(state)
      .filter((k) => typeof state[k] === 'function')
      .sort();
    const listed = Object.keys(TOOL_MODE_OPERATIONS).sort();
    // 集合として一致すること ―― 足りなければ「表に無い操作」、余れば「消えた操作」。
    expect(actual).toEqual(listed);
  });

  it('表の行はすべて分類と理由を持つ（分類だけ書いて理由を書かない行を許さない）', () => {
    for (const [key, entry] of Object.entries(TOOL_MODE_OPERATIONS)) {
      expect({ key, hasWhy: entry.why.length > 0 }).toEqual({ key, hasWhy: true });
      // `unrelated` 以外は必ず呼べる形を持つ（呼ばずに分類だけ書いた行を許さない）。
      if (entry.group !== 'unrelated') {
        expect({ key, hasRun: entry.run !== undefined }).toEqual({ key, hasRun: true });
      }
    }
  });

  it('初期状態そのものが不変条件を満たしている', () => {
    for (const start of START_STATES) {
      expectToolModeInvariant(
        makeStore(undefined, start.initial).getState(),
        `初期:${start.label}`,
      );
    }
  });
});

describe('A5: どの操作のあとでも mode と activeTool は導出式のとおり', () => {
  for (const [key, entry] of Object.entries(TOOL_MODE_OPERATIONS)) {
    const run = entry.run;
    if (run === undefined) continue;
    it(`${key} のあと（${String(START_STATES.length)} 通りの開始状態）`, () => {
      for (const start of START_STATES) {
        const store = makeStore(undefined, start.initial);
        run(store);
        expectToolModeInvariant(store.getState(), `${start.label} → ${key}`);
      }
    });
  }
});

describe('A5 scenario: 鍵と道具の組み合わせ（引数に意味がある操作）', () => {
  it('setActiveTool: すべての道具 × すべての開始状態で式が成り立つ', () => {
    for (const start of START_STATES) {
      for (const tool of [...ALL_TOOLS, null]) {
        const store = makeStore(undefined, start.initial);
        store.getState().setActiveTool(tool);
        expectToolModeInvariant(
          store.getState(),
          `${start.label} → setActiveTool(${String(tool)})`,
        );
      }
    }
  });

  it('setActiveTool: 鍵が閉じている間は道具を構えさせない（K-6 の関門）', () => {
    const store = makeStore(); // 既定は読むだけ
    store.getState().setActiveTool(TOOL_ID.AddArea);
    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().mode).toBe(EDIT_MODE.View);
  });

  it('setMode: 鍵の開け閉め（読むだけ ⇄ 編集）では式が成り立つ', () => {
    // **画面から `setMode` を呼ぶのは鍵 1 個だけ**である（裁定 1 でモードの 3 ボタンを
    // 廃止した）。実装の呼び出し側も `useShell` の鍵・一覧の「直せるようにする」・
    // 追加の道具の「このままにする」の 3 か所で、渡す値は読むだけ／編集の 2 値しかない。
    // だから走査もその 2 値でする ―― 追加を渡す経路は下の it が別に面倒を見る。
    for (const start of START_STATES) {
      for (const mode of [EDIT_MODE.View, EDIT_MODE.Edit] as const) {
        const store = makeStore(undefined, start.initial);
        store.getState().setMode(mode);
        expectToolModeInvariant(store.getState(), `${start.label} → setMode(${mode})`);
      }
    }
  });

  // **未修正の穴（この検査を書いて見つけた。司令塔へ報告済み）**。
  //
  // A5 の約束は「`activeTool` を書く set() は必ず `toolPatch()` の戻り値を展開する」である。
  // **`setMode` だけがこの約束の外にいた** ―― `mode` を受け取った値のまま書き、
  // `activeTool` を `null` にしていた。読むだけ／編集の 2 値ならたまたま式に合う
  // （View→道具なし、Edit＋道具なし→Edit）が、**追加を渡すと「mode は追加・道具は無し」**
  // という、A5 が他の全経路で潰したのとまったく同じ形が残った。画面からその値を渡す経路は
  // 無かったが、**経路が無いことに頼らない**（経路はあとから増える）ので、`setMode` も
  // 同じ 1 本の関数を通す形に直した。
  it('setMode(追加) も不変条件を保つ ―― 道具の欄を書く場所は 1 本の関数を通す', () => {
    // **経路が無いことに頼らない。** いま `add` を渡す呼び出しは 1 つも無いが、
    // `setMode` だけ導出を通していなかったので「内部は追加・道具は無し」という
    // A5 が潰したのと同じ形が作れた。追加は「面／線／点の道具を構えている」ことで
    // しか成り立たないので、道具を外すこの入口では必ず「編集」へ落ちる。
    const store = makeStore(undefined, { mode: EDIT_MODE.Edit });
    store.getState().setMode(EDIT_MODE.Add);
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
    expect(store.getState().activeTool).toBeNull();
    expectToolModeInvariant(store.getState(), 'setMode(add)');
  });

  it('surveyEnable: 面を描いている最中でも「画面は選ぶ・内部は追加」にならない', () => {
    // **A5 の穴そのもの**。旧版は activeTool だけ null にして mode を追加のまま
    // 残したので、左クリックは追加の経路へ送られるのに追加のコントローラは居らず、
    // 選ぶことも追加することもできなくなった。
    const store = makeStore(undefined, { mode: EDIT_MODE.Add, activeTool: TOOL_ID.AddArea });
    store.getState().surveyEnable();
    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
    expectToolModeInvariant(store.getState(), 'surveyEnable from 追加・面');
  });

  it('surveyEnable: 鍵が閉じているときは読むだけのまま（測量が編集の入口にならない）', () => {
    const store = makeStore(); // 読むだけ
    store.getState().surveyEnable();
    expect(store.getState().mode).toBe(EDIT_MODE.View);
    expect(store.getState().activeTool).toBeNull();
  });
});

describe('A5 結合: 面の道具 → 測量 ON → 測量 OFF で、地図クリックが選択に戻る', () => {
  it('測量を入り切りしたあと mode は編集で、地図クリックの行き先は選ぶになる', () => {
    // 具体例（司令塔の指定そのもの）。ストアの値だけでなく **その値で地図の押下が
    // どこへ行くか**まで見る ―― A5 の被害は「行き先が追加のままで受け手が居ない」
    // という形で出るので、行き先の解決まで通さないと再発を捕まえられない。
    const store = makeStore(undefined, { mode: EDIT_MODE.Edit });
    store.getState().setActiveTool(TOOL_ID.AddArea);
    expect(store.getState().mode).toBe(EDIT_MODE.Add);
    expect(
      decideDispatch({ mode: store.getState().mode, button: POINTER_BUTTON.Left, hit: EMPTY_HIT }),
    ).toBe(DISPATCH_TARGET.Add);

    store.getState().surveyEnable();
    store.getState().surveyDisable();

    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
    // 旧版はここが Add のままで、左クリックが追加へ送られ続けた（受け手は居ない）。
    expect(
      decideDispatch({ mode: store.getState().mode, button: POINTER_BUTTON.Left, hit: EMPTY_HIT }),
    ).toBe(DISPATCH_TARGET.SelectEdit);
    expectToolModeInvariant(store.getState(), '面 → 測量 ON → 測量 OFF');
  });
});

// ============================================================================
// A7: 頂点の選択は「掴める道具から出るとき」に落ちる
// ============================================================================
//
// 増分 5 の手直し A7 / GPT #9。旧版は「直前が `edit.vertex` だったか」で捨てていたので、
// **「動かす」で掴んだ頂点が、ナイフや追加の道具へ移っても見えないまま残り**（当時は「動かす」でも
// 頂点を掴めた。2026-11-01 の裁定で掴めるのは「頂点」だけになった）、
// 下書きを持たないうちに Delete を押すとその頂点が消えた。ハンドルを出す条件
// （`toolShowsVertexHandles`）と、頂点の選択を残す条件を同じ 1 本の述語にする。

describe('A7: 頂点の選択が落ちるのは「掴める道具から出るとき」だけ', () => {
  /** 頂点を 1 つ掴んだ状態のストア（開始の道具を指定できる）。 */
  function withGrabbedVertex(tool: ToolId | null) {
    return makeStore(undefined, {
      mode: EDIT_MODE.Edit,
      activeTool: tool,
      activeFeature: f('A'),
      vertexSelection: { ownerFeatureId: f('A'), vertexIds: new Set([v('v1')]) },
    });
  }

  /** 掴める道具（「頂点」。B114 で「選択」を、2026-11-01 の裁定で「動かす」を外した）。判定は実装と同じ 1 本を引く。 */
  const GRABBING = ALL_TOOLS.filter((t) => toolShowsVertexHandles(t));
  /** 掴めない道具（残り全部）。 */
  const NOT_GRABBING = ALL_TOOLS.filter((t) => !toolShowsVertexHandles(t));

  it('掴める道具は「頂点」だけである（表の前提を固定する）', () => {
    expect(GRABBING).toEqual([TOOL_ID.EditVertex]);
    expect(NOT_GRABBING.length).toBe(ALL_TOOLS.length - 1);
  });

  it('「頂点」で掴んだ頂点は、ナイフへ持ち替えると落ちる', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().setActiveTool(TOOL_ID.EditKnife);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A')); // 地物の選択は残る
  });

  it('「頂点」から追加の道具へでも落ちる', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().setActiveTool(TOOL_ID.AddArea);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('「頂点」→「動かす」で落ちる。地物の選択は残り、「頂点」へ戻しても頂点は戻らない（裁定 2026-11-01）', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().setActiveTool(TOOL_ID.EditMove);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
    store.getState().setActiveTool(TOOL_ID.EditVertex);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('「頂点」→「選択」で落ちる。地物の選択は残る（B114: 見えない頂点を残さない）', () => {
    for (const from of GRABBING) {
      const store = withGrabbedVertex(from);
      store.getState().setActiveTool(TOOL_ID.EditSelect);
      expect({ from, vertices: store.getState().vertexSelection }).toEqual({
        from,
        vertices: null,
      });
      expect(store.getState().activeFeature).toBe(f('A'));
    }
  });

  it('掴める道具 → 掴めない道具は、どの組み合わせでも落ちる（全数）', () => {
    for (const from of GRABBING) {
      for (const to of NOT_GRABBING) {
        const store = withGrabbedVertex(from);
        store.getState().setActiveTool(to);
        expect({ from, to, vertices: store.getState().vertexSelection }).toEqual({
          from,
          to,
          vertices: null,
        });
      }
    }
  });

  it('掴める道具どうしは、どの組み合わせでも落ちない（全数）', () => {
    for (const from of GRABBING) {
      for (const to of GRABBING) {
        const store = withGrabbedVertex(from);
        store.getState().setActiveTool(to);
        expect({ from, to, size: store.getState().vertexSelection?.vertexIds.size }).toEqual({
          from,
          to,
          size: 1,
        });
      }
    }
  });

  it('印を出さない道具のあいだは、頂点の選択を持たない（全部の道具 × 明示の選択あり・なし）', () => {
    // 道具のコントローラが選択を渡してくる経路（`armEditTool`・構え直し）も同じ。呼び出し側の
    // 経路に依らず、持ち替えたあとの道具だけで決まる（B114 の検証で見つけた抜け道）。
    for (const from of [...GRABBING, null]) {
      for (const to of ALL_TOOLS) {
        for (const explicit of [false, true]) {
          const store = withGrabbedVertex(TOOL_ID.EditVertex);
          const grabbed = store.getState().selection;
          store.getState().setActiveTool(from);
          if (explicit) store.getState().setActiveTool(to, grabbed);
          else store.getState().setActiveTool(to);
          const s = store.getState();
          const expectedSize = !toolShowsVertexHandles(to)
            ? 0
            : explicit || from !== null
              ? 1
              : 0;
          expect({
            from,
            to,
            explicit,
            size: s.selection.vertexIds.size,
            owner: s.selection.vertexOwner,
            mirror: s.vertexSelection?.vertexIds.size ?? 0,
            active: s.activeFeature,
          }).toEqual({
            from,
            to,
            explicit,
            size: expectedSize,
            owner: expectedSize > 0 ? f('A') : null,
            mirror: expectedSize,
            active: f('A'),
          });
        }
      }
    }
  });

  it('頂点を書く口は、印を出さない道具のあいだは効かない（経路が増えても破れない）', () => {
    for (const tool of ALL_TOOLS) {
      const writes: readonly ((s: ReturnType<typeof makeStore>) => void)[] = [
        (s) => s.getState().replaceVertexSelection(f('A'), [v('v1')]),
        (s) => s.getState().toggleVertexSelection(f('A'), v('v1')),
        (s) => s.getState().addVerticesToSelection(f('A'), [v('v1')]),
        (s) =>
          s
            .getState()
            .restoreSelection(replaceVertices(s.getState().selection, f('A'), new Set([v('v1')]))),
      ];
      for (const write of writes) {
        const store = makeStore(undefined, { mode: EDIT_MODE.Edit, activeTool: tool });
        write(store);
        expect({ tool, size: store.getState().selection.vertexIds.size }).toEqual({
          tool,
          size: toolShowsVertexHandles(tool) ? 1 : 0,
        });
      }
    }
  });

  it('頂点の選択が無ければ、持ち替えで選択の参照を作り直さない（無駄な描き直しを出さない）', () => {
    const store = makeStore(undefined, {
      mode: EDIT_MODE.Edit,
      activeTool: TOOL_ID.EditSelect,
      activeFeature: f('A'),
    });
    const before = store.getState().selection;
    store.getState().setActiveTool(TOOL_ID.EditKnife);
    expect(store.getState().selection).toBe(before);
  });

  it('構え直し（null を挟む）は「頂点」の道具の頂点の選択を戻す。印を付けての所属変更は印を残す', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    const retained = store.getState().selection;
    store.getState().setActiveTool(null, retained);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
    store.getState().setActiveTool(TOOL_ID.EditVertex, retained);
    expect(store.getState().vertexSelection?.vertexIds.size).toBe(1);

    const marked = withGrabbedVertex(TOOL_ID.EditVertex);
    marked.getState().setFeatureMarks([f('A')]);
    marked.getState().setActiveTool(TOOL_ID.EditReparent, marked.getState().selection);
    expect(marked.getState().vertexSelection).toBeNull();
    expect(marked.getState().ledger.marked.size).toBe(1);
  });

  it('地物の選択は、どの持ち替えでも残る（落ちるのは頂点だけ）', () => {
    for (const from of ALL_TOOLS) {
      for (const to of ALL_TOOLS) {
        const store = withGrabbedVertex(from);
        store.getState().setActiveTool(to);
        expect({ from, to, active: store.getState().activeFeature }).toEqual({
          from,
          to,
          active: f('A'),
        });
      }
    }
  });

  it('道具を外す（null）のは「選択」と同じ扱いなので、頂点は落ちる（B114）', () => {
    // 利用者から見て「何も構えていない」と「選択」は同じ状態（設計書 §D.4）で、印が描かれない。
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().setActiveTool(null);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('鍵を閉めても開けても見えない頂点は残らない。地物の選択は残る（B114）', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().setMode(EDIT_MODE.View);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
    store.getState().setMode(EDIT_MODE.Edit);
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('測量へ入っても見えない頂点は残らない。地物の選択は残る（B114）', () => {
    const store = withGrabbedVertex(TOOL_ID.EditVertex);
    store.getState().surveyEnable();
    expect(store.getState().activeTool).toBeNull();
    expect(store.getState().vertexSelection).toBeNull();
    expect(store.getState().activeFeature).toBe(f('A'));
  });
});
