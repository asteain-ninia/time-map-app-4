// 増分 8A — 頂点の候補一覧の中身（設計書 §B.5 の台帳 #12 / §E.1 V9 / 現状.md B42）。
//
// 固定すること:
//   - 1 行の書式「頂点 #412（34.10°N 12.51°E・アルラーク国と共有）」と、主になる地物の選び方
//     （いま選んでいる地物が引いていればそれ。選んだ瞬間に選択が隣の国へ替わらない）。
//   - 共有の相手は「最初の持ち主」だけでなく **引いている地物の全部**から出る（B42）。
//   - 一覧は **動かさずに離したとき**だけ出て、ドラッグでは出ない。押すたびに畳む。
//   - 一覧から選んだ頂点は、掴める距離の中なら最寄りより優先して掴まれる。
//   - 世界・年・道具・表示・カメラが替わったら畳む（選択の変化では畳まない）。

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
  squareLeaf,
} from '../../domain/persistence/fixtures';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { EMPTY_HIT, edgeHit, vertexHit } from '../../domain/selection';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import type { DisplayControlInput } from '../../render/display-pipeline';

import { clearDisplayResolutionCache, resolveDisplayFor } from './display-resolution-cache';
import type { NearVertexCandidate } from './live-hit-test';
import {
  VERTEX_CANDIDATE_MAX_ROWS,
  VertexCandidateStore,
  buildCandidateRow,
  buildCandidateState,
  createVertexCandidateGesture,
  describeNearVertices,
  formatCandidateCoordinate,
  preferSelectedVertex,
  vertexCitersFor,
  vertexNumberOf,
  watchCandidateStaleness,
  type DescribedVertexCandidate,
} from './vertex-candidates';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

afterEach(() => {
  clearDisplayResolutionCache();
});

/** A 国（正方形）と、A の右下の角 `A-1` を共有する B 国（三角形）。 */
function sharedProject(): DomainProject {
  const a = squareLeaf('A', 'A国', 0, 0, 10);
  const shared = a.vertices[1]!; // (10, 0)
  const b1 = createVertex(asVertexId('B-1'), createCoordinate(20, 0));
  const b2 = createVertex(asVertexId('B-2'), createCoordinate(15, -10));
  const b = createLeafFeature(
    asFeatureId('B'),
    createBasicAttributes('B国', 0, 100),
    createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
    createShape([createTerritoryRing(asRingId('B-r'), [shared.id, b1.id, b2.id])]),
  );
  return {
    histories: [
      singleAnchorHistory('A', [a.feature], createVertexStore(a.vertices), 0),
      singleAnchorHistory('B', [b], createVertexStore([shared, b1, b2]), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

const NAMES: Record<string, string> = { A: 'A国', B: 'B国' };
const nameOf = (id: FeatureId): string => NAMES[id] ?? '';

describe('1 行の書式', () => {
  it('実データの頂点 id（v412）は数字だけを出し、形の違う id はそのまま出す', () => {
    expect(vertexNumberOf(asVertexId('v412'))).toBe('412');
    expect(vertexNumberOf(asVertexId('syn-0001-v0'))).toBe('syn-0001-v0');
  });

  it('座標は「34.10°N 12.51°E」の形（南・西も、経度の畳みも）', () => {
    expect(formatCandidateCoordinate(createCoordinate(12.514, 34.1))).toBe('34.10°N 12.51°E');
    expect(formatCandidateCoordinate({ lon: -3.5, lat: -20.004 })).toBe('20.00°S 3.50°W');
    // 連続経度（+360 の複製）は畳んでから出す。
    expect(formatCandidateCoordinate({ lon: 370, lat: 0 })).toBe('0.00°N 10.00°E');
  });

  it('共有頂点は「…と共有」と書き、主はいま選んでいる地物になる', () => {
    const c: DescribedVertexCandidate = {
      featureId: asFeatureId('B'), // 当たり判定の「最初の持ち主」が隣の国だった場合
      vertexId: asVertexId('v412'),
      distancePx: 1.5,
      coordinate: createCoordinate(12.51, 34.1),
      citers: [asFeatureId('B'), asFeatureId('A')],
    };
    const row = buildCandidateRow(c, asFeatureId('A'), nameOf);
    expect(row.label).toBe('頂点 #412（34.10°N 12.51°E・B国と共有）');
    // 選んだ瞬間に選択が隣の国へ替わらない。
    expect(row.featureId).toBe('A');
  });

  it('いま選んでいる地物が引いていない頂点は、持ち主の名前を書く', () => {
    const c: DescribedVertexCandidate = {
      featureId: asFeatureId('B'),
      vertexId: asVertexId('v7'),
      distancePx: 2,
      coordinate: createCoordinate(1, 2),
      citers: [asFeatureId('B')],
    };
    expect(buildCandidateRow(c, asFeatureId('A'), nameOf).label).toBe(
      '頂点 #7（2.00°N 1.00°E・B国）',
    );
    expect(buildCandidateRow(c, null, nameOf).featureId).toBe('B');
  });

  it('共有の相手が多ければ 2 つまで名前を出し、残りは件数にする', () => {
    const c: DescribedVertexCandidate = {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v1'),
      distancePx: 0,
      coordinate: createCoordinate(0, 0),
      citers: ['A', 'B', 'C', 'D'].map(asFeatureId),
    };
    const names = (id: FeatureId): string => `${id}国`;
    expect(buildCandidateRow(c, asFeatureId('A'), names).label).toBe(
      '頂点 #1（0.00°N 0.00°E・B国・C国 ほか 1 件と共有）',
    );
  });

  it('名前の無い地物は「（名前なし）」と書く（内部 id は見せない）', () => {
    const c: DescribedVertexCandidate = {
      featureId: asFeatureId('Z'),
      vertexId: asVertexId('v1'),
      distancePx: 0,
      coordinate: createCoordinate(0, 0),
      citers: [asFeatureId('Z')],
    };
    expect(buildCandidateRow(c, null, () => '').label).toBe('頂点 #1（0.00°N 0.00°E・（名前なし））');
  });
});

describe('引いている地物の全部（現状.md B42）', () => {
  it('共有頂点は 2 つの地物から引かれていると分かる（最初の持ち主だけではない）', () => {
    const root = sharedProject();
    const resolution = resolveDisplayFor(root, timePointYear(10), DISPLAY);
    const citers = vertexCitersFor(resolution);
    expect([...(citers.get(asVertexId('A-1')) ?? [])].sort()).toEqual(['A', 'B']);
    expect(citers.get(asVertexId('A-0'))).toEqual(['A']);
    // 束ごとに 1 回だけ作る（同じ束なら同じ表）。
    expect(vertexCitersFor(resolution)).toBe(citers);
  });

  it('候補に座標と持ち主の全部を足し、引けない頂点は落とす', () => {
    const root = sharedProject();
    const resolution = resolveDisplayFor(root, timePointYear(10), DISPLAY);
    const near: NearVertexCandidate[] = [
      { featureId: asFeatureId('A'), vertexId: asVertexId('A-1'), distancePx: 0.5 },
      { featureId: asFeatureId('A'), vertexId: asVertexId('no-such'), distancePx: 1 },
    ];
    const out = describeNearVertices(resolution, near);
    expect(out).toHaveLength(1);
    expect(out[0]!.coordinate).toEqual(createCoordinate(10, 0));
    expect([...out[0]!.citers].sort()).toEqual(['A', 'B']);
  });
});

describe('一覧の状態', () => {
  const cand = (i: number): DescribedVertexCandidate => ({
    featureId: asFeatureId('A'),
    vertexId: asVertexId(`v${String(i)}`),
    distancePx: i / 10,
    coordinate: createCoordinate(i, 0),
    citers: [asFeatureId('A')],
  });

  it('候補が 1 つなら一覧を出さない', () => {
    expect(buildCandidateState({ x: 0, y: 0 }, [cand(1)], null, nameOf)).toBeNull();
  });

  it('多すぎる候補は近い順に上限で畳み、残りの件数を持つ', () => {
    const many = Array.from({ length: VERTEX_CANDIDATE_MAX_ROWS + 5 }, (_, i) => cand(i));
    const state = buildCandidateState({ x: 3, y: 4 }, many, null, nameOf)!;
    expect(state.rows).toHaveLength(VERTEX_CANDIDATE_MAX_ROWS);
    expect(state.more).toBe(5);
    expect(state.rows[0]!.vertexId).toBe('v0');
    expect({ x: state.x, y: state.y }).toEqual({ x: 3, y: 4 });
  });
});

describe('選んだ頂点を優先して掴む', () => {
  const near: NearVertexCandidate[] = [
    { featureId: asFeatureId('A'), vertexId: asVertexId('v1'), distancePx: 0.5 },
    { featureId: asFeatureId('A'), vertexId: asVertexId('v2'), distancePx: 1.5 },
  ];

  it('掴める距離に選んでいる頂点が居れば、最寄りよりそちらを掴む', () => {
    const hit = vertexHit(asFeatureId('A'), asVertexId('v1'));
    const out = preferSelectedVertex(
      hit,
      { vertexIds: new Set([asVertexId('v2')]), vertexOwner: asFeatureId('A') },
      () => near,
    );
    expect(out).toEqual(vertexHit(asFeatureId('A'), asVertexId('v2')));
  });

  it('選んでいなければ・選んだ頂点が遠ければ素通し（近さを引き直さない）', () => {
    const hit = vertexHit(asFeatureId('A'), asVertexId('v1'));
    const probe = vi.fn(() => near);
    expect(
      preferSelectedVertex(hit, { vertexIds: new Set(), vertexOwner: null }, probe),
    ).toBe(hit);
    expect(probe).not.toHaveBeenCalled();
    expect(
      preferSelectedVertex(
        hit,
        { vertexIds: new Set([asVertexId('v9')]), vertexOwner: asFeatureId('A') },
        probe,
      ),
    ).toBe(hit);
  });

  it('頂点でない当たり（本体・辺・空）は変えない', () => {
    const sel = { vertexIds: new Set([asVertexId('v2')]), vertexOwner: asFeatureId('A') };
    expect(preferSelectedVertex(EMPTY_HIT, sel, () => near)).toBe(EMPTY_HIT);
    const edge = edgeHit(asFeatureId('A'), asVertexId('v1'), asVertexId('v2'));
    expect(preferSelectedVertex(edge, sel, () => near)).toBe(edge);
  });
});

describe('クリックのときだけ出す', () => {
  const two: DescribedVertexCandidate[] = [
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v1'),
      distancePx: 0.5,
      coordinate: createCoordinate(0, 0),
      citers: [asFeatureId('A')],
    },
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v2'),
      distancePx: 1,
      coordinate: createCoordinate(0.01, 0),
      citers: [asFeatureId('A')],
    },
  ];
  function setup(found: readonly DescribedVertexCandidate[] = two) {
    const store = new VertexCandidateStore();
    const gesture = createVertexCandidateGesture({
      store,
      probe: () => found,
      activeFeature: () => asFeatureId('A'),
      nameOf,
    });
    return { store, gesture };
  }

  it('押して動かさずに離したら出る（押した瞬間には出ない）', () => {
    const { store, gesture } = setup();
    gesture.press({ x: 10, y: 10 }, true);
    expect(store.get()).toBeNull();
    gesture.release({ x: 11, y: 10 });
    expect(store.get()?.rows.map((r) => r.vertexId)).toEqual(['v1', 'v2']);
  });

  it('ドラッグ（しきい値を越えて動かした）なら出ない', () => {
    const { store, gesture } = setup();
    gesture.press({ x: 10, y: 10 }, true);
    gesture.move({ x: 30, y: 10 });
    gesture.release({ x: 10, y: 10 }); // 戻ってきて離しても、一度ドラッグになったら出さない
    expect(store.get()).toBeNull();
  });

  it('押すたびに畳む（地図の他所のクリックで必ず消える）・右ボタンでは出さない', () => {
    const { store, gesture } = setup();
    gesture.press({ x: 10, y: 10 }, true);
    gesture.release({ x: 10, y: 10 });
    expect(store.get()).not.toBeNull();
    gesture.press({ x: 200, y: 200 }, false);
    expect(store.get()).toBeNull();
    gesture.release({ x: 200, y: 200 });
    expect(store.get()).toBeNull();
  });

  it('取り消しは出ている一覧も保留中の候補も捨てる', () => {
    const { store, gesture } = setup();
    gesture.press({ x: 10, y: 10 }, true);
    gesture.cancel();
    gesture.release({ x: 10, y: 10 });
    expect(store.get()).toBeNull();
  });
});

describe('状態が移ったら畳む', () => {
  function fakeStore() {
    let state = {
      domain: {},
      currentTime: {},
      mode: 'edit',
      activeTool: 'edit.vertex',
      displayControl: {},
      filter: {},
      camera: {},
      selection: {},
    };
    const listeners = new Set<(s: typeof state) => void>();
    return {
      getState: () => state,
      subscribe: (l: (s: typeof state) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set(patch: Partial<typeof state>) {
        state = { ...state, ...patch };
        for (const l of listeners) l(state);
      },
    };
  }

  it('世界・年・道具・表示・カメラのどれが替わっても呼ぶ。選択の変化では呼ばない', () => {
    const store = fakeStore();
    const onStale = vi.fn();
    const stop = watchCandidateStaleness(store, onStale);
    store.set({ selection: {} });
    expect(onStale).not.toHaveBeenCalled();
    for (const key of ['domain', 'currentTime', 'activeTool', 'displayControl', 'filter', 'camera'] as const) {
      store.set({ [key]: {} });
    }
    store.set({ mode: 'view' });
    expect(onStale).toHaveBeenCalledTimes(7);
    stop();
    store.set({ domain: {} });
    expect(onStale).toHaveBeenCalledTimes(7);
  });
});
