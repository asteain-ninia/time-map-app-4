// W3-A — ナイフの「対象取得」と「対象面強調」を単一真実源に固定する回帰テスト
// (FR-44 / FR-90 / FR-92 / FR-113, 教訓 5.29 二重真実源を作らない / HB3-16 前例).
//
// WHY THIS FILE EXISTS (HB4-1 診断の副次発見・実測証拠 screenshots/__visual__/
// hb4-1-b2-child-click.png):
// ナイフだけが対象取得に表示解決の `drawnAreaAt`(=描画されている集約体 id)を使い、
// 強調表示には生リーフ解決の `leafShapeAt`(=末端地物の生形状)を使っていた。二つの解決が
// 別物なので、既定の集約表示 (globalDepth=0) では:
//   (a) FR-35 の真の集約地物(shapeless)をクリックすると `leafShapeAt` が undefined を返し
//       強調がゼロ = 何も選べていないように見える(実際 LEAF ゲートに弾かれ分割不能);
//   (b) FR-37 の遷移状態(子を持つ末端地物 = 直轄領構成)では、描かれているのは
//       「親自身の形状 ∪ 子の形状」の集約形状なのに、強調されるのは親の生形状だけ =
//       クリックした場所と全く別の場所が光る。
// 結合/所属変更/リング編集/穴あけは HB3-16 で `leafAtPoint` + ツール専用ハイライトへ
// 移行済みで、ナイフだけが取り残されていた。
//
// このファイルが固定する不変条件は「クリックした場所の形が強調される」ことそのもの:
//   1. 対象取得は生リーフ (`leafAtPoint`) — 集約表示中でも集約体の下の個別リーフを直接
//      ターゲットにできる (HB3-16 と同型。FR-44「集約地物は直接分割できない」を、
//      拒否メッセージではなく「クリック位置のリーフへ解決」で満たす);
//   2. 強調形状は「取得した対象そのもの」の解決形状で、クリック点を必ず内包する;
//   3. 強調の出所はツール自身のターゲット (`knife.state.targetId`) であって、ストアの
//      `activeFeature` ではない(選択が残っているだけで強調が出る二重真実源を断つ);
//   4. FR-113 で非表示のリーフはツール取得からも消える。
//
// W3-AB fix-forward (レビュー HIGH): 可視ゲートと形状解決は「取得の瞬間」だけでなく
// 取得した後も効き続けなければならない。削除した knife-target-shape.test.tsx が持っていた
// 「gate は SKIP であって FREEZE ではない」(camera は再解決しない / 時刻・選択は再解決する)
// の逆方向不変条件をここへ継承し、さらに:
//   5. 対象取得後に時刻を動かすと強調が現在時刻の形へ再解決される(凍結しない);
//   6. 対象取得後にその末端を FR-113 で非表示にすると、強調が消え対象選択へ戻る
//      (= 非表示地物は分割できない。ストアの activeFeature heal と対称);
//   7. 本番結線 (`createKnifeBootstrap` の featureAtPoint = leafAtPoint + 可視ゲート) を
//      実コントローラへ通し、非表示リーフがコントローラ経由でも取得できないこと。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { createKnifeBootstrap, createSharedIdMint } from './App';
import { leafShapeAt } from './live-lookup';
import { drawnAreaAt } from './map/live-hit-test';
import { resolveDisplayFor } from './map/display-resolution-cache';
import { isFeatureVisibleUnderFilter } from './map/filtered-display';
import { createSessionStore, type SessionStore } from './state/store';
import { EDIT_MODE } from './state/session';
import { TOOL_ID } from './shell/tools';
import type { DomainRoot } from './consistency-binding';

import { KnifeToolController, type KnifeDrawSink, type ScreenToWorld } from './knife/index';

import { applyAddProposal } from '../domain/editing/apply-proposal';
import { createEditProposal } from '../domain/consistency/index';
import { timePointYear } from '../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  withParentId,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, type Vertex } from '../domain/vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { createGeoParams } from '../domain/geo/geo-params';
import { POINT_LOCATION, pointInPolygon } from '../domain/geometry/index';
import type { GeoMultiPolygon } from '../domain/geometry/types';
import type { AddSnapshot } from '../domain/add/index';
import type { DrawPrimitive } from '../render/map-renderer';

// --- Fixtures ---------------------------------------------------------------

const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const TIME = timePointYear(1000);

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

/** A square leaf spanning [ox, ox+size] × [oy, oy+size]. */
function squareLeaf(
  idRaw: string,
  ox: number,
  oy: number,
  size: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`v-${idRaw}-${i}`), { lon: c[0] + ox, lat: c[1] + oy }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices };
}

function commit(root: DomainRoot, f: { feature: Feature; vertices: Vertex[] }): DomainRoot {
  const snapshot: AddSnapshot = {
    feature: f.feature,
    vertices: f.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(root, createEditProposal(f.feature.id, TIME, snapshot));
}

/**
 * FR-35 の真の集約構成: shapeless な集約地物 `agg` の下に、離れた2つの末端リーフ。
 * 既定の集約表示 (globalDepth=0) では `agg` の集約形状(子の和)だけが描かれ、子は描かれない。
 */
function trueAggregateRoot(): {
  root: DomainRoot;
  aggId: FeatureId;
  childAId: FeatureId;
  childBId: FeatureId;
} {
  const aggId = asFeatureId('f-agg');
  const childA = squareLeaf('f-childA', 0, 0, 4); // [0,4]²
  const childB = squareLeaf('f-childB', 10, 0, 4); // [10,14]×[0,4]
  const agg = createAggregateFeature(
    aggId,
    createBasicAttributes('agg', 0, 0),
    COLOR,
    [childA.feature.id, childB.feature.id],
  );
  let root = commit(emptyProject(), { feature: agg, vertices: [] });
  root = commit(root, { feature: withParentId(childA.feature, aggId), vertices: childA.vertices });
  root = commit(root, { feature: withParentId(childB.feature, aggId), vertices: childB.vertices });
  return { root, aggId, childAId: childA.feature.id, childBId: childB.feature.id };
}

/**
 * FR-37 の直轄領構成 (末端→集約の遷移状態): 親自身が末端地物として自分の形状 = 直轄領
 * ([0,10]²) を持ちつつ、離れた子リーフ ([20,30]²) を従える。U08 の `resolveFeatureArea`
 * は「子を持つ末端は自分の footprint も残す」ので、描かれる集約形状は 親∪子 = 2 片。
 * 親の生形状だけを強調すると、子の footprint をクリックしたのに全く別の場所が光る。
 */
function directTerritoryRoot(): {
  root: DomainRoot;
  parentId: FeatureId;
  childId: FeatureId;
} {
  const parent = squareLeaf('f-parent', 0, 0, 10); // 直轄領 [0,10]²
  const child = squareLeaf('f-child', 20, 20, 10); // 子 [20,30]²
  let root = commit(emptyProject(), parent);
  root = commit(root, {
    feature: withParentId(child.feature, parent.feature.id),
    vertices: child.vertices,
  });
  return { root, parentId: parent.feature.id, childId: child.feature.id };
}

/**
 * FR-37 直轄領構成の OVERLAP 版 (レビュー LOW #4 の空白を埋める): 親の直轄領 [0,10]² の
 * 内側に子 [4,8]² が入れ子で重なる。`leafAtPoint` の勝者決定は「後の履歴が上」= `featuresAt`
 * の走査順であって階層の深さではないので、重なり部分をクリックしたときに「ナイフが拾うリーフ」と
 * 「レンダラが最前面に描くリーフ」が一致するかは離れた構成では一度も検証されていなかった。
 */
function overlappingTerritoryRoot(): {
  root: DomainRoot;
  parentId: FeatureId;
  childId: FeatureId;
} {
  const parent = squareLeaf('f-parent', 0, 0, 10); // 直轄領 [0,10]²
  const child = squareLeaf('f-child', 4, 4, 4); // 子 [4,8]² — 親の内側
  let root = commit(emptyProject(), parent);
  root = commit(root, {
    feature: withParentId(child.feature, parent.feature.id),
    vertices: child.vertices,
  });
  return { root, parentId: parent.feature.id, childId: child.feature.id };
}

/** Every leaf is FR-113-visible (the gate itself is exercised separately). */
const ALWAYS_VISIBLE = (): boolean => true;

function knifePorts(root: DomainRoot, isVisible: (id: FeatureId) => boolean = ALWAYS_VISIBLE) {
  return createKnifeBootstrap(
    () => root,
    () => TIME,
    createSharedIdMint(() => root),
    isVisible,
  );
}

/** `true` when `shape` contains the world point (穴透過 = the domain containment rule). */
function contains(shape: GeoMultiPolygon | undefined, point: { lon: number; lat: number }): boolean {
  if (shape === undefined) return false;
  return shape.some((polygon) => pointInPolygon(point, polygon) === POINT_LOCATION.Inside);
}

// --- 1. 対象取得 + 強調形状の解決が同一源であること (production wiring) ----------

describe('W3-A ナイフ対象取得 — 集約表示でもクリック位置のリーフへ解決する (HB3-16 と同型)', () => {
  it('FR-35 真の集約: 集約体の body クリックが個別リーフへ解決し、その形状が強調できる', () => {
    const { root, aggId, childAId, childBId } = trueAggregateRoot();
    const ports = knifePorts(root);

    // 集約表示 (globalDepth=0) では agg の集約形状しか描かれないが、ナイフの対象は
    // クリック位置の LEAF (FR-44: 集約地物は分割対象にならない → リーフへ解決する).
    expect(ports.featureAtPoint({ lon: 2, lat: 2 })).toBe(childAId);
    expect(ports.featureAtPoint({ lon: 12, lat: 2 })).toBe(childBId);
    // 旧実装は表示解決の集約体 id を返していた(= LEAF ゲートで必ず拒否 = 分割不能).
    expect(ports.featureAtPoint({ lon: 2, lat: 2 })).not.toBe(aggId);

    // 強調形状は「取得した対象そのもの」の解決形状で、クリック点を内包する。
    const shape = ports.resolveLeafShape(childAId);
    expect(shape).toBeDefined();
    expect(contains(shape, { lon: 2, lat: 2 })).toBe(true);
    // 真の集約体は shapeless (FR-35) なので、集約体 id では強調形状が出ない=
    // 旧経路(集約体を対象にして leafShapeAt を引く)が強調ゼロだった証拠。
    expect(ports.resolveLeafShape(aggId)).toBeUndefined();
  });

  it('FR-37 直轄領構成: 子の footprint クリックは子へ解決し、親の生形状は強調されない', () => {
    const { root, parentId, childId } = directTerritoryRoot();
    const ports = knifePorts(root);

    const clickOnChild = { lon: 25, lat: 25 };
    expect(ports.featureAtPoint(clickOnChild)).toBe(childId);
    // 旧実装: drawnAreaAt が丸め先の親 id を返し、leafShapeAt(親) = 直轄領 [0,10]² を
    // 強調 = クリックした場所と別の場所が光る(hb4-1-b2-child-click.png の症状)。
    expect(ports.featureAtPoint(clickOnChild)).not.toBe(parentId);
    expect(contains(ports.resolveLeafShape(childId), clickOnChild)).toBe(true);
    expect(contains(ports.resolveLeafShape(parentId), clickOnChild)).toBe(false);
  });

  it('FR-37 直轄領構成: 直轄領(親自身の形状)のクリックは親へ解決し、その形状が強調される', () => {
    const { root, parentId } = directTerritoryRoot();
    const ports = knifePorts(root);

    const clickOnDirect = { lon: 5, lat: 5 };
    expect(ports.featureAtPoint(clickOnDirect)).toBe(parentId);
    expect(contains(ports.resolveLeafShape(parentId), clickOnDirect)).toBe(true);
  });

  it('どちらの構成でも「強調形状 = 取得した対象の形状」で、クリック点を内包する', () => {
    const cases: readonly { root: DomainRoot; point: { lon: number; lat: number } }[] = [
      { root: trueAggregateRoot().root, point: { lon: 2, lat: 2 } },
      { root: trueAggregateRoot().root, point: { lon: 12, lat: 2 } },
      { root: directTerritoryRoot().root, point: { lon: 5, lat: 5 } },
      { root: directTerritoryRoot().root, point: { lon: 25, lat: 25 } },
    ];
    for (const { root, point } of cases) {
      const ports = knifePorts(root);
      const fid = ports.featureAtPoint(point);
      expect(fid).not.toBeNull();
      const shape = ports.resolveLeafShape(fid!);
      // 単一真実源: 取得も強調も同じ live-lookup 由来 (leafAtPoint / leafShapeAt).
      expect(shape).toEqual(leafShapeAt(root, TIME, fid!));
      expect(contains(shape, point)).toBe(true);
    }
  });

  it('FR-113 非表示のリーフはツール取得からも消える (描画==ヒット==分割対象)', () => {
    const { root, childAId, childBId } = trueAggregateRoot();
    const ports = knifePorts(root, (id) => id !== childAId);
    expect(ports.featureAtPoint({ lon: 2, lat: 2 })).toBeNull();
    expect(ports.featureAtPoint({ lon: 12, lat: 2 })).toBe(childBId);
  });

  it('FR-37 重なり構成: 重なり部分の勝者はレンダラ最前面 (drawnAreaAt) と一致する', () => {
    // レビュー LOW #4: 親 footprint と子が重なる入れ子で、ナイフが拾うリーフと
    // レンダラが最前面に描くリーフが食い違えば「クリックした場所と別の場所が光る」が
    // 別経路で再発する。両者を同じ点で突き合わせて固定する。
    const { root, parentId, childId } = overlappingTerritoryRoot();
    const ports = knifePorts(root);
    const overlap = { lon: 6, lat: 6 }; // 親 [0,10]² ∩ 子 [4,8]²
    // 子も親の実形状も描かれる深度 (globalDepth を十分に上げる = FR-42 の詳細表示)。
    const drawn = drawnAreaAt(
      {
        root,
        time: TIME,
        displayControl: { globalDepth: 8, focus: { originId: null, depth: 0, emphasize: false } },
      },
      overlap,
    );
    const picked = ports.featureAtPoint(overlap);
    expect(picked).toBe(drawn);
    expect(picked).toBe(childId);
    // 強調はクリック点を内包し、親の直轄領だけをクリックすれば親が勝つ (非重なり側は不変)。
    expect(contains(ports.resolveLeafShape(picked!), overlap)).toBe(true);
    expect(ports.featureAtPoint({ lon: 1, lat: 1 })).toBe(parentId);
  });

  it('どのリーフにも当たらないクリックは null (穴透過/範囲外はミス)', () => {
    const { root } = trueAggregateRoot();
    expect(knifePorts(root).featureAtPoint({ lon: 7, lat: 2 })).toBeNull();
  });
});

// --- 2. 強調の出所はツール自身のターゲット (ストア選択ではない) -------------------

/** Identity screen→world so a click at (clientX, clientY) lands at world (x, y). */
const screenToWorld: ScreenToWorld = (clientX, clientY) => ({ lon: clientX, lat: clientY });

interface Harness {
  readonly store: StoreApi<SessionStore<DomainRoot>>;
  readonly batches: DrawPrimitive[][];
  readonly resolveLeafShape: ReturnType<typeof vi.fn>;
  readonly unmount: () => void;
}

/**
 * Mount the REAL KnifeToolController over `root` with the PRODUCTION ports — i.e. the
 * ports `createKnifeBootstrap` itself returns, INCLUDING the FR-113 可視ゲート
 * (`isToolTargetVisible`) the composition root layers on `leafAtPoint` (レビュー LOW #5:
 * the previous harness passed a bare `leafAtPoint`, so「実コントローラ経由で非表示リーフが
 * 取得できない」は一度も検証されていなかった). Root / time / filter are read from the SAME
 * session store the controller subscribes to, so a time move or a 個別非表示 in a test flows
 * through exactly the production path (教訓 5.6 stale capture を作らない).
 */
function mountKnifeOver(root: DomainRoot): Harness {
  const store = createSessionStore<DomainRoot>({
    initialDomain: root,
    initial: { mode: EDIT_MODE.Edit, activeTool: null, currentTime: TIME },
  });

  const batches: DrawPrimitive[][] = [];
  const drawSink: KnifeDrawSink = {
    drawKnife(prims) {
      batches.push([...prims]);
    },
  };

  // The composition root's FR-113 gate, verbatim (App.isToolTargetVisible).
  const ports = createKnifeBootstrap(
    () => store.getState().domain,
    () => store.getState().currentTime,
    createSharedIdMint(() => store.getState().domain),
    (featureId) => {
      const s = store.getState();
      return isFeatureVisibleUnderFilter(
        resolveDisplayFor(s.domain, s.currentTime, s.displayControl),
        s.filter,
        featureId,
      );
    },
  );
  const resolveLeafShape = vi.fn(ports.resolveLeafShape);

  const utils = render(
    <KnifeToolController<DomainRoot>
      store={store}
      startProcess={ports.startProcess}
      ids={ports.ids}
      resolveFeature={ports.resolveFeature}
      resolveStore={ports.resolveStore}
      anchorTime={() => store.getState().currentTime}
      screenToWorld={screenToWorld}
      featureAtPoint={ports.featureAtPoint}
      resolveLeafShape={resolveLeafShape}
      drawSink={drawSink}
      defaultColor={COLOR}
    />,
  );

  return { store, batches, resolveLeafShape, unmount: utils.unmount };
}

/** The 直轄領構成 harness (親の直轄領と離れた子). */
function mountKnifeOverHierarchy(): Harness {
  return mountKnifeOver(directTerritoryRoot().root);
}

function activateKnife(store: StoreApi<SessionStore<DomainRoot>>): void {
  act(() => {
    store.getState().setMode(EDIT_MODE.Edit);
    store.getState().setActiveTool(TOOL_ID.EditKnife);
  });
}

function clickInput(lon: number, lat: number): void {
  fireEvent.pointerDown(screen.getByTestId('knife-input-layer'), {
    clientX: lon,
    clientY: lat,
    button: 0,
  });
}

/** The emphasis primitives of the LAST pushed batch (`shape` kind = 対象面強調). */
function lastEmphasis(h: Harness): DrawPrimitive[] {
  const last = h.batches[h.batches.length - 1] ?? [];
  return last.filter((p) => p.kind === 'shape');
}

describe('W3-A ナイフ対象面強調 — 出所はツール自身のターゲット (単一真実源)', () => {
  it('対象未選択なら、ストアに別の選択が残っていても強調は出ない', () => {
    const h = mountKnifeOverHierarchy();
    // A leftover selection from a previous operation (旧実装はこれを強調していた).
    act(() => h.store.getState().setActiveFeature(asFeatureId('f-parent')));
    activateKnife(h.store);
    expect(screen.getByTestId('knife-guide').textContent).toContain('末端地物を選択');
    expect(lastEmphasis(h)).toHaveLength(0);
    h.unmount();
  });

  it('クリックした位置のリーフの形状がそのまま強調される (クリック点を内包)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    clickInput(25, 25); // 子リーフ [20,30]² の中
    expect(h.store.getState().activeFeature).toBe(asFeatureId('f-child'));

    const emphasis = lastEmphasis(h);
    expect(emphasis).toHaveLength(1);
    const prim = emphasis[0]!;
    expect(prim.kind === 'shape' && contains(prim.pieces, { lon: 25, lat: 25 })).toBe(true);
    // 親(直轄領)の生形状は強調されない = クリックと別の場所が光らない。
    expect(prim.kind === 'shape' && contains(prim.pieces, { lon: 5, lat: 5 })).toBe(false);
    h.unmount();
  });

  it('カメラだけの更新では対象形状を再解決しない (camera は React 描画パスに乗せない)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    clickInput(5, 5); // 直轄領(親)を対象に
    const callsAfterSelect = h.resolveLeafShape.mock.calls.length;
    act(() => {
      h.store.getState().updateCamera({ zoom: 12 });
      h.store.getState().setCenterLon(3);
    });
    expect(h.resolveLeafShape.mock.calls.length).toBe(callsAfterSelect);
    h.unmount();
  });

  it('キャンセルすると強調も消える (教訓 5.2 全経路で破棄)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    clickInput(5, 5);
    expect(lastEmphasis(h)).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(lastEmphasis(h)).toHaveLength(0);
    h.unmount();
  });
});

// --- 3. 取得後も可視ゲート / 形状解決が効き続ける (gate は SKIP であって FREEZE ではない) --
//
// 削除された knife-target-shape.test.tsx の逆方向不変条件 ('a time change STILL flows
// through the gate (skip, not freeze)') の継承 + FR-113 の取得後追随 (W3-AB レビュー HIGH)。

describe('W3-A fix-forward: 取得済みターゲットは時刻 / FR-113 の変化に追随する', () => {
  it('時刻を動かすと強調が再解決される (camera は skip、時刻は freeze しない)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    clickInput(5, 5); // 直轄領(親)を対象に
    const callsAfterSelect = h.resolveLeafShape.mock.calls.length;
    const emphasisAtT0 = lastEmphasis(h);
    expect(emphasisAtT0).toHaveLength(1);

    act(() => {
      h.store.getState().setCurrentTime(timePointYear(1500), 'numericJump');
    });

    // 取得時の形で凍結せず、現在時刻に対して解決し直している
    // (= 確定が anchorTime()=現在時刻で切る形と、ユーザーが見ている強調が一致する)。
    expect(h.resolveLeafShape.mock.calls.length).toBeGreaterThan(callsAfterSelect);
    const emphasisAtT1 = lastEmphasis(h);
    expect(emphasisAtT1).toHaveLength(1);
    const prim = emphasisAtT1[0]!;
    expect(prim.kind === 'shape' && contains(prim.pieces, { lon: 5, lat: 5 })).toBe(true);
    h.unmount();
  });

  it('対象を FR-113 で非表示にすると強調が消え、対象選択へ戻る (非表示地物は分割できない)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    clickInput(25, 25); // 子リーフを対象に → DrawingCut
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('drawing-cut');
    expect(lastEmphasis(h)).toHaveLength(1);

    act(() => {
      h.store.getState().setFeatureHidden(asFeatureId('f-child'), true);
    });

    // 不変条件「非表示地物はツール取得からも消える(描画==ヒット==分割対象)」は取得の
    // 瞬間だけでなく取得後も成立する: 強調は残らず、セッションは対象選択へ戻る。
    expect(lastEmphasis(h)).toHaveLength(0);
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('selecting-target');
    expect(screen.getByTestId('knife-message').textContent).toContain('表示されなくなった');
    h.unmount();
  });

  it('FR-113 非表示のリーフは実コントローラ経由でも取得できない (本番結線の可視ゲート)', () => {
    const h = mountKnifeOverHierarchy();
    activateKnife(h.store);
    act(() => {
      h.store.getState().setFeatureHidden(asFeatureId('f-child'), true);
    });
    clickInput(25, 25); // 非表示にした子リーフの上
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('selecting-target');
    expect(lastEmphasis(h)).toHaveLength(0);
    // 見えている親の直轄領はそのまま取得できる (ゲートは対象を狭めるだけ)。
    clickInput(5, 5);
    expect(screen.getByTestId('knife-tool').dataset['flow']).toBe('drawing-cut');
    h.unmount();
  });

  it('非表示になった対象は確定経路 (resolveFeature) からも消える (多重防御)', () => {
    // コントローラの追随を経由しない層 — 本番 `resolveFeature` port 単体。confirmCut /
    // save はこれで対象面を引くので、ここが素通りだと非表示地物を切れてしまう。
    const { root, childId, parentId } = (() => {
      const t = directTerritoryRoot();
      return { root: t.root, childId: t.childId, parentId: t.parentId };
    })();
    const hidden = new Set<FeatureId>([childId]);
    const ports = createKnifeBootstrap(
      () => root,
      () => TIME,
      createSharedIdMint(() => root),
      (fid) => !hidden.has(fid),
    );
    expect(ports.resolveFeature(childId)).toBeUndefined();
    expect(ports.resolveLeafShape(childId)).toBeUndefined();
    expect(ports.resolveFeature(parentId)).toBeDefined();
    expect(ports.resolveLeafShape(parentId)).toBeDefined();
  });
});
