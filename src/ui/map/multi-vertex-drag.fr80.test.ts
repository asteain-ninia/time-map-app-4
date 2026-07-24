// FR-80 複数頂点同時移動 — the LIVE drag path (矩形/Shift で選んだ頂点集合を掴んで動かす).
//
// WHAT WAS MISSING (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」): the SELECTION
// side of FR-80 (矩形 / Shift での頂点集合構築) and the reducer's release-time
// `SimultaneousMoveSpec` both existed, but the spec was UNREACHABLE — a non-empty press
// never enters `live-selection-port`'s drag branch (that gesture belongs to the U24 edit
// session), and the edit session's `targetFromHit` only ever built a SINGLE-vertex
// `VertexMove` target. So selecting 3 頂点 and dragging one of them moved exactly one.
//
// The live path now carries the whole set: the grabbed vertex is the PRIMARY and the rest
// are `companionVertexIds` on the very same session, so ONE gesture = ONE snapshot = ONE
// undo unit (FR-80「単一の編集操作として扱う」).
//
// SEMANTICS FIXED HERE (要件が規定しない部分の暫定決定 — see the ADR-style notes in
// edit-session-adapter.applyMove and domain/selection/state.companionVertexIdsFor):
//   - 滑り (FR-28/89) / スナップ (FR-31) の対象は掴んだ主頂点のみ。随伴頂点は主頂点の
//     実変位と同一ベクトルの剛体移動 (これが「選択セット全体を同一ベクトル」を守る唯一の解釈)。
//   - 主頂点は自分の随伴頂点にスナップしない (選択が自分自身に潰れるのを防ぐ)。
//   - 選択セットの所有地物は U22 上 `vertexOwner: FeatureId | null` で常に単一。よって
//     「複数地物に跨る選択」は表現不能であり、掴んだ地物 ≠ 所有地物なら随伴なし。
//   - HB4-2 SCOPE 遵守: 随伴集合はコミット済み頂点 id のみ (U22 選択は描画済み頂点しか
//     持たない)。edge-add の予約 id は VertexMove 以外なので混入しえない。

import { describe, expect, it } from 'vitest';

import {
  EDIT_TOOL,
  beginDrag,
  movingVertexIds,
  moveDraggedVertexSet,
  type DragSession,
} from '../../domain/editing';
import {
  EMPTY_SELECTION,
  companionVertexIdsFor,
  replaceVertices,
  vertexHit,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import { PROCESS_STATUS } from '../../domain/consistency';
import { RELEASE_OUTCOME } from '../../domain/editing';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createCoordinate } from '../../domain/coordinate';
import { createVertex, createVertexStore, getVertex } from '../../domain/vertex';
import { createLeafFeature } from '../../domain/feature';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
  squareLeaf,
} from '../../domain/persistence/fixtures';
import type { DomainProject } from '../../domain/persistence/index';
import { timePointYear } from '../../domain/time/time-point';
import type { ScreenPoint } from '../../render';
import { verticesAt } from '../live-lookup';
import { createLiveEditBinding } from '../consistency-binding';
import { createEditSessionPort, type SlideSnapNeighbours } from './edit-session-adapter';
import { NO_MODIFIERS } from './ports';
import { buildEditSnapshot } from './edit-session-snapshot';
import { previewVertexStore } from './active-feature-handles';
import { createNeighboursQuery } from './slide-snap-neighbours';

const LEAF_A = asFeatureId('leaf-a');
const RING_A = asRingId('leaf-a-r');
const V0 = asVertexId('leaf-a-0'); // (0,0)
const V1 = asVertexId('leaf-a-1'); // (10,0)
const V2 = asVertexId('leaf-a-2'); // (10,10)
const V3 = asVertexId('leaf-a-3'); // (0,10)
const TIME = timePointYear(0);
const NO_NEIGHBOURS: SlideSnapNeighbours = { edges: [], candidates: [], snapCandidates: [] };

/** A single square leaf 地物 (0,0)-(10,10) as the whole project. */
function squareProject(): DomainProject {
  const a = squareLeaf('leaf-a', 'A国', 0, 0, 10);
  return {
    histories: [singleAnchorHistory('leaf-a', [a.feature], createVertexStore(a.vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** The U22 selection with `ids` selected under leaf-a. */
function selectionOf(...ids: readonly ReturnType<typeof asVertexId>[]): SelectionState {
  return replaceVertices(EMPTY_SELECTION, LEAF_A, new Set(ids));
}

/** Read a committed vertex's coordinate out of a project at t=0. */
function coordOf(root: DomainProject, id: ReturnType<typeof asVertexId>) {
  const v = getVertex(verticesAt(root, TIME), id);
  expect(v).toBeDefined();
  return v!.coordinate;
}

// ---------------------------------------------------------------------------
// 1. U22 rule: which vertices ride along
// ---------------------------------------------------------------------------

describe('companionVertexIdsFor — FR-80 随伴頂点の決定規則 (U22 の単一実装)', () => {
  it('選択中の頂点を掴めば、同じ選択の残り全部が随伴する', () => {
    const companions = companionVertexIdsFor(selectionOf(V1, V2, V3), LEAF_A, V2);
    expect(companions).toEqual(new Set([V1, V3]));
  });

  it('主頂点自身は随伴集合に含まれない (二重移動の防止)', () => {
    const companions = companionVertexIdsFor(selectionOf(V1, V2), LEAF_A, V2);
    expect(companions?.has(V2)).toBe(false);
  });

  it('単一選択の頂点を掴んだだけなら随伴なし (= 従来の単一頂点移動)', () => {
    expect(companionVertexIdsFor(selectionOf(V2), LEAF_A, V2)).toBeUndefined();
  });

  it('選択に入っていない頂点を掴んだら随伴なし — 他頂点が選択中でも巻き込まない', () => {
    expect(companionVertexIdsFor(selectionOf(V1, V3), LEAF_A, V2)).toBeUndefined();
  });

  it('FR-81 一owner: 選択の所有地物と掴んだ地物が違えば随伴なし (FR-30 共有頂点で誤爆しない)', () => {
    // 選択は leaf-b が所有。leaf-a 側の同じ id (共有頂点) を掴んでも leaf-b の選択は動かない。
    const selection = replaceVertices(EMPTY_SELECTION, asFeatureId('leaf-b'), new Set([V1, V2]));
    expect(companionVertexIdsFor(selection, LEAF_A, V2)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Session: the moving set
// ---------------------------------------------------------------------------

describe('DragSession — 随伴集合の正規化と「今動いている頂点」の単一真実源', () => {
  it('beginDrag は随伴集合から主頂点を除き、空なら undefined にする', () => {
    const s = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: LEAF_A,
        vertexId: V2,
        companionVertexIds: new Set([V2]),
      },
      { lon: 10, lat: 10 },
    );
    expect(s.companionVertexIds).toBeUndefined();
    expect(s.draggedVertexId).toBe(V2);
  });

  it('beginDrag は呼び出し側の集合を防御的にコピーする (ドラッグ中に選択が変わっても崩れない)', () => {
    const live = new Set([V1, V3]);
    const s = beginDrag(
      { tool: EDIT_TOOL.VertexMove, featureId: LEAF_A, vertexId: V2, companionVertexIds: live },
      { lon: 10, lat: 10 },
    );
    live.add(V0);
    expect(s.companionVertexIds).toEqual(new Set([V1, V3]));
  });

  it('movingVertexIds = 主頂点 ∪ 随伴集合', () => {
    const s = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: LEAF_A,
        vertexId: V2,
        companionVertexIds: new Set([V1, V3]),
      },
      { lon: 10, lat: 10 },
    );
    expect(movingVertexIds(s)).toEqual(new Set([V2, V1, V3]));
  });

  it('地物移動セッションは動く頂点 id を名指ししない (従来どおり空集合)', () => {
    const s = beginDrag({ tool: EDIT_TOOL.FeatureMove, featureId: LEAF_A }, { lon: 1, lat: 1 });
    expect(movingVertexIds(s).size).toBe(0);
  });

  it('HB4-2 SCOPE: edge-add は予約 id ただ一つ — 随伴集合を持てる型ではない', () => {
    const s = beginDrag(
      {
        tool: EDIT_TOOL.EdgeAdd,
        featureId: LEAF_A,
        startVertexId: V1,
        endVertexId: V2,
        newVertexId: asVertexId('new-1'),
        ringId: RING_A,
      },
      { lon: 10, lat: 5 },
    );
    expect(movingVertexIds(s)).toEqual(new Set([asVertexId('new-1')]));
  });
});

// ---------------------------------------------------------------------------
// 3. The move math
// ---------------------------------------------------------------------------

describe('moveDraggedVertexSet — 剛体移動のベクトル', () => {
  const store = createVertexStore(squareLeaf('leaf-a', 'A国', 0, 0, 10).vertices);

  it('主頂点は目標位置へ、随伴頂点は主頂点の実変位と同じベクトルで動く', () => {
    const moved = moveDraggedVertexSet(V2, [V3], store, createCoordinate(13, 14));
    const byId = new Map(moved!.map((v) => [v.id, v.coordinate]));
    expect(byId.get(V2)).toEqual(createCoordinate(13, 14)); // (10,10) → (13,14)
    expect(byId.get(V3)).toEqual(createCoordinate(3, 14)); // (0,10) + (3,4)
  });

  it('掴みオフセットで選択がひしゃげない — ベクトルはポインタ変位ではなく主頂点の変位', () => {
    // 主頂点 (10,10) を「少しずれた位置」で掴んで (20,20) まで運ぶ。ポインタ変位を
    // 使うと随伴頂点だけ別量動いて形が崩れる。正は主頂点変位 (+10,+10)。
    const moved = moveDraggedVertexSet(V2, [V3], store, createCoordinate(20, 20));
    const byId = new Map(moved!.map((v) => [v.id, v.coordinate]));
    expect(byId.get(V3)).toEqual(createCoordinate(10, 20));
  });

  it('随伴頂点なしなら従来の単一頂点移動と同一', () => {
    const moved = moveDraggedVertexSet(V2, undefined, store, createCoordinate(13, 14));
    expect(moved).toHaveLength(1);
    expect(moved![0]!.coordinate).toEqual(createCoordinate(13, 14));
  });

  it('R3 seam: 経度は最短差で測る — 随伴頂点が地球一周ぶん飛ばない', () => {
    const seam = createVertexStore([
      createVertex(asVertexId('p'), createCoordinate(179.9, 0)),
      createVertex(asVertexId('c'), createCoordinate(179.9, 5)),
    ]);
    const moved = moveDraggedVertexSet(
      asVertexId('p'),
      [asVertexId('c')],
      seam,
      createCoordinate(-179.9, 0),
    );
    const companion = moved!.find((v) => v.id === asVertexId('c'))!;
    // 0.2° 東へ動いただけ: 179.9 + 0.2 = 180.1 (359.8° 西ではない)。
    expect(companion.coordinate.lon).toBeCloseTo(180.1, 9);
    expect(companion.coordinate.lat).toBe(5);
  });

  it('主頂点が解決できなければ部分適用せず undefined (片落とし禁止)', () => {
    expect(
      moveDraggedVertexSet(asVertexId('ghost'), [V3], store, createCoordinate(1, 1)),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. The live adapter: press → the whole set becomes one gesture
// ---------------------------------------------------------------------------

interface Harness {
  readonly port: ReturnType<typeof createEditSessionPort<DomainProject>>;
  readonly previews: (DragSession | null)[];
  readonly committed: () => DomainProject;
  readonly outcomes: unknown[];
  readonly commands: { undo: (s: DomainProject) => DomainProject; redo: (s: DomainProject) => DomainProject }[];
}

/**
 * The LIVE wiring under test, assembled exactly as App.tsx does: the U24 adapter over the
 * real U13 edit binding + the real snapshot builder, with a 1:1 screen→world transform.
 * `neighbours` lets a test inject one frame's slide/snap inputs (default: nothing near).
 */
function harness(
  initial: DomainProject,
  selection: SelectionState,
  neighbours: SlideSnapNeighbours = NO_NEIGHBOURS,
): Harness {
  let root = initial;
  const previews: (DragSession | null)[] = [];
  const outcomes: unknown[] = [];
  const commands: Harness['commands'] = [];
  const binding = createLiveEditBinding({ getRoot: () => root });
  const ctx = { getRoot: () => root, getTime: () => TIME };
  const port = createEditSessionPort<DomainProject>({
    screenToWorld: (p: ScreenPoint) => createCoordinate(p.x, p.y),
    ringIdForVertex: () => RING_A,
    vertexSelection: () => selection,
    anchorTime: () => TIME,
    currentState: () => root,
    ports: binding.ports,
    buildSnapshot: (session) => buildEditSnapshot(ctx, session),
    onReleased: (outcome) => {
      outcomes.push(outcome);
      if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
      if (outcome.result.status !== PROCESS_STATUS.Committed) return;
      const command = outcome.result.command;
      root = outcome.result.state;
      commands.push({
        undo: (s) => command.undo(s).state,
        redo: (s) => command.redo(s).state,
      });
    },
    onPreview: (session) => previews.push(session),
    worldToScreen: (world) => ({ x: world.lon, y: world.lat }),
    snapDistancePx: () => 5,
    neighboursAt: () => neighbours,
  });
  return { port, previews, committed: () => root, outcomes, commands };
}

function grab(id: ReturnType<typeof asVertexId>): HitResult {
  return vertexHit(LEAF_A, id);
}

describe('ライブ経路: 選択頂点を掴むと選択セット全体が同時に動く (FR-80)', () => {
  it('プレビューが主頂点と随伴頂点を同時に運ぶ', () => {
    const h = harness(squareProject(), selectionOf(V2, V3));
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 13, y: 14 });
    const live = h.previews.at(-1)!;
    expect(live.companionVertexIds).toEqual(new Set([V3]));

    // 描画に渡るプレビュー頂点ストア = 主頂点も随伴頂点も動いた状態。
    const store = verticesAt(squareProject(), TIME);
    const feature = squareLeaf('leaf-a', 'A国', 0, 0, 10).feature;
    const previewed = previewVertexStore(feature, store, live);
    expect(getVertex(previewed, V2)!.coordinate).toEqual(createCoordinate(13, 14));
    expect(getVertex(previewed, V3)!.coordinate).toEqual(createCoordinate(3, 14));
    // 非選択頂点は静止。
    expect(getVertex(previewed, V0)!.coordinate).toEqual(createCoordinate(0, 0));
    expect(getVertex(previewed, V1)!.coordinate).toEqual(createCoordinate(10, 0));
  });

  it('確定後のコミット結果が選択セット全体の同一ベクトル移動になる', () => {
    const h = harness(squareProject(), selectionOf(V2, V3));
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 13, y: 14 });
    h.port.release({ x: 13, y: 14 }, true);

    const after = h.committed();
    expect(coordOf(after, V2)).toEqual(createCoordinate(13, 14));
    expect(coordOf(after, V3)).toEqual(createCoordinate(3, 14));
    expect(coordOf(after, V0)).toEqual(createCoordinate(0, 0));
    expect(coordOf(after, V1)).toEqual(createCoordinate(10, 0));
  });

  it('「単一の編集操作」— 1 回のドラッグ = 1 コマンドで undo/redo が集合ごと往復する', () => {
    const before = squareProject();
    const h = harness(before, selectionOf(V2, V3));
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 13, y: 14 });
    h.port.release({ x: 13, y: 14 }, true);

    expect(h.commands).toHaveLength(1); // ← ゴースト undo なし / 頂点ごとの分割なし
    const moved = h.committed();
    const undone = h.commands[0]!.undo(moved);
    expect(coordOf(undone, V2)).toEqual(createCoordinate(10, 10));
    expect(coordOf(undone, V3)).toEqual(createCoordinate(0, 10));
    const redone = h.commands[0]!.redo(undone);
    expect(coordOf(redone, V2)).toEqual(createCoordinate(13, 14));
    expect(coordOf(redone, V3)).toEqual(createCoordinate(3, 14));
  });

  it('非退行: 選択に入っていない頂点を掴めば単一頂点移動のまま', () => {
    const h = harness(squareProject(), selectionOf(V1, V3));
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 13, y: 14 });
    h.port.release({ x: 13, y: 14 }, true);

    const after = h.committed();
    expect(coordOf(after, V2)).toEqual(createCoordinate(13, 14));
    expect(coordOf(after, V3)).toEqual(createCoordinate(0, 10)); // 静止
    expect(coordOf(after, V1)).toEqual(createCoordinate(10, 0)); // 静止
  });

  it('非退行: 選択真実源を注入しない host は従来どおり単一頂点移動 (既存呼び出しは無改変)', () => {
    let root = squareProject();
    const binding = createLiveEditBinding({ getRoot: () => root });
    const ctx = { getRoot: () => root, getTime: () => TIME };
    const port = createEditSessionPort<DomainProject>({
      screenToWorld: (p: ScreenPoint) => createCoordinate(p.x, p.y),
      anchorTime: () => TIME,
      currentState: () => root,
      ports: binding.ports,
      buildSnapshot: (session) => buildEditSnapshot(ctx, session),
      onReleased: (outcome) => {
        if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
        if (outcome.result.status !== PROCESS_STATUS.Committed) return;
        root = outcome.result.state;
      },
    });
    port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    port.update({ x: 13, y: 14 });
    port.release({ x: 13, y: 14 }, true);
    expect(coordOf(root, V2)).toEqual(createCoordinate(13, 14));
    expect(coordOf(root, V3)).toEqual(createCoordinate(0, 10));
  });

  it('クリック (wasDrag=false) は集合を動かさない — ゴースト編集なし', () => {
    const h = harness(squareProject(), selectionOf(V2, V3));
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.release({ x: 10, y: 10 }, false);
    expect(h.commands).toHaveLength(0);
    expect(coordOf(h.committed(), V3)).toEqual(createCoordinate(0, 10));
  });

  it('FR-31: 主頂点は自分の随伴頂点にはスナップしない (選択が自分自身に潰れない)', () => {
    // 随伴頂点 V3 のコミット位置 (0,10) をスナップ候補として差し込む。除外されねばならない。
    const h = harness(squareProject(), selectionOf(V2, V3), {
      edges: [],
      candidates: [],
      snapCandidates: [{ vertexId: V3, position: createCoordinate(0, 10) }],
    });
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 0, y: 10 });
    expect(h.previews.at(-1)!.snap).toBeNull();
  });

  it('FR-31 非退行: 他地物の頂点へは従来どおりスナップする', () => {
    const other = asVertexId('leaf-b-0');
    const h = harness(squareProject(), selectionOf(V2, V3), {
      edges: [],
      candidates: [],
      snapCandidates: [{ vertexId: other, position: createCoordinate(12, 12) }],
    });
    h.port.begin(grab(V2), { x: 10, y: 10 }, NO_MODIFIERS);
    h.port.update({ x: 12, y: 12 });
    expect(h.previews.at(-1)!.snap?.vertexId).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// 5. HB4-2 の自辺除外が随伴頂点にも効く / FR-28 非退行
// ---------------------------------------------------------------------------

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/**
 * 縦の共有辺をもつ A / B。`sv-bot`(10,0) と `sv-top`(10,10) は **同一 VertexId** を
 * 両地物のリングが引用する共有頂点 (FR-30)。
 *
 *   (0,10)     sv-top(10,10)     (20,10)
 *      +------------+--------------+
 *      |     A      |      B       |
 *      +------------+--------------+
 *   (0,0)      sv-bot(10,0)      (20,0)
 */
function sharedEdgeProject(): DomainProject {
  const aBl = createVertex(asVertexId('a-bl'), createCoordinate(0, 0));
  const aTl = createVertex(asVertexId('a-tl'), createCoordinate(0, 10));
  const svBot = createVertex(asVertexId('sv-bot'), createCoordinate(10, 0));
  const svTop = createVertex(asVertexId('sv-top'), createCoordinate(10, 10));
  const bBr = createVertex(asVertexId('b-br'), createCoordinate(20, 0));
  const bTr = createVertex(asVertexId('b-tr'), createCoordinate(20, 10));
  const a = createLeafFeature(
    LEAF_A,
    createBasicAttributes('A国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(RING_A, [aBl.id, svBot.id, svTop.id, aTl.id])]),
  );
  const b = createLeafFeature(
    asFeatureId('leaf-b'),
    createBasicAttributes('B国', 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId('leaf-b-r'), [svBot.id, bBr.id, bTr.id, svTop.id])]),
  );
  return {
    histories: [
      singleAnchorHistory(
        'leaf-a',
        [a, b],
        createVertexStore([aBl, aTl, svBot, svTop, bBr, bTr]),
        0,
      ),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function neighboursFor(root: DomainProject, session: DragSession, target: { lon: number; lat: number }) {
  const query = createNeighboursQuery({
    getRoot: () => root,
    getTime: () => TIME,
    snapWorldMargin: () => 8,
  });
  return query(createCoordinate(target.lon, target.lat), session);
}

/** sv-bot を掴み sv-top を随伴させた同時移動セッション (両方 B が引用 = B は連動変形)。 */
function companionSharedDrag(): DragSession {
  return beginDrag(
    {
      tool: EDIT_TOOL.VertexMove,
      featureId: LEAF_A,
      vertexId: asVertexId('sv-bot'),
      ringId: RING_A,
      companionVertexIds: new Set([asVertexId('sv-top')]),
    },
    { lon: 10, lat: 0 },
  );
}

describe('HB4-2 の「連動して動く辺は障害物でない」が随伴頂点にも効く', () => {
  it('随伴する共有頂点に接続する隣接地物の辺は衝突候補から外れる', () => {
    const neighbours = neighboursFor(sharedEdgeProject(), companionSharedDrag(), { lon: 13, lat: 3 });
    const touches = (p: { lon: number; lat: number }, q: { lon: number; lat: number }): boolean =>
      Math.abs(p.lon - q.lon) < 1e-9 && Math.abs(p.lat - q.lat) < 1e-9;
    const companionAt = { lon: 10, lat: 10 }; // sv-top のコミット位置 (= 随伴頂点)
    const incident = neighbours.edges.filter(
      (e) => touches(e.a, companionAt) || touches(e.b, companionAt),
    );
    expect(incident).toEqual([]);
  });

  it('連動変形する隣接地物の「古い輪郭」は内外判定候補にならない', () => {
    const neighbours = neighboursFor(sharedEdgeProject(), companionSharedDrag(), { lon: 13, lat: 3 });
    expect(neighbours.candidates).toEqual([]);
  });

  it('FR-28 非退行: 随伴頂点を含まない辺は依然として壁のまま', () => {
    const neighbours = neighboursFor(sharedEdgeProject(), companionSharedDrag(), { lon: 18, lat: 5 });
    // B の右辺 (20,0)-(20,10) は共有頂点を含まないので静止 = 障害物として残る。
    const farEdge = neighbours.edges.filter(
      (e) => Math.abs(e.a.lon - 20) < 1e-9 && Math.abs(e.b.lon - 20) < 1e-9,
    );
    expect(farEdge).toHaveLength(1);
  });

  it('単一頂点ドラッグの近傍集合は従来と同一 (随伴集合なしのとき非退行)', () => {
    const single = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: LEAF_A,
        vertexId: asVertexId('sv-bot'),
        ringId: RING_A,
      },
      { lon: 10, lat: 0 },
    );
    const neighbours = neighboursFor(sharedEdgeProject(), single, { lon: 13, lat: 3 });
    // sv-top は動かない ⇒ その接続辺 (b-tr→sv-top / sv-top→sv-bot のうち sv-bot を
    // 含まない側) は壁として残る。随伴版との差がここに出る。
    const touchesTop = neighbours.edges.some(
      (e) =>
        (Math.abs(e.a.lon - 10) < 1e-9 && Math.abs(e.a.lat - 10) < 1e-9) ||
        (Math.abs(e.b.lon - 10) < 1e-9 && Math.abs(e.b.lat - 10) < 1e-9),
    );
    expect(touchesTop).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// 6. FR-80 fix-forward (レビュー指摘の実バグ) — 親リング containment / 剛体フレーム /
//    プレビュー store のコピー計算量
// ---------------------------------------------------------------------------

const OUTER_RING = asRingId('holed-outer');
const HOLE_RING = asRingId('holed-hole');
const HOLED = asFeatureId('holed');
const O_BL = asVertexId('o-bl'); // (0,0)
const O_BR = asVertexId('o-br'); // (30,0)
const O_TR = asVertexId('o-tr'); // (30,30)
const O_TL = asVertexId('o-tl'); // (0,30)
const H_BL = asVertexId('h-bl'); // (10,10)
const H_BR = asVertexId('h-br'); // (20,10)
const H_TR = asVertexId('h-tr'); // (20,20)
const H_TL = asVertexId('h-tl'); // (10,20)

/**
 * 外周リング (0,0)-(30,30) に穴 (10,10)-(20,20) を空けた 1 地物だけのプロジェクト。
 * 穴頂点をドラッグすると FR-89 の親リング containment が組まれる。
 */
function holedProject(): DomainProject {
  const vs = [
    createVertex(O_BL, createCoordinate(0, 0)),
    createVertex(O_BR, createCoordinate(30, 0)),
    createVertex(O_TR, createCoordinate(30, 30)),
    createVertex(O_TL, createCoordinate(0, 30)),
    createVertex(H_BL, createCoordinate(10, 10)),
    createVertex(H_BR, createCoordinate(20, 10)),
    createVertex(H_TR, createCoordinate(20, 20)),
    createVertex(H_TL, createCoordinate(10, 20)),
  ];
  const feature = createLeafFeature(
    HOLED,
    createBasicAttributes('穴あき国', 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(OUTER_RING, [O_BL, O_BR, O_TR, O_TL]),
      createHoleRing(HOLE_RING, [H_BL, H_BR, H_TR, H_TL], OUTER_RING),
    ]),
  );
  return {
    histories: [singleAnchorHistory('holed', [feature], createVertexStore(vs), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** 穴頂点 H_BL を主頂点に、外周頂点 O_BL を随伴させた同時移動セッション。 */
function holeWithOuterCompanionDrag(): DragSession {
  return beginDrag(
    {
      tool: EDIT_TOOL.VertexMove,
      featureId: HOLED,
      vertexId: H_BL,
      ringId: HOLE_RING,
      companionVertexIds: new Set([O_BL]),
    },
    { lon: 10, lat: 10 },
  );
}

describe('FR-89 親リング containment は随伴頂点も「自分の位置＋同一デルタ」で組む', () => {
  it('親リング上の随伴頂点が主頂点のプレビューへ潰れない (退化多角形を作らない)', () => {
    // 主頂点 (10,10) → (12,13) ⇒ デルタ (+2,+3)。随伴 O_BL(0,0) は (2,3) へ。
    const neighbours = neighboursFor(holedProject(), holeWithOuterCompanionDrag(), {
      lon: 12,
      lat: 13,
    });
    const ring = neighbours.containment?.polygon[0];
    expect(ring).toBeDefined();
    expect(ring).toHaveLength(4);
    const [bl, br, tr, tl] = ring!;
    expect(bl!.lon).toBeCloseTo(2, 9);
    expect(bl!.lat).toBeCloseTo(3, 9);
    // 静止している 3 頂点はコミット位置のまま。
    expect(br).toEqual(createCoordinate(30, 0));
    expect(tr).toEqual(createCoordinate(30, 30));
    expect(tl).toEqual(createCoordinate(0, 30));
    // 退化していない: 主頂点プレビューに重なった点はゼロ個。
    const atPreview = ring!.filter(
      (p) => Math.abs(p.lon - 12) < 1e-9 && Math.abs(p.lat - 13) < 1e-9,
    );
    expect(atPreview).toEqual([]);
  });

  it('非退行: 随伴なしの単一穴頂点ドラッグでは親リングはコミット形状のまま', () => {
    const single = beginDrag(
      { tool: EDIT_TOOL.VertexMove, featureId: HOLED, vertexId: H_BL, ringId: HOLE_RING },
      { lon: 10, lat: 10 },
    );
    const neighbours = neighboursFor(holedProject(), single, { lon: 12, lat: 13 });
    expect(neighbours.containment?.polygon[0]).toEqual([
      createCoordinate(0, 0),
      createCoordinate(30, 0),
      createCoordinate(30, 30),
      createCoordinate(0, 30),
    ]);
  });

  it('非退行: 随伴頂点に接続する親リングの辺は依然として障害物から外れる (HB4-2)', () => {
    const neighbours = neighboursFor(holedProject(), holeWithOuterCompanionDrag(), {
      lon: 12,
      lat: 13,
    });
    // O_BL に接続する 2 辺 (tl→bl, bl→br) は落ち、静止辺 2 本だけが残る。
    expect(neighbours.containment?.edges).toHaveLength(2);
  });
});

describe('FR-80 剛体移動は 1 つの ±360° フレームに収まる (R3 seam)', () => {
  it('|生Δlon|>180 でも主頂点と随伴頂点が 360° 引き裂かれない', () => {
    const seam = createVertexStore([
      createVertex(asVertexId('p'), createCoordinate(179.9, 0)),
      createVertex(asVertexId('c'), createCoordinate(179.9, 5)),
    ]);
    // 生 Δlon = -359.8 (ラップレプリカを掴んだ / 画面幅超のドラッグ)。実移動は +0.2°。
    const moved = moveDraggedVertexSet(
      asVertexId('p'),
      [asVertexId('c')],
      seam,
      createCoordinate(-179.9, 0),
    );
    const primary = moved!.find((v) => v.id === asVertexId('p'))!;
    const companion = moved!.find((v) => v.id === asVertexId('c'))!;
    expect(primary.coordinate.lon).toBeCloseTo(180.1, 9);
    expect(companion.coordinate.lon).toBeCloseTo(180.1, 9);
    // 同一地物の 2 頂点が別フレームに分裂しない (bbox が 360° 幅に退化しない)。
    expect(Math.abs(primary.coordinate.lon - companion.coordinate.lon)).toBeLessThan(1e-9);
  });

  it('非退行: |Δlon|≤180 の通常ドラッグでは主頂点は目標座標そのもの (スナップ位置が ULP もずれない)', () => {
    const store = createVertexStore(squareLeaf('leaf-a', 'A国', 0, 0, 10).vertices);
    const target = createCoordinate(13.123456789, 14.987654321);
    const moved = moveDraggedVertexSet(V2, [V3], store, target);
    expect(moved![0]!.coordinate.lon).toBe(target.lon);
    expect(moved![0]!.coordinate.lat).toBe(target.lat);
  });

  it('非退行: 随伴なしの単一頂点移動も同じ規則 (規則は 1 つ)', () => {
    const seam = createVertexStore([createVertex(asVertexId('p'), createCoordinate(179.9, 0))]);
    const moved = moveDraggedVertexSet(
      asVertexId('p'),
      undefined,
      seam,
      createCoordinate(-179.9, 0),
    );
    expect(moved![0]!.coordinate.lon).toBeCloseTo(180.1, 9);
  });
});

describe('previewVertexStore は選択頂点数によらずストアを 1 回だけ複製する', () => {
  it('複数頂点プレビューでも入力ストアは不変で、結果は全頂点が同一ベクトル移動', () => {
    const root = squareProject();
    const store = verticesAt(root, TIME);
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: LEAF_A,
        vertexId: V2,
        ringId: RING_A,
        companionVertexIds: new Set([V3, V0]),
      },
      { lon: 10, lat: 10 },
    );
    const { feature } = squareLeaf('leaf-a', 'A国', 0, 0, 10);
    const next = previewVertexStore(feature, store, {
      ...session,
      preview: createCoordinate(13, 14),
    });
    expect(getVertex(next, V2)!.coordinate).toEqual(createCoordinate(13, 14));
    expect(getVertex(next, V3)!.coordinate).toEqual(createCoordinate(3, 14));
    expect(getVertex(next, V0)!.coordinate).toEqual(createCoordinate(3, 4));
    // 入力は一切変わらない (教訓 5.17/5.22)。
    expect(getVertex(store, V2)!.coordinate).toEqual(createCoordinate(10, 10));
  });

  it('計算量ガード: 大きなストア × 多数の随伴頂点でも O(選択数 × 全頂点数) にならない', () => {
    // 旧実装は setVertex を頂点ごとに呼び、そのたびに Map 全体を複製していた
    // (500 × 20,000 = 1,000 万 entry / フレーム)。1 回複製なら 2 万 entry。
    const N = 20000;
    const M = 500;
    const vertices = [];
    for (let i = 0; i < N; i += 1) {
      vertices.push(createVertex(asVertexId(`bulk-${i}`), createCoordinate(i * 0.001, 0)));
    }
    const store = createVertexStore(vertices);
    const companions = new Set<ReturnType<typeof asVertexId>>();
    for (let i = 1; i <= M; i += 1) companions.add(asVertexId(`bulk-${i}`));
    const feature = createLeafFeature(
      asFeatureId('bulk'),
      createBasicAttributes('bulk', 0, 100),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('bulk-r'), [
          asVertexId('bulk-0'),
          asVertexId('bulk-1'),
          asVertexId('bulk-2'),
        ]),
      ]),
    );
    const session = beginDrag(
      {
        tool: EDIT_TOOL.VertexMove,
        featureId: asFeatureId('bulk'),
        vertexId: asVertexId('bulk-0'),
        ringId: asRingId('bulk-r'),
        companionVertexIds: companions,
      },
      { lon: 0, lat: 0 },
    );
    const started = performance.now();
    const next = previewVertexStore(feature, store, {
      ...session,
      preview: createCoordinate(0, 1),
    });
    const elapsed = performance.now() - started;
    expect(getVertex(next, asVertexId('bulk-0'))!.coordinate).toEqual(createCoordinate(0, 1));
    expect(getVertex(next, asVertexId('bulk-500'))!.coordinate.lat).toBe(1);
    // 1 回複製なら 1 桁 ms。旧 O(N×M) は秒オーダー。閾値は 10 倍以上の余裕をとる。
    expect(elapsed).toBeLessThan(300);
  });
});
