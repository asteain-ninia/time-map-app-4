// U30 — FR-52 結合オプションダイアログの結線テスト (the wiring-gap this closes).
//
// REGRESSION CONTEXT (FR-52 wiring-gap): the domain to choose a merge result's 上位領域
// (parent) and プロパティ inheritance source EXISTED and was unit-tested
// (allowedMergeParentCandidates / propertyInheritCandidates / the parentExisting /
// parentCreate / propertyNew decision variants) but was NEVER called from the UI —
// useMergeTool hardcoded parentNone + propertyInherit(first), so the parentCreate /
// parentExisting / propertyNew variants were structurally UNREACHABLE. This spec mounts
// the REAL MergeToolController, drives the merge flow to the options dialog, and asserts
// at the useMergeTool/MergeToolController seam that:
//   1. the dialog lists the correct parent + property candidates (the candidate functions
//      are really called over the live features);
//   2. choosing a NON-default parent / property produces a merge proposal carrying that
//      ParentDecision / PropertyDecision (intercepted at startProcess: the result feature's
//      parentId / name reflect the choice);
//   3. the seeded defaults (親なし + inherit-first) still merge on a plain 確定;
//   4. cancel returns to selecting without merging.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createAggregateFeature, createLeafFeature, type Feature, type LeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import { createGeoParams } from '../../domain/geo/geo-params';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { MergeSnapshot } from '../../domain/merge/index';

import { createSessionStore, TIME_CHANGE_SOURCE, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';
import { type DomainRoot } from '../consistency-binding';
import { featuresAt, verticesAt, leafShapeAt } from '../live-lookup';
import { createSharedIdMint } from '../App';

import {
  MergeToolController,
  type ScreenToWorld,
  type FeatureAtPoint,
  type ResolveLeafShape,
} from './MergeToolController';
import { MergeOptionsDialog } from './MergeOptionsDialog';
import type { PropertyDecision } from '../../domain/merge/index';

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

/**
 * Two edge-adjacent leaves (the merge targets) PLUS one separate top-level aggregate
 * "parentTop" (no children, present at the anchor) that is an ELIGIBLE existing parent
 * for the result (not a target, not a target descendant, period overlaps).
 */
function projectWithEligibleParent(): DomainRoot {
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
  const parentTop = createAggregateFeature(
    asFeatureId('parentTop'),
    createBasicAttributes('親トップ', 500, 1500),
    color,
    [],
  );
  project = applyAddProposal(project, {
    featureId: parentTop.id,
    anchorTime: ANCHOR,
    snapshot: { feature: parentTop, vertices: [], sharedCandidateIds: new Map() },
  });
  return project;
}

const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

interface Harness {
  readonly store: StoreApi<SessionStore<DomainRoot>>;
  /** The last EditProposal handed to startProcess (the merge proposal under test). */
  readonly lastProposal: () => EditProposal<MergeSnapshot> | null;
  readonly unmount: () => void;
}

/** Mount with a SPY startProcess that captures the proposal and reports Committed. */
function mountMerge(): Harness {
  const store = createSessionStore<DomainRoot>({
    initialDomain: projectWithEligibleParent(),
    initial: { mode: EDIT_MODE.Edit, activeTool: null },
  });
  act(() => {
    store.getState().setCurrentTime(ANCHOR, TIME_CHANGE_SOURCE.Slider);
  });

  const mint = createSharedIdMint(() => store.getState().domain);
  const ids = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  const resolveFeatures = () => featuresAt(store.getState().domain, store.getState().currentTime);
  const resolveStore = () => verticesAt(store.getState().domain, store.getState().currentTime);

  const featureAtPoint: FeatureAtPoint = (p) => {
    if (p.lat < 0 || p.lat > 2) return null;
    if (p.lon >= 0 && p.lon <= 2) return asFeatureId('leaf-a');
    if (p.lon > 2 && p.lon <= 4) return asFeatureId('leaf-b');
    return null;
  };
  const resolveLeafShape: ResolveLeafShape = (id) =>
    leafShapeAt(store.getState().domain, store.getState().currentTime, id) ?? undefined;

  // SPY: capture the proposal handed to U13 and report Committed (no real apply needed —
  // the seam under test is what ParentDecision / PropertyDecision the proposal carries).
  let captured: EditProposal<MergeSnapshot> | null = null;
  const startProcess = (proposal: EditProposal<MergeSnapshot>): ProcessResult<DomainRoot> => {
    captured = proposal;
    return { status: PROCESS_STATUS.Committed } as unknown as ProcessResult<DomainRoot>;
  };

  const utils = render(
    <MergeToolController<DomainRoot>
      store={store}
      startProcess={startProcess}
      ids={ids}
      resolveFeatures={resolveFeatures}
      resolveStore={resolveStore}
      anchorTime={() => store.getState().currentTime}
      screenToWorld={screenToWorld}
      featureAtPoint={featureAtPoint}
      resolveLeafShape={resolveLeafShape}
    />,
  );

  return { store, lastProposal: () => captured, unmount: utils.unmount };
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

/** Drive the flow to the open options dialog (pick the two adjacent leaves + 確定). */
function openDialog(store: StoreApi<SessionStore<DomainRoot>>): void {
  activateMerge(store);
  clickInput(1, 1); // leaf-a
  clickInput(3, 1); // leaf-b
  fireEvent.click(screen.getByTestId('merge-confirm'));
}

/** The result feature inside a captured merge snapshot. */
function resultFeature(proposal: EditProposal<MergeSnapshot>): Feature {
  const snap = proposal.snapshot;
  const f = snap.nextFeatures.find((x) => x.id === snap.resultFeatureId);
  if (f === undefined) throw new Error('result feature missing from snapshot');
  return f;
}

describe('MergeOptionsDialog — FR-52 上位領域・属性継承元の選択を UI へ結線', () => {
  it('確定 で結合オプションダイアログが開き、親候補・引き継ぎ元候補が候補関数どおりに並ぶ', () => {
    const h = mountMerge();
    openDialog(h.store);

    expect(screen.getByTestId('merge-options-dialog')).toBeInTheDocument();

    // 親候補: the eligible existing parent (parentTop) is offered; the two TARGETS are not.
    fireEvent.click(screen.getByTestId('merge-parent-existing'));
    const parentPick = screen.getByTestId('merge-parent-existing-pick') as HTMLSelectElement;
    const parentOptionValues = Array.from(parentPick.options).map((o) => o.value);
    expect(parentOptionValues).toContain('parentTop');
    expect(parentOptionValues).not.toContain('leaf-a');
    expect(parentOptionValues).not.toContain('leaf-b');

    // 引き継ぎ元候補: exactly the two merge targets (propertyInheritCandidates).
    const inheritPick = screen.getByTestId('merge-property-inherit-pick') as HTMLSelectElement;
    const inheritValues = Array.from(inheritPick.options).map((o) => o.value).sort();
    expect(inheritValues).toEqual(['leaf-a', 'leaf-b']);
    h.unmount();
  });

  it('既定 (親なし + 引き継ぎ先頭) のまま 結合を実行 すると最上位・先頭プロパティで結合される', () => {
    const h = mountMerge();
    openDialog(h.store);
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    const proposal = h.lastProposal();
    expect(proposal).not.toBeNull();
    const result = resultFeature(proposal!);
    // parentNone ⇒ no parentId (最上位).
    expect(result.parentId).toBeUndefined();
    // propertyInherit(first = leaf-a) ⇒ the result carries leaf-a's name.
    expect(result.attributes.name).toBe('leaf-a');
    h.unmount();
  });

  it('既存上位領域を選ぶと結果地物の parentId がその候補になる (parentExisting 経路)', () => {
    const h = mountMerge();
    openDialog(h.store);

    fireEvent.click(screen.getByTestId('merge-parent-existing'));
    fireEvent.change(screen.getByTestId('merge-parent-existing-pick'), {
      target: { value: 'parentTop' },
    });
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    const result = resultFeature(h.lastProposal()!);
    expect(result.parentId).toBe(asFeatureId('parentTop'));
    h.unmount();
  });

  it('新規上位領域を作成すると結果地物の親が新規集約になる (parentCreate 経路)', () => {
    const h = mountMerge();
    openDialog(h.store);

    fireEvent.click(screen.getByTestId('merge-parent-create'));
    fireEvent.change(screen.getByTestId('merge-parent-create-name'), {
      target: { value: '新しい連邦' },
    });
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    const proposal = h.lastProposal()!;
    const result = resultFeature(proposal);
    // The result's parent is a NEWLY-created aggregate (in createdIds, not a pre-existing id).
    expect(result.parentId).toBeDefined();
    expect(proposal.snapshot.createdIds).toContain(result.parentId as FeatureId);
    const newParent = proposal.snapshot.nextFeatures.find((f) => f.id === result.parentId);
    expect(newParent?.kind).toBe('aggregate');
    expect(newParent?.attributes.name).toBe('新しい連邦');
    h.unmount();
  });

  it('引き継ぎ元に 2 番目の対象を選ぶと結果プロパティがその対象になる (propertyInherit 経路)', () => {
    const h = mountMerge();
    openDialog(h.store);

    fireEvent.change(screen.getByTestId('merge-property-inherit-pick'), {
      target: { value: 'leaf-b' },
    });
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    const result = resultFeature(h.lastProposal()!);
    expect(result.attributes.name).toBe('leaf-b');
    h.unmount();
  });

  it('新規プロパティを入力すると結果地物がその名称になる (propertyNew 経路)', () => {
    const h = mountMerge();
    openDialog(h.store);

    fireEvent.click(screen.getByTestId('merge-property-new'));
    fireEvent.change(screen.getByTestId('merge-property-new-name'), {
      target: { value: '統合領域' },
    });
    fireEvent.click(screen.getByTestId('merge-options-confirm'));

    const result = resultFeature(h.lastProposal()!);
    expect(result.attributes.name).toBe('統合領域');
    h.unmount();
  });

  it('ダイアログをキャンセルすると結合せず選択状態へ戻る (targets 保持)', () => {
    const h = mountMerge();
    openDialog(h.store);
    expect(screen.getByTestId('merge-options-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('merge-options-cancel'));
    // The dialog closes; no proposal was built; the targets persist (still 2 picked).
    expect(screen.queryByTestId('merge-options-dialog')).not.toBeInTheDocument();
    expect(h.lastProposal()).toBeNull();
    expect(screen.getByTestId('merge-target-count').textContent).toBe('2');
    h.unmount();
  });
});

// bughunt review #1: the結合オプション dialog is a `role="dialog"` modal and the a11y
// module documents it as a trap target, but it used to inline an Esc-only onKeyDown with
// no Tab-wrap. It now shares `useModalKeydown` like the other 5 modals. These mount the
// dialog directly (no controller) to verify focus-on-mount + Esc + Tab cycling.
describe('MergeOptionsDialog — 共有モーダル a11y (useModalKeydown, review #1)', () => {
  const CANDIDATES = [
    { featureId: asFeatureId('leaf-a'), displayName: 'leaf-a' },
    { featureId: asFeatureId('leaf-b'), displayName: 'leaf-b' },
  ] as const;

  function renderDialog(overrides?: {
    readonly onCancel?: () => void;
    readonly onConfirm?: (p: unknown, q: PropertyDecision) => void;
  }) {
    const onCancel = overrides?.onCancel ?? vi.fn();
    const onConfirm = overrides?.onConfirm ?? vi.fn();
    const buildNewProperties = (name: string): PropertyDecision => ({
      kind: 'new',
      properties: { attributes: createBasicAttributes(name, 0, 100), color },
    });
    return render(
      <MergeOptionsDialog
        parentCandidates={CANDIDATES}
        propertyCandidates={CANDIDATES}
        buildNewProperties={buildNewProperties}
        onConfirm={onConfirm as never}
        onCancel={onCancel}
      />,
    );
  }

  it('マウント時にダイアログへフォーカスが移る (focus-on-mount)', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByTestId('merge-options-dialog'));
  });

  it('Esc で onCancel が呼ばれる', () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(screen.getByTestId('merge-options-dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('末尾フォーカスから Tab で先頭へ循環する (Tab-wrap, 背面へ抜けない)', () => {
    renderDialog();
    const dialog = screen.getByTestId('merge-options-dialog');
    // The last focusable is the 結合を実行 (confirm) button; the first is 親なし radio.
    const confirmBtn = screen.getByTestId('merge-options-confirm');
    const firstRadio = screen.getByTestId('merge-parent-none');
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(firstRadio);
  });

  it('先頭フォーカスから Shift+Tab で末尾へ循環する', () => {
    renderDialog();
    const dialog = screen.getByTestId('merge-options-dialog');
    const confirmBtn = screen.getByTestId('merge-options-confirm');
    const firstRadio = screen.getByTestId('merge-parent-none');
    firstRadio.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
  });
});
