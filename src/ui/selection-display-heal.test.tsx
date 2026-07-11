// Integration 回帰 (選択 heal の対称性完成: time ↔ displayControl):
//
// SYMPTOM (real hardware): the property panel showed「選択頂点の所有地物を特定できませ
// ん。」(selection-display CONTEXT_KIND.Unknown, messages.ts unknownOwner). Its condition:
// a selected vertex id cannot be resolved through the display owner-lookup
// (display-resolution-cache `vertexOwners` — ONLY that frame's grabbable features own
// vertices). Selection is re-validated on time changes (revalidateForTime) and undo/redo,
// but — before this fix — NOT on DISPLAY-CONTROL changes: lowering the global depth (or
// dropping a focus) rolled the vertex-selection owner up into an aggregate, so it stopped
// exposing grabbable vertices and the still-selected vertices became「所有地物不明」.
//
// This test drives the REAL pieces end to end — the session store, the live
// grabbability resolver backed by resolveDisplayFor, and the property panel's
// decideDisplay — over a REAL aggregate-over-leaves project, proving:
//   1. the raw Unknown condition (documents WHICH displayControl change triggers it), and
//   2. the store heal now prunes the dangling selection so the panel no longer reaches
//      Unknown on the normal path (the guidance itself is retained as a legitimate defence).
//
// SCOPE NOTE: the store's `displayControl` axis is depth N + focus M only. 種別非表示 /
// 個別非表示 (U41 discovery filter, src/ui/discovery) are a SEPARATE mechanism that does
// NOT feed resolveDisplayFor's `grabbable`/`owners` map (buildCommittedFeatures takes no
// discovery filter), so they cannot produce this owner-lookup Unknown and are out of this
// path — see the report.

/// <reference types="@testing-library/jest-dom" />

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCommandResult } from '../domain/command/result';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../domain/feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../domain/ids';
import {
  EMPTY_SELECTION,
  ownerLookupFromMap,
  withVertexSet,
  type SelectionState,
} from '../domain/selection';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  richValidProject,
  singleAnchorHistory,
  squareLeaf,
} from '../domain/persistence/fixtures';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import { createCoordinate } from '../domain/coordinate';
import { createShape, createTerritoryRing } from '../domain/ring';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertex, createVertexStore } from '../domain/vertex';

import {
  resolveDisplayFor,
  clearDisplayResolutionCache,
} from './map/display-resolution-cache';
import { PROPERTY_STRINGS } from './property/messages';
import { DISPLAY_KIND, decideDisplay } from './property/selection-display';
import { buildSidebarContent } from './shell/SidebarContent';
import { createLiveGrabbabilityResolver } from './live-grabbability';
import { EDIT_MODE, type DisplayControl } from './state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from './state/store';

const TIME = timePointYear(10);

// richValidProject: aggregate `agg-1` over child leaves `leaf-a` / `leaf-b` (parented),
// present at year 10. `leaf-a` is a square whose 4 ring vertices are leaf-a-0..3.
const AGG = asFeatureId('agg-1');
const CHILD_A = asFeatureId('leaf-a');
const CHILD_A_VERTS = ['leaf-a-0', 'leaf-a-1', 'leaf-a-2', 'leaf-a-3'].map(asVertexId);

// At a deep enough N the children draw their OWN shape (grabbable); at N=0 they roll up
// into the aggregate (omitted, not grabbable).
const EXPANDED: DisplayControl = {
  globalDepth: 5,
  focus: { originId: null, depth: 0, emphasize: false },
};
const AGGREGATED: DisplayControl = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
// N stays 0 but a FOCUS on the aggregate deep-dives its children → grabbable again.
const FOCUSED: DisplayControl = {
  globalDepth: 0,
  focus: { originId: AGG, depth: 5, emphasize: false },
};

afterEach(() => {
  clearDisplayResolutionCache();
});

/** The property-panel decision for a selection under a display control, using the SAME
 *  owner-lookup (resolveDisplayFor's `owners`) the live app feeds decideDisplay. */
function panelDecisionUnder(
  root: DomainProject,
  control: DisplayControl,
  selection: SelectionState,
  time = TIME,
) {
  const ownerLookup = ownerLookupFromMap(
    resolveDisplayFor(root, time, control).owners,
  );
  return decideDisplay({
    activeFeatureId: selection.activeFeature,
    vertexIds: selection.vertexIds,
    ownerLookup,
  });
}

describe('選択 heal の対称性: displayControl change → owner unresolvable (property panel)', () => {
  it('DOCUMENTS the raw Unknown: a child-leaf vertex selection resolves EXPANDED but is Unknown once AGGREGATED', () => {
    const root = richValidProject();
    const selection: SelectionState = withVertexSet(
      EMPTY_SELECTION,
      CHILD_A,
      new Set(CHILD_A_VERTS),
    );

    // EXPANDED: child A draws its own shape → its vertices resolve to leaf-a → editable.
    const expanded = panelDecisionUnder(root, EXPANDED, selection);
    expect(expanded.kind).toBe(DISPLAY_KIND.ContextFeature);
    if (expanded.kind === DISPLAY_KIND.ContextFeature) {
      expect(expanded.targetFeatureId).toBe(CHILD_A);
    }

    // AGGREGATED (globalDepth 0): child A is rolled up into agg-1, so the display
    // owner-lookup no longer owns its vertices → 「所有地物を特定できません」(Unknown).
    // This is the raw symptom the heal must prevent from persisting.
    const aggregated = panelDecisionUnder(root, AGGREGATED, selection);
    expect(aggregated.kind).toBe(DISPLAY_KIND.Unknown);

    // Dropping a FOCUS reproduces the same raw Unknown (child grabbable only under focus).
    const focused = panelDecisionUnder(root, FOCUSED, selection);
    expect(focused.kind).toBe(DISPLAY_KIND.ContextFeature);
  });

  it('HEAL (depth): store.setGlobalDepth(0) prunes the now-un-grabbable vertex selection → panel Empty, not Unknown', () => {
    const root = richValidProject();
    const store = createSessionStore<DomainProject>({
      initialDomain: root,
      grabbability: createLiveGrabbabilityResolver(() => root),
      initial: {
        currentTime: TIME,
        displayControl: EXPANDED,
        vertexSelection: { ownerFeatureId: CHILD_A, vertexIds: new Set(CHILD_A_VERTS) },
      },
    });

    // Sanity: while EXPANDED the selection is valid + editable.
    expect(
      panelDecisionUnder(root, EXPANDED, store.getState().selection).kind,
    ).toBe(DISPLAY_KIND.ContextFeature);

    // Lower the depth so child A rolls up into the aggregate. The store re-validates the
    // vertex selection against the SAME resolveDisplayFor grabbable set the renderer uses.
    store.getState().setGlobalDepth(0);

    const healed = store.getState().selection;
    expect(healed.vertexOwner).toBeNull();
    expect(healed.vertexIds.size).toBe(0);

    // The property panel now reads Empty (nothing selected) — NOT Unknown. The user no
    // longer sees「所有地物を特定できません」on the normal path.
    const decision = panelDecisionUnder(root, AGGREGATED, healed);
    expect(decision.kind).toBe(DISPLAY_KIND.Empty);
    expect(decision.kind).not.toBe(DISPLAY_KIND.Unknown);
  });

  it('HEAL (focus): clearing a focus that expanded the child prunes the selection → panel Empty', () => {
    const root = richValidProject();
    const store = createSessionStore<DomainProject>({
      initialDomain: root,
      grabbability: createLiveGrabbabilityResolver(() => root),
      initial: {
        currentTime: TIME,
        displayControl: FOCUSED, // N=0 but the focus deep-dives agg-1's children
        vertexSelection: { ownerFeatureId: CHILD_A, vertexIds: new Set(CHILD_A_VERTS) },
      },
    });
    // Valid under the focus.
    expect(
      panelDecisionUnder(root, FOCUSED, store.getState().selection).kind,
    ).toBe(DISPLAY_KIND.ContextFeature);

    // Drop the focus → child A is omitted again → the selection is pruned.
    store.getState().clearDisplayFocus();

    const healed = store.getState().selection;
    expect(healed.vertexIds.size).toBe(0);
    expect(panelDecisionUnder(root, AGGREGATED, healed).kind).toBe(DISPLAY_KIND.Empty);
  });
});

// =============================================================================
// S4b — PRODUCTION wiring (FR-81 / docs 現状.md §5「owner lookup の結線」):
// the REAL sidebar host (buildSidebarContent → PropertyPanelHost → PropertyPanel).
//
// ROOT CAUSE of the real-hardware symptom: PropertyPanelHost passed NO `ownerLookup`
// to the panel (honest-stub), so the panel fell back to the EMPTY lookup and EVERY
// vertex-only selection (no active feature) classified as Unknown —「選択頂点の所有
// 地物を特定できません」— regardless of displayControl. The wiring below resolves
// owners through resolveDisplayFor(...).owners, the SAME single truth source the
// click hit-test grabs from (教訓 5.29), so a resolvable owner now shows that
// feature's properties (ContextFeature, FR-81) and ONLY a truly dangling vertex
// still reaches the (retained, defensive) Unknown guidance.
// =============================================================================

describe('S4b 本番結線: PropertyPanelHost の ownerLookup (FR-81 貫通)', () => {
  function renderProductionPanel(opts: {
    root: DomainProject;
    displayControl: DisplayControl;
    vertexIds: readonly string[];
    owner?: string;
  }) {
    const store = createSessionStore<DomainProject>({
      initialDomain: opts.root,
      grabbability: createLiveGrabbabilityResolver(() => opts.root),
      initial: {
        mode: EDIT_MODE.Edit,
        currentTime: TIME,
        displayControl: opts.displayControl,
        vertexSelection: {
          ownerFeatureId: asFeatureId(opts.owner ?? 'leaf-a'),
          vertexIds: new Set(opts.vertexIds.map(asVertexId)),
        },
      },
    });
    const sidebar = buildSidebarContent<DomainProject>({
      store,
      getRoot: () => store.getState().domain,
      getTime: () => store.getState().currentTime,
      calendar: getCalendar('gregorian'),
    });
    render(<>{sidebar.propertiesContent}</>);
    return store;
  }

  it('頂点のみ選択で所有者が引ける → ContextFeature: その地物のプロパティが表示され編集可 (FR-81)', () => {
    // leaf-a's vertices selected, leaf-a grabbable (EXPANDED). Through the REAL host
    // wiring the panel must resolve the owner and show leaf-a's basic info — NOT the
    // unknownOwner guidance the un-wired (empty-lookup) host showed for EVERY
    // vertex-only selection.
    renderProductionPanel({
      root: richValidProject(),
      displayControl: EXPANDED,
      vertexIds: ['leaf-a-0', 'leaf-a-1', 'leaf-a-2', 'leaf-a-3'],
    });

    expect(screen.queryByTestId('property-guidance')).not.toBeInTheDocument();
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
    // The owner feature's own properties (leaf-a = 'A国'), editable in Edit mode.
    const nameInput = screen.getByLabelText(PROPERTY_STRINGS.nameLabel);
    expect(nameInput).toHaveValue('A国');
    expect(nameInput).toBeEnabled();
  });

  it('所有者が引けない頂点だけが Unknown ガイダンスに到達する (防御表示は残置)', () => {
    // A truly dangling vertex id (owned by nothing drawn this frame). The heal does
    // not fire (no displayControl change), so this exercises the retained defensive
    // guidance through the REAL wiring: Unknown is still shown — but ONLY here.
    renderProductionPanel({
      root: richValidProject(),
      displayControl: EXPANDED,
      vertexIds: ['ghost-v0'],
      owner: 'ghost-owner',
    });

    expect(screen.getByTestId('property-guidance')).toHaveTextContent(
      PROPERTY_STRINGS.unknownOwner,
    );
  });

  it('両輪 end-to-end: 深度変更で heal が選択を prune → パネルは Empty 案内 (Unknown ではない)', () => {
    // Start with a valid, owner-resolvable selection (panel shows leaf-a). Lower the
    // depth: the S4 heal prunes the now-un-grabbable selection in the SAME set() as
    // the displayControl write, and the re-rendered panel shows the EMPTY guidance —
    // the Unknown message is unreachable on this normal path.
    const store = renderProductionPanel({
      root: richValidProject(),
      displayControl: EXPANDED,
      vertexIds: ['leaf-a-0', 'leaf-a-1', 'leaf-a-2', 'leaf-a-3'],
    });
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();

    act(() => {
      store.getState().setGlobalDepth(0);
    });

    const guidance = screen.getByTestId('property-guidance');
    expect(guidance).toHaveTextContent(PROPERTY_STRINGS.emptySelection);
    expect(guidance).not.toHaveTextContent(PROPERTY_STRINGS.unknownOwner);
  });
});

// =============================================================================
// S4c — 対称性完成 (Codex fix-forward): display 再検証は displayControl setter だけで
// なく、表示解決の入力 (root, time, control) の「どれ」が変わる経路でも走る。
//
//   - [HIGH] setCurrentTime: 時刻変更で所有 leaf が集約の子に降格 (Omit 化) しても
//     時刻存在ベース (revalidateForTime) では生存するため、display heal がなければ
//     owners から消えた頂点選択が残り Unknown 化する。
//   - [HIGH] applyCommandResult / applyUndoRedoResult: domain スワップで階層が変わる
//     場合も同様 (heal は既存の time-existence 引き締めと同じく domain コミット後に
//     LIVE root を見る)。
//   - [MED] 共有頂点: owners の first-wins 所有者だけが Omit 化しても、頂点が別の
//     生存所有者経由で描画・選択可能なら保持し、vertexOwner をその所有者へ書き換える
//     (whole-owner 判定の誤 prune 修正)。
// =============================================================================

const TEST_COLOR = createColorInfo(true, '#123456', '#654321', '#0f0f0f');

/**
 * leaf-c is TOP-LEVEL until year 50, then becomes a CHILD of aggregate agg-2 — a
 * hierarchy change over TIME with the SAME feature id + vertices (one history whose
 * two anchors carry the different parentage). At N=0: year<50 → leaf-c Real
 * (grabbable), year≥50 → leaf-c rolled up into agg-2 (Omit, not grabbable) while it
 * still EXISTS (time-existence keeps the selection — only the display heal prunes it).
 */
function hierarchyShiftOverTimeProject(): DomainProject {
  const c = squareLeaf('leaf-c', 'C国', 40, 0);
  const aggId = asFeatureId('agg-2');
  const cAsChild = { ...c.feature, parentId: aggId } as Feature;
  const agg = createAggregateFeature(
    aggId,
    createBasicAttributes('連合', 0, 100),
    TEST_COLOR,
    [c.feature.id],
  );
  const verts = createVertexStore(c.vertices);
  const anchorTop = createAnchor(
    asAnchorId('w-anc-top'),
    createAnchorSnapshot([c.feature], verts),
  );
  const anchorChild = createAnchor(
    asAnchorId('w-anc-child'),
    createAnchorSnapshot([cAsChild, agg], verts),
  );
  const history: FeatureHistory = {
    featureId: c.feature.id,
    series: normalizeSeries(
      [
        createAnchorEntry(anchorTop, timePointYear(0), timePointYear(50)),
        createAnchorEntry(anchorChild, timePointYear(50), null),
      ],
      CAL,
    ),
  };
  return { histories: [history], settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

/** leaf-c TOP-LEVEL (grabbable at N=0). The undo/commit tests swap to parentedRoot. */
function topLevelRoot(): DomainProject {
  const c = squareLeaf('leaf-c', 'C国', 40, 0);
  return {
    histories: [
      singleAnchorHistory('leaf-c', [c.feature], createVertexStore(c.vertices), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** The SAME leaf-c, now a CHILD of agg-2 (Omit at N=0) — everything survives by id. */
function parentedRoot(): DomainProject {
  const c = squareLeaf('leaf-c', 'C国', 40, 0);
  const aggId = asFeatureId('agg-2');
  const cAsChild = { ...c.feature, parentId: aggId } as Feature;
  const agg = createAggregateFeature(
    aggId,
    createBasicAttributes('連合', 0, 100),
    TEST_COLOR,
    [c.feature.id],
  );
  return {
    histories: [
      singleAnchorHistory('leaf-c', [cAsChild, agg], createVertexStore(c.vertices), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/**
 * Shared-vertex fixture (Codex [MED]): leaf-d (child of agg-3) and TOP-LEVEL leaf-e
 * SHARE vertex `leaf-d-1` ((10,0) — a corner of d's square and of e's triangle).
 * At N=5 both are Real; owners first-wins gives `leaf-d-1` → leaf-d (feature order).
 * At N=0 leaf-d is rolled up (Omit) while leaf-e stays Real → `leaf-d-1` re-resolves
 * to leaf-e; d's other three vertices resolve to nothing.
 */
function sharedVertexProject(): DomainProject {
  const d = squareLeaf('leaf-d', 'D国', 0, 0); // verts leaf-d-0..3; leaf-d-1 = (10,0)
  const aggId = asFeatureId('agg-3');
  const dAsChild = { ...d.feature, parentId: aggId } as Feature;
  const agg = createAggregateFeature(
    aggId,
    createBasicAttributes('連合D', 0, 100),
    TEST_COLOR,
    [d.feature.id],
  );
  const e0 = createVertex(asVertexId('leaf-e-0'), createCoordinate(30, 0));
  const e1 = createVertex(asVertexId('leaf-e-1'), createCoordinate(30, 10));
  const eRing = createTerritoryRing(asRingId('leaf-e-r'), [
    asVertexId('leaf-d-1'),
    e0.id,
    e1.id,
  ]);
  const leafE = createLeafFeature(
    asFeatureId('leaf-e'),
    createBasicAttributes('E国', 0, 100),
    TEST_COLOR,
    createShape([eRing]),
  );
  const verts = createVertexStore([...d.vertices, e0, e1]);
  return {
    histories: [singleAnchorHistory('leaf-d', [dAsChild, agg, leafE], verts, 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('S4c 対称性完成: root/time 変更でも display 再検証 (Codex fix-forward)', () => {
  const LEAF_C = asFeatureId('leaf-c');
  const LEAF_C_V2 = ['leaf-c-0', 'leaf-c-1'].map(asVertexId);

  it('[HIGH 時刻変更] 新時刻で所有 leaf が子に降格 (Omit 化) → setCurrentTime が prune → Empty', () => {
    const root = hierarchyShiftOverTimeProject();
    const store = createSessionStore<DomainProject>({
      initialDomain: root,
      grabbability: createLiveGrabbabilityResolver(() => root),
      initial: {
        currentTime: TIME, // year 10: leaf-c top-level → Real (grabbable) at N=0
        displayControl: AGGREGATED,
        vertexSelection: { ownerFeatureId: LEAF_C, vertexIds: new Set(LEAF_C_V2) },
      },
    });
    // Sanity: at year 10 the owner resolves (top-level Real) → editable ContextFeature.
    expect(
      panelDecisionUnder(root, AGGREGATED, store.getState().selection).kind,
    ).toBe(DISPLAY_KIND.ContextFeature);

    // Move time to year 60: leaf-c still EXISTS (revalidateForTime keeps it) but is now
    // agg-2's child → Omit at N=0 → its vertices vanish from owners. Without the display
    // heal on the TIME branch the stale selection lingers and the panel reads Unknown.
    store.getState().setCurrentTime(timePointYear(60), TIME_CHANGE_SOURCE.Slider);

    const healed = store.getState().selection;
    expect(healed.vertexIds.size).toBe(0);
    expect(healed.vertexOwner).toBeNull();
    expect(
      panelDecisionUnder(root, AGGREGATED, healed, timePointYear(60)).kind,
    ).toBe(DISPLAY_KIND.Empty);
  });

  it('[HIGH 時刻変更・保持] 表示状態が変わらない時刻移動は選択を同一参照のまま保持 (誤 prune なし)', () => {
    const root = hierarchyShiftOverTimeProject();
    const store = createSessionStore<DomainProject>({
      initialDomain: root,
      grabbability: createLiveGrabbabilityResolver(() => root),
      initial: {
        currentTime: TIME,
        displayControl: AGGREGATED,
        vertexSelection: { ownerFeatureId: LEAF_C, vertexIds: new Set(LEAF_C_V2) },
      },
    });
    const before = store.getState().selection;
    // year 20 is still in the top-level regime (< 50) → owner stays grabbable.
    store.getState().setCurrentTime(timePointYear(20), TIME_CHANGE_SOURCE.Slider);
    expect(store.getState().selection).toBe(before); // idempotent — no false prune
  });

  it('[HIGH undo/redo] 階層が変わる undo 適用後に heal が LIVE root を見て prune する', () => {
    const before = topLevelRoot();
    const after = parentedRoot();
    // The resolver reads the LIVE committed domain (mirrors App wiring getRoot =
    // store.getState().domain): a subscription keeps it in lock-step, so the heal sees
    // `after` ONLY once the store actually committed it — proving the heal runs
    // post-commit (第10波 #5 と同順序).
    let liveRoot: DomainProject = before;
    const store = createSessionStore<DomainProject>({
      initialDomain: before,
      grabbability: createLiveGrabbabilityResolver(() => liveRoot),
      initial: {
        currentTime: TIME,
        displayControl: AGGREGATED,
        vertexSelection: { ownerFeatureId: LEAF_C, vertexIds: new Set(LEAF_C_V2) },
      },
    });
    store.subscribe((s) => {
      liveRoot = s.domain;
    });

    // Undo/redo lands on a domain where leaf-c is a child (everything SURVIVED by id —
    // reresolveAfterStructureChange prunes nothing, and time-existence keeps leaf-c).
    store.getState().applyUndoRedoResult(
      after,
      createCommandResult({ survived: new Set([LEAF_C, ...LEAF_C_V2]) }),
    );

    const healed = store.getState().selection;
    expect(healed.vertexIds.size).toBe(0);
    expect(
      panelDecisionUnder(after, AGGREGATED, healed).kind,
    ).toBe(DISPLAY_KIND.Empty);
  });

  it('[HIGH 構造コミット] applyCommandResult でも同じ heal が走る (対称位置)', () => {
    const before = topLevelRoot();
    const after = parentedRoot();
    let liveRoot: DomainProject = before;
    const store = createSessionStore<DomainProject>({
      initialDomain: before,
      grabbability: createLiveGrabbabilityResolver(() => liveRoot),
      initial: {
        currentTime: TIME,
        displayControl: AGGREGATED,
        vertexSelection: { ownerFeatureId: LEAF_C, vertexIds: new Set(LEAF_C_V2) },
      },
    });
    store.subscribe((s) => {
      liveRoot = s.domain;
    });

    store.getState().applyCommandResult(
      after,
      createCommandResult({ survived: new Set([LEAF_C, ...LEAF_C_V2]) }),
    );

    expect(store.getState().selection.vertexIds.size).toBe(0);
    expect(store.getState().projectDirty).toBe(true); // dirty 規約は不変
  });

  it('[MED 共有頂点] first-wins 所有者だけが Omit 化 → 共有頂点は生存所有者へ書き換えて保持', () => {
    const root = sharedVertexProject();
    const store = createSessionStore<DomainProject>({
      initialDomain: root,
      grabbability: createLiveGrabbabilityResolver(() => root),
      initial: {
        currentTime: TIME,
        displayControl: EXPANDED, // leaf-d (child) も Real → d-1 の first-wins 所有者 = leaf-d
        vertexSelection: {
          ownerFeatureId: asFeatureId('leaf-d'),
          vertexIds: new Set(
            ['leaf-d-0', 'leaf-d-1', 'leaf-d-2', 'leaf-d-3'].map(asVertexId),
          ),
        },
      },
    });
    // Sanity: EXPANDED では全4頂点が leaf-d に解決 (共有頂点も first-wins で leaf-d)。
    expect(
      panelDecisionUnder(root, EXPANDED, store.getState().selection).kind,
    ).toBe(DISPLAY_KIND.ContextFeature);

    // N=0: leaf-d は agg-3 に丸められ Omit、leaf-e は top-level のまま Real。共有頂点
    // leaf-d-1 は leaf-e 経由で描画・選択可能 → 全落としせず、所有者を書き換えて保持。
    store.getState().setGlobalDepth(0);

    const healed = store.getState().selection;
    expect([...healed.vertexIds]).toEqual([asVertexId('leaf-d-1')]);
    expect(healed.vertexOwner).toBe(asFeatureId('leaf-e'));
    // パネルは leaf-e の ContextFeature (Unknown でも Empty でもない)。
    expect(panelDecisionUnder(root, AGGREGATED, healed).kind).toBe(
      DISPLAY_KIND.ContextFeature,
    );
  });
});
