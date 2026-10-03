// 増分 8A の手直し（反証 重 2）: 辺に頂点を足した編集は、その辺を共有するすべての地物に
// 同じ頂点を入れる（`applyEditProposal` の `edgeInsert`）。押した地物にだけ入ると T 字になり、
// あとでその頂点を動かすと隣との間に隙間ができる。
//
// 並べ方は分割の「共有辺の途中を切る」（FR-95）と同じ 1 本（`insertSeamsIntoFeature`）。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createEditProposal } from '../consistency/types';
import { createCoordinate } from '../coordinate';
import {
  FEATURE_KIND,
  createLeafFeature,
  createLineFeature,
  type Feature,
} from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId, type VertexId } from '../ids';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../persistence/fixtures';
import type { DomainProject, FeatureHistory } from '../persistence/index';
import { createHoleRing, createShape, createTerritoryRing } from '../ring';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../vertex';
import { applyEditProposal } from './apply-proposal';
import type { FeatureSnapshot } from './edit-flow';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);
const T0 = timePointYear(0);
const vid = (s: string): VertexId => asVertexId(s);
const v = (id: string, lon: number, lat: number): Vertex =>
  createVertex(vid(id), createCoordinate(lon, lat));

const leaf = (id: string, ringIds: readonly string[], holes: readonly string[][] = []): Feature =>
  createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`${id}国`, 0, 100),
    COLOR,
    createShape([
      createTerritoryRing(asRingId(`${id}-r`), ringIds.map(vid)),
      ...holes.map((h, i) => createHoleRing(asRingId(`${id}-h${String(i)}`), h.map(vid), asRingId(`${id}-r`))),
    ]),
  );

// A=(0,0)-(10,10)、B=(10,0)-(20,10)。共有辺は s1(10,0)–s2(10,10)。B の輪では s2→s1 が
// 閉じる辺（最後 → 最初）になるので、閉じる辺の一致も一緒に見る。
const S1 = v('s1', 10, 0);
const S2 = v('s2', 10, 10);
const A_V = [v('a0', 0, 0), S1, S2, v('a3', 0, 10)];
const B_V = [S1, v('b1', 20, 0), v('b2', 20, 10), S2];
const A = leaf('A', ['a0', 's1', 's2', 'a3']);
const B = leaf('B', ['s1', 'b1', 'b2', 's2']);
const NEW = v('new-1', 10, 5);
const A_AFTER = leaf('A', ['a0', 's1', 'new-1', 's2', 'a3']);

const project = (histories: FeatureHistory[]): DomainProject => ({
  histories,
  settings: DEFAULT_SETTINGS,
  baseMap: DEFAULT_BASEMAP,
});

const twoHistories = (): DomainProject =>
  project([
    singleAnchorHistory('A', [A], createVertexStore(A_V), 0),
    singleAnchorHistory('B', [B], createVertexStore(B_V), 0),
  ]);

const edgeAddSnapshot = (extra: Partial<FeatureSnapshot> = {}): FeatureSnapshot => ({
  feature: A_AFTER,
  vertices: [NEW],
  edgeInsert: { startVertexId: vid('s1'), endVertexId: vid('s2'), vertexId: vid('new-1') },
  ...extra,
});

/** その時刻の写しから地物を引く（どの履歴に居てもよい）。 */
function featureAt(root: DomainProject, id: string, year = 0): Feature | undefined {
  for (const h of root.histories) {
    const r = resolveAt(h.series, timePointYear(year), CAL);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === asFeatureId(id));
    if (f !== undefined) return f;
  }
  return undefined;
}

function idsOf(f: Feature | undefined): string[][] {
  if (f === undefined) return [];
  if (f.kind === FEATURE_KIND.Leaf) return f.shape.rings.map((r) => r.vertexIds.map(String));
  if (f.kind === FEATURE_KIND.Line) return [f.vertexIds.map(String)];
  return [];
}

function storeOf(root: DomainProject, historyId: string, year = 0) {
  const h = root.histories.find((x) => x.featureId === asFeatureId(historyId))!;
  const r = resolveAt(h.series, timePointYear(year), CAL);
  if (r.kind !== 'present') throw new Error('no snapshot');
  return r.entry.anchor.snapshot.vertices;
}

describe('applyEditProposal — 辺に足した頂点を、その辺を共有する地物にも入れる', () => {
  it('別の履歴に居る隣（閉じる辺で共有）にも同じ id が入り、体も届く', () => {
    const after = applyEditProposal(
      twoHistories(),
      createEditProposal(asFeatureId('A'), T0, edgeAddSnapshot()),
      CAL,
    );
    expect(idsOf(featureAt(after, 'A'))).toEqual([['a0', 's1', 'new-1', 's2', 'a3']]);
    // B の輪は s1, b1, b2, s2 で、s2 → s1 が閉じる辺。その間（最後）に入る。
    expect(idsOf(featureAt(after, 'B'))).toEqual([['s1', 'b1', 'b2', 's2', 'new-1']]);
    expect(getVertex(storeOf(after, 'B'), vid('new-1'))?.coordinate).toEqual(
      createCoordinate(10, 5),
    );
  });

  it('同じ錨の写しの中の兄弟（まとめ役の子どうし）にも入る', () => {
    const root = project([
      singleAnchorHistory('G', [A, B], createVertexStore([...A_V, ...B_V]), 0),
    ]);
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('A'), T0, edgeAddSnapshot()),
      CAL,
    );
    expect(idsOf(featureAt(after, 'A'))).toEqual([['a0', 's1', 'new-1', 's2', 'a3']]);
    expect(idsOf(featureAt(after, 'B'))).toEqual([['s1', 'b1', 'b2', 's2', 'new-1']]);
  });

  it('飛び地の輪の辺に足すと、親の穴の輪（逆向きに引いている）にも入る', () => {
    // 親 P は大きな四角に穴を持ち、穴は飛び地 E の輪を逆向きに引いている。
    const pV = [v('p0', -50, -50), v('p1', 50, -50), v('p2', 50, 50), v('p3', -50, 50)];
    const eV = [v('e0', 0, 0), v('e1', 10, 0), v('e2', 10, 10), v('e3', 0, 10)];
    const P = leaf('P', ['p0', 'p1', 'p2', 'p3'], [['e3', 'e2', 'e1', 'e0']]);
    const E = leaf('E', ['e0', 'e1', 'e2', 'e3']);
    const root = project([
      singleAnchorHistory('P', [P], createVertexStore([...pV, ...eV]), 0),
      singleAnchorHistory('E', [E], createVertexStore(eV), 0),
    ]);
    const n = v('n', 5, 0);
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('E'), T0, {
        feature: leaf('E', ['e0', 'n', 'e1', 'e2', 'e3']),
        vertices: [n],
        edgeInsert: { startVertexId: vid('e0'), endVertexId: vid('e1'), vertexId: vid('n') },
      }),
      CAL,
    );
    expect(idsOf(featureAt(after, 'P'))).toEqual([
      ['p0', 'p1', 'p2', 'p3'],
      ['e3', 'e2', 'e1', 'n', 'e0'],
    ]);
  });

  it('その辺を引いている線にも入る（線は閉じる辺を持たない）', () => {
    const L = createLineFeature(asFeatureId('L'), createBasicAttributes('川', 0, 100), COLOR, [
      vid('s1'),
      vid('s2'),
    ]);
    const root = project([
      singleAnchorHistory('A', [A], createVertexStore(A_V), 0),
      singleAnchorHistory('L', [L], createVertexStore([S1, S2]), 0),
    ]);
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('A'), T0, edgeAddSnapshot()),
      CAL,
    );
    expect(idsOf(featureAt(after, 'L'))).toEqual([['s1', 'new-1', 's2']]);
  });

  it('辺を共有していない地物の履歴は同じ値のまま（触らない）', () => {
    const C = leaf('C', ['c0', 'c1', 'c2']);
    const cV = [v('c0', 50, 50), v('c1', 60, 50), v('c2', 60, 60)];
    const root = project([
      singleAnchorHistory('A', [A], createVertexStore(A_V), 0),
      singleAnchorHistory('C', [C], createVertexStore(cV), 0),
    ]);
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('A'), T0, edgeAddSnapshot()),
      CAL,
    );
    expect(after.histories[1]).toBe(root.histories[1]);
  });

  it('隣が後ろの年に錨を持っていても、そこには入れない（押した地物の後ろにも無いので揃う）', () => {
    const later = createAnchor(
      asAnchorId('B-50'),
      createAnchorSnapshot([B], createVertexStore(B_V)),
    );
    const early = createAnchor(asAnchorId('B-0'), createAnchorSnapshot([B], createVertexStore(B_V)));
    const bHistory: FeatureHistory = {
      featureId: asFeatureId('B'),
      series: normalizeSeries(
        [createAnchorEntry(early, T0, timePointYear(50)), createAnchorEntry(later, timePointYear(50), null)],
        CAL,
      ),
    };
    const root = project([singleAnchorHistory('A', [A], createVertexStore(A_V), 0), bHistory]);
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('A'), T0, edgeAddSnapshot()),
      CAL,
    );
    expect(idsOf(featureAt(after, 'B', 0))).toEqual([['s1', 'b1', 'b2', 's2', 'new-1']]);
    expect(idsOf(featureAt(after, 'B', 60))).toEqual([['s1', 'b1', 'b2', 's2']]);
  });

  it('確定で吸着が共有に変わったときは、隣にも共有先の id を入れる（同じ座標に別 id を作らない）', () => {
    // 足した頂点を、どの地物も引いていない独立の点 t に吸着させて離した、と見立てる。
    const t = v('t', 10, 5);
    const root = project([
      singleAnchorHistory('A', [A], createVertexStore(A_V), 0),
      singleAnchorHistory('B', [B], createVertexStore(B_V), 0),
      singleAnchorHistory('T', [], createVertexStore([t]), 0),
    ]);
    const after = applyEditProposal(
      root,
      createEditProposal(
        asFeatureId('A'),
        T0,
        edgeAddSnapshot({ sharePair: { dragged: vid('new-1'), target: vid('t') } }),
      ),
      CAL,
    );
    expect(idsOf(featureAt(after, 'A'))).toEqual([['a0', 's1', 't', 's2', 'a3']]);
    expect(idsOf(featureAt(after, 'B'))).toEqual([['s1', 'b1', 'b2', 's2', 't']]);
    expect(idsOf(featureAt(after, 'B')).flat()).not.toContain('new-1');
  });

  it('共有先の id を隣が既にどこかで引いているなら、隣には入れない（同じ頂点を 2 度引かせない）', () => {
    // B が t を別の所で既に引いている。
    const t = v('t', 10, 5);
    const root = project([
      singleAnchorHistory('A', [A], createVertexStore(A_V), 0),
      singleAnchorHistory('B', [leaf('B', ['s1', 'b1', 't', 'b2', 's2'])], createVertexStore([...B_V, t]), 0),
    ]);
    const after = applyEditProposal(
      root,
      createEditProposal(
        asFeatureId('A'),
        T0,
        edgeAddSnapshot({ sharePair: { dragged: vid('new-1'), target: vid('t') } }),
      ),
      CAL,
    );
    expect(idsOf(featureAt(after, 'B'))).toEqual([['s1', 'b1', 't', 'b2', 's2']]);
  });

  it('edgeInsert が無い編集（頂点の移動など）では隣に何も足さない', () => {
    const root = twoHistories();
    const after = applyEditProposal(
      root,
      createEditProposal(asFeatureId('A'), T0, { feature: A, vertices: [v('a0', 1, 1)] }),
      CAL,
    );
    expect(idsOf(featureAt(after, 'B'))).toEqual([['s1', 'b1', 'b2', 's2']]);
  });
});
