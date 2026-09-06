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
import { OptionBar } from '../shell/OptionBar';
import { OptionBarStore } from '../shell/option-bar';
import { TOOL_ID } from '../shell/tools';
import { AppShell } from '../shell';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';
import { createLiveAffiliationBinding, type DomainRoot } from '../consistency-binding';
import { featuresAt, leafShapeAt, verticesAt } from '../live-lookup';
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
import { REPARENT_STRINGS } from './strings';

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
  /** オプションバー（設計書 §C.4）。対象欄への押し込みを見るために持たせる。 */
  readonly optionBar: OptionBarStore;
  readonly unmount: () => void;
}

/**
 * 引数は全部任意。`onModalChange` を渡すと、最上位化の確認の板が開いた閉じたを
 * 控えられる（増分 5 の手直し B4 / A4）。
 */
function mountReparent(
  options: {
    onModalChange?: (open: boolean) => void;
    /** 一覧の印を対象として引き継ぐ経路（増分 7 の中身 2b / V8）。 */
    markedFeatureIds?: readonly FeatureId[];
  } = {},
): Harness {
  const onModalChange = options.onModalChange;
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

  // The live vertex store at the anchor time — the SAME wiring App's reparent bootstrap
  // binds (resolveStore → buildAffiliationProposal.vertexStore). Required for 直轄化 onto a
  // LEAF parent: FR-37 直轄領自動生成 resolves the parent's 元形状 from it, and the store-less
  // path now fail-closes (Codex fix 2) instead of silently discarding the parent's shape.
  const resolveStore = () => verticesAt(store.getState().domain, store.getState().currentTime);

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

  // オプションバー（設計書 §C.4）。本番の合成ルートでは `ToolOptionBar` が持っている
  // 同じ帯を渡す（この道具は持たずに対象欄だけを押し込む）。
  const optionBar = new OptionBarStore();

  // **増分 5d: 確定の列はオプションバーの確定欄に出る**（地図の上には無い）。
  // 帯そのものを一緒に載せないと確定ボタンが DOM に現れない ―― 検査の都合ではなく、
  // **実物がそうなっている**ということである。
  const utils = render(
    <>
      <OptionBar store={optionBar} />
      <ReparentToolController<DomainRoot>
        store={store}
        startProcess={live.startProcess}
        resolveFeatures={resolveFeatures}
        resolveStore={resolveStore}
        anchorTime={() => store.getState().currentTime}
        screenToWorld={screenToWorld}
        featureAtPoint={featureAtPoint}
        resolveLeafShape={resolveLeafShape}
        drawSink={drawSink}
        optionBar={optionBar}
        onCommitted={onCommitted}
        // **確定を同期で走らせる**（増分 7 の中身 9）。本番は 1 コマ遅らせて進行表示を
        // 出すが、検査は「何が起きるか」を見たいので待たせない（`useDeferredCommit` の
        // `schedule` を差し替える口はそのためにある）。
        commitScheduler={(run) => run()}
        {...(options.markedFeatureIds ? { markedFeatureIds: options.markedFeatureIds } : {})}
        {...(onModalChange ? { onModalChange } : {})}
      />
    </>,
  );

  return { store, lastHighlight: () => highlight, optionBar, unmount: utils.unmount };
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
    // **増分 7**: ［所属を変える］は対象さえ掴んでいれば押せる（押すと 3 択の板が開く）。
    // 旧版は「新しい上位領域を地図でクリック済み」までを条件にしていたので、地図に
    // 描かれていないまとめ役を親にしたい人はここへ辿り着けなかった。
    expect(screen.getByTestId('reparent-confirm')).not.toBeDisabled();

    // Second click = new parent (leaf-b) — 板の「既存から選ぶ」枝の初期値になる。
    clickInput(5, 1);
    expect(screen.getByTestId('reparent-parent').textContent).toBe('leaf-b');

    // CONFIRM (the COMPLETE trigger; 教訓 5.7) → 3 択の板 → 所属を変える。
    fireEvent.click(screen.getByTestId('reparent-confirm'));
    expect(screen.getByTestId('reparent-options-dialog')).toBeInTheDocument();
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBeUndefined(); // 確定までは非破壊
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBe(asFeatureId('leaf-b'));
    h.unmount();
  });

  it('N-12: 同じ地物をもう一度押しても対象は外れず、そう言う（増分 7 の中身 10）', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // pick leaf-a
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    clickInput(1, 1); // 同じ地物をもう一度
    // **黙って外さない**。旧版はここで対象が消え、次のクリックが「新しい対象」として
    // 読まれていた（N-05 と並ぶ「黙って消える」経路）。
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    expect(screen.getByTestId('reparent-message').textContent).toContain('同じ地物です');
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
    // 同じ地物をもう一度押しても **自分の親にはならない**（対象のままで、上位領域は
    // 選ばれない）。合法性の述語も自分自身を親にすることを拒む。
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-parent').textContent).toBe('');
    h.unmount();
  });

  it('最上位へ (detach / parentNone) button: enabled with a target alone, detaches a nested leaf (bughunt parentNone wiring)', () => {
    const h = mountReparent();
    activateReparent(h.store);

    // First reparent leaf-a UNDER leaf-b so it is nested (gives us something to detach).
    clickInput(1, 1); // target = leaf-a
    clickInput(5, 1); // new parent = leaf-b
    fireEvent.click(screen.getByTestId('reparent-confirm'));
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBe(asFeatureId('leaf-b'));

    // Re-arm (the confirm re-armed at pick-target) and pick the nested leaf-a as the target.
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    expect(screen.getByTestId('reparent-confirm-none')).not.toBeDisabled();

    // Click 最上位へ → **独立の枝で 3 択の板が開く**（増分 7 の中身 1。器は 1 つ）。
    // 旧版は押した瞬間に確定していた。確定そのもの（parentNone）はこの経路でしか
    // 到達できないので、ここで UI から最後まで通す。
    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    expect(screen.getByTestId('reparent-detach-confirm')).toBeInTheDocument();
    // 確認に答えるまでは何も起きていない（教訓 5.22 確定までの非破壊）。
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBe(asFeatureId('leaf-b'));
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(parentIdOf(effectiveById(h.store, 'leaf-a'))).toBeUndefined();
    h.unmount();
  });

  // --- 最上位化の確認（増分 5 の手直し B4 / バグ狩り B-1 / E4）-----------------

  it('最上位へは押した瞬間には確定せず、何が起きるかを見せる板を出す', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // target = leaf-a
    expect(screen.queryByTestId('reparent-detach-confirm')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    // 器は 3 択の作業ダイアログ 1 つ（増分 7 の中身 1 / 設計書 §B.5）。
    const dialog = screen.getByTestId('reparent-options-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // **何が起きるか**を言う（「よろしいですか」だけにしない）。
    expect(screen.getByTestId('reparent-detach-confirm').textContent).toContain(
      'どこにも所属しなくなります',
    );
    // 独立の枝が選ばれた状態で開く（押した部品と枝が 1 本の線でつながる）。
    expect(screen.getByTestId('reparent-parent-none')).toBeChecked();
    h.unmount();
  });

  it('確認の［やめる］を押すと何も起きず、対象は掛んだまま', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    fireEvent.click(screen.getByTestId('reparent-options-cancel'));
    expect(screen.queryByTestId('reparent-options-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    h.unmount();
  });

  it('板が開いているあいだは onModalChange(true) を報せる（鍵盤の持ち主が modal）', () => {
    const modal: boolean[] = [];
    const h = mountReparent({ onModalChange: (open) => modal.push(open) });
    activateReparent(h.store);
    clickInput(1, 1);
    expect(modal[modal.length - 1]).toBe(false);
    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    expect(modal[modal.length - 1]).toBe(true);
    fireEvent.click(screen.getByTestId('reparent-options-cancel'));
    expect(modal[modal.length - 1]).toBe(false);
    h.unmount();
  });

  it('板が開いているあいだの Escape は板を閉じるだけ（階段の最上段）', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    fireEvent.click(screen.getByTestId('reparent-confirm-none'));
    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.queryByTestId('reparent-options-dialog')).not.toBeInTheDocument();
    // 選んだものはそのまま残る（板を閉じただけ）。
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
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

// --- W3-AB fix-forward: キャンセル後の再アーム (knife / drill / ring-edit / merge と対称) --
//
// W3-B は knife / drill を ring-edit と同じ `setActiveTool(null)` に揃えたが reparent は
// `onCancelled` フックすら持たず、cancel が `reset(Idle)` だけだった。コントローラは Idle で
// `return null` なので、キャンセル後は activeTool が EditReparent のまま(toolbar は
// aria-pressed=true)でセッションだけ消え、同じボタンをもう一度押すとストアの press-toggle が
// tool→null を走らせて「何も起きない」。knife/drill で潰したのと同一の dead-button バグ。
describe('ReparentToolController — キャンセルはツール選択も解除して再アームできる (W3-AB)', () => {
  // **増分 5 の手直し B1: 道具を降りるのは［やめる］ボタンだけになった。** Escape は
  // 1 回で 1 段戻る階段で、道具を降りるのは大域の階段のいちばん下（設計書 §D.4）。
  it('キャンセル（［やめる］）で activeTool が null になり、同じツールの再選択で復活する', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');

    act(() => {
      fireEvent.click(screen.getByTestId('reparent-cancel'));
    });
    expect(screen.queryByTestId('reparent-tool')).not.toBeInTheDocument();
    expect(h.store.getState().activeTool).toBeNull();

    // 実機 repro: the user pressed the SAME button again and nothing happened.
    act(() => h.store.getState().setActiveTool(TOOL_ID.EditReparent));
    expect(screen.getByTestId('reparent-tool')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-target').textContent).toBe('');
    h.unmount();
  });

  it('キャンセルボタンも同じ経路 (単一の解除経路)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    fireEvent.click(screen.getByTestId('reparent-cancel'));
    expect(h.store.getState().activeTool).toBeNull();
    expect(screen.queryByTestId('reparent-tool')).not.toBeInTheDocument();
    h.unmount();
  });

  it('選択クリア (reparent-clear) はツールを解除しない (対象選択へ戻るだけ)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    fireEvent.click(screen.getByTestId('reparent-clear'));
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditReparent);
    expect(screen.getByTestId('reparent-tool')).toBeInTheDocument();
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

  // 増分 5 の手直し B1: Escape は道具を降りず、1 回で 1 段だけ戻る（設計書 §D.4）。
  // ここが見ているのは「文字の欄に焦点が無ければ道具の Escape が効く」ことなので、
  // 期待値を「対象が離れる」へ差し替える。
  it('Escape from a NON-editable focus still steps the reparent ladder (no regression)', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    act(() => fireEvent.keyDown(button, { key: 'Escape' }));
    expect(screen.getByTestId('reparent-tool')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-target').textContent).toBe('');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditReparent);
    button.remove();
    h.unmount();
  });

  // 対象も選びかけも無い局面の Escape は、**道具が何もせず大域の階段へ譲る**。
  it('何も掛んでいない Escape は preventDefault せず、大域の階段へ譲る', () => {
    const h = mountReparent();
    activateReparent(h.store);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditReparent);
    h.unmount();
  });

  // 選びかけの上位領域だけを外す 1 段目（対象は掛んだまま）。
  it('Escape はまず「新しい上位領域の選びかけ」だけを外す（階段 1 段目）', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // leaf-a = 対象
    clickInput(5, 1); // leaf-b = 移し先
    expect(screen.getByTestId('reparent-parent').textContent).toBe('leaf-b');

    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.getByTestId('reparent-parent').textContent).toBe('');
    expect(screen.getByTestId('reparent-target').textContent).toBe('leaf-a');

    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(screen.getByTestId('reparent-target').textContent).toBe('');
    expect(h.store.getState().activeTool).toBe(TOOL_ID.EditReparent);
    h.unmount();
  });

  // **元からの選択を巻き添えにしない**（GPT #8）。この道具は選択を昇格させていないので、
  // 道具の外で選んだ地物は階段のどの段でも消えてはいけない（旧版は clearSelection していた）。
  it('道具の外で選んだ地物は、Escape でも［やめる］でも消えない', () => {
    const h = mountReparent();
    activateReparent(h.store);
    act(() => h.store.getState().setActiveFeature(asFeatureId('leaf-b')));
    clickInput(1, 1); // 道具の対象は leaf-a（選択は書き換えない）
    expect(h.store.getState().activeFeature).toBe(asFeatureId('leaf-b'));

    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(h.store.getState().activeFeature).toBe(asFeatureId('leaf-b'));

    act(() => fireEvent.click(screen.getByTestId('reparent-cancel')));
    expect(h.store.getState().activeFeature).toBe(asFeatureId('leaf-b'));
    h.unmount();
  });
});

// 実機の欠陥（増分 4）: 「所属」を構えると、地物を選んでもオプションバーの対象欄が
// 「（選んでいません）」のままだった。この道具は自前の選択（`targetId`）を持ち、セッションの
// `activeFeature` を書かないので、帯を持っている `ToolOptionBar` からは見えない。だから
// **この道具が自分で対象欄へ押し込む**。ここで釘を打つのは 3 つ:
//   1. 対象を選ぶと、その地物の名前と種類が対象欄に出る（`describeOptionBarTarget` の書式）;
//   2. 選択を外すと空へ戻る;
//   3. 道具を降りる・部品が外れる、どの経路でも空へ戻る（教訓 5.2 全経路で破棄）。
describe('ReparentToolController — オプションバーの対象欄（設計書 §C.4）', () => {
  it('対象を選ぶと帯の対象欄にその名前が出る', () => {
    const h = mountReparent();
    activateReparent(h.store);
    // 構えただけでは何も選んでいない（器が「（選んでいません）」を出す）。
    expect(h.optionBar.get().target.name).toBeNull();

    clickInput(1, 1); // leaf-a を対象に選ぶ
    // 増分 5 の手直し B3 / 設計書 §C.4: 段階表示「手順 2/3」と、移し先の果て
    // 「→ 親: ?」まで出す。旧版は対象の名前しか出しておらず、**どこへ移そうとして
    // いるのかが画面のどこにも出ていなかった**。
    expect(h.optionBar.get().target).toEqual({
      stage: REPARENT_STRINGS.stage(2),
      name: REPARENT_STRINGS.targetWithParent(
        'leaf-a（末端地物）',
        REPARENT_STRINGS.parentUnset,
      ),
    });
    h.unmount();
  });

  it('移し先を選ぶと、対象欄に「対象 → 親: 移し先」が出る', () => {
    // 設計書 §C.4 の「対象: 南ケナ州 → 親: ?」の形。**移し先まで見せる**のが目的で、
    // 地図の色分け（HB3-15(c)）だけに任せない（増分 5 の手直し B3）。
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1); // leaf-a = 対象
    clickInput(5, 1); // leaf-b = 移し先
    expect(screen.getByTestId('reparent-parent').textContent).toBe('leaf-b');
    expect(h.optionBar.get().target.name).toBe(
      REPARENT_STRINGS.targetWithParent('leaf-a（末端地物）', 'leaf-b（末端地物）'),
    );
    // 両方揃ったので次は確定（手順 3/3）。
    expect(h.optionBar.get().target.stage).toBe(REPARENT_STRINGS.stage(3));
    h.unmount();
  });

  it('「選択を外す」で対象欄が空へ戻る', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).not.toBeNull();

    fireEvent.click(screen.getByTestId('reparent-clear'));
    expect(h.optionBar.get().target.name).toBeNull();
    // 帯はまだこの道具のものなので、段階表示は「手順 1/3」へ戻る。
    expect(h.optionBar.get().target.stage).toBe(REPARENT_STRINGS.stage(1));
    h.unmount();
  });

  it('道具を降りると対象欄が空へ戻る', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).not.toBeNull();

    act(() => {
      h.store.getState().setActiveTool(null);
    });
    expect(h.optionBar.get().target.name).toBeNull();
    h.unmount();
  });

  it('Escape で対象を離しても対象欄が空へ戻る（道具は持ったまま）', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).not.toBeNull();

    act(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(h.optionBar.get().target.name).toBeNull();
    expect(h.optionBar.get().target.stage).toBe(REPARENT_STRINGS.stage(1));
    h.unmount();
  });

  it('部品ごと外れても対象欄が空へ戻る（教訓 5.2 全経路で破棄）', () => {
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(h.optionBar.get().target.name).not.toBeNull();

    h.unmount();
    expect(h.optionBar.get().target.name).toBeNull();
  });

  it('帯を奪わない（`claim` しない）― 持ち主は ToolOptionBar のまま', () => {
    // 押し込みの API は持ち主を見ない規約（`option-bar.ts` の claim 注記 3）。ここで
    // `claim` すると帯が空へ戻り、`ToolOptionBar` が入れた道具名まで消える。
    const h = mountReparent();
    activateReparent(h.store);
    clickInput(1, 1);
    expect(h.optionBar.hasOwner()).toBe(false);
    h.unmount();
  });
});
