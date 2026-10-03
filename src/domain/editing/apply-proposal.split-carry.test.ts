// 統合 8A〜8D の継ぎ目の検証 2-2・2-3 の手直し: 分割が隣との境目に T 字を残さない。
//
// 2-2: 分割の集合演算は一直線上に並ぶ途中の頂点を落とす。その頂点を隣も引いていると、隣にだけ
//      残って片の辺の途中に乗る T 字になる（水平・垂直の共有辺の中点に頂点を足す ―― 増分 8A ――
//      と普通の手順で作れる）。`executeSplit` が元の頂点を片の辺の上へ戻し、旧→新の対応で隣も
//      同じ id を引く。
// 2-3: 分割の切り口と共有頂点の付け替えは、分けた年の錨にしか入っていなかった。隣が後ろの年に
//      錨を持つと、そこで T 字が残り、id での共有も切れた。辺に足した頂点（増分 8A）と同じ歩き方で
//      後ろの錨へも入れる（継承先の次の錨の手前まで）。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { FEATURE_KIND, createLeafFeature, type LeafFeature } from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { freshIdPorts } from '../knife/fixtures';
import { createOpenKnifeLine } from '../knife/knife-line';
import {
  assembleSplitProposal,
  createInheritanceChoiceAt,
  toEditProposal,
} from '../knife/proposal';
import {
  SPLIT_CHECK_STATUS,
  checkSplittable,
  executeSplit,
  largestPieceIndex,
} from '../knife/split-geometry';
import { CAL, DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../persistence/fixtures';
import type { DomainProject, FeatureHistory } from '../persistence/index';
import { createShape, createTerritoryRing } from '../ring';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, getVertex, type Vertex, type VertexStore } from '../vertex';
import { applySplitProposal } from './apply-proposal';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const v = (id: string, lon: number, lat: number): Vertex => createVertex(asVertexId(id), c(lon, lat));

const leaf = (id: string, ids: readonly string[]): LeafFeature =>
  createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`${id}国`, 0, 3000),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r`), ids.map((x) => asVertexId(x)))]),
  );

/** `[開始の年, 地物, 頂点]` を古い順に並べた履歴（終わりは次の錨の開始）。 */
function history(
  id: string,
  anchors: readonly (readonly [number, readonly LeafFeature[], readonly Vertex[]])[],
): FeatureHistory {
  return {
    featureId: asFeatureId(id),
    series: normalizeSeries(
      anchors.map(([year, features, vertices], i) =>
        createAnchorEntry(
          createAnchor(
            asAnchorId(`${id}-${String(year)}`),
            createAnchorSnapshot(features, createVertexStore(vertices)),
          ),
          timePointYear(year),
          i + 1 < anchors.length ? timePointYear(anchors[i + 1]![0]) : null,
        ),
      ),
      CAL,
    ),
  };
}

const project = (histories: FeatureHistory[]): DomainProject => ({
  histories,
  settings: DEFAULT_SETTINGS,
  baseMap: DEFAULT_BASEMAP,
});

interface Placed {
  readonly feature: LeafFeature;
  readonly store: VertexStore;
}

/** その年に効いている末端と、それぞれの履歴の頂点表。 */
function leavesAt(root: DomainProject, year: number): Placed[] {
  const out: Placed[] = [];
  for (const h of root.histories) {
    const r = resolveAt(h.series, timePointYear(year), CAL);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) {
      if (f.kind === FEATURE_KIND.Leaf) out.push({ feature: f, store: r.entry.anchor.snapshot.vertices });
    }
  }
  return out;
}

function placed(root: DomainProject, id: string, year: number): Placed {
  const p = leavesAt(root, year).find((x) => x.feature.id === asFeatureId(id));
  if (p === undefined) throw new Error(`${id} は ${String(year)} 年に居ない`);
  return p;
}

function ringCoords(p: Placed): { id: string; at: WorldCoordinate }[][] {
  return p.feature.shape.rings.map((ring) =>
    ring.vertexIds.map((id) => {
      const body = getVertex(p.store, id);
      if (body === undefined) throw new Error(`体の無い頂点 ${String(id)}（${String(p.feature.id)}）`);
      return { id: String(id), at: body.coordinate };
    }),
  );
}

/** 地物の組ごとに、片方の頂点が相手の辺の途中に乗っている所（T 字）を挙げる。 */
function tJunctions(root: DomainProject, year: number): string[] {
  const ls = leavesAt(root, year);
  const out: string[] = [];
  for (const pa of ls) {
    for (const pb of ls) {
      if (pa === pb) continue;
      for (const ra of ringCoords(pa)) {
        for (const rb of ringCoords(pb)) {
          for (const q of ra) {
            if (rb.some((x) => x.at.lon === q.at.lon && x.at.lat === q.at.lat)) continue;
            for (let i = 0; i < rb.length; i += 1) {
              const s = rb[i]!.at;
              const e = rb[(i + 1) % rb.length]!.at;
              const dx = e.lon - s.lon;
              const dy = e.lat - s.lat;
              const len2 = dx * dx + dy * dy;
              if (len2 === 0) continue;
              const t = ((q.at.lon - s.lon) * dx + (q.at.lat - s.lat) * dy) / len2;
              if (t <= 0 || t >= 1) continue;
              if (Math.hypot(s.lon + dx * t - q.at.lon, s.lat + dy * t - q.at.lat) < 1e-9) {
                out.push(`${String(pa.feature.id)} の ${q.id} が ${String(pb.feature.id)} の辺 ${rb[i]!.id}–${rb[(i + 1) % rb.length]!.id} の途中`);
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** 同じ座標の頂点を、地物ごとに別の id で引いている所（id での共有が切れている所）を挙げる。 */
function idSplits(root: DomainProject, year: number): string[] {
  const byCoord = new Map<string, Set<string>>();
  for (const p of leavesAt(root, year)) {
    for (const ring of ringCoords(p)) {
      for (const { id, at } of ring) {
        const key = `${String(at.lon)},${String(at.lat)}`;
        let ids = byCoord.get(key);
        if (ids === undefined) {
          ids = new Set();
          byCoord.set(key, ids);
        }
        ids.add(id);
      }
    }
  }
  return [...byCoord].filter(([, ids]) => ids.size > 1).map(([k, ids]) => `${k}: ${[...ids].join(' / ')}`);
}

/** その年の座標 p の頂点の id（地物 `id` の輪から引く。無ければ undefined）。 */
function idAt(root: DomainProject, id: string, year: number, p: WorldCoordinate): string | undefined {
  for (const ring of ringCoords(placed(root, id, year))) {
    const hit = ring.find((x) => x.at.lon === p.lon && x.at.lat === p.lat);
    if (hit !== undefined) return hit.id;
  }
  return undefined;
}

/** 地物 `targetId` を `year` 年に線 `line` で分ける（いちばん大きい片が元の地物を継ぐ）。 */
function splitAt(root: DomainProject, targetId: string, year: number, line: readonly WorldCoordinate[]) {
  const { feature, store } = placed(root, targetId, year);
  const result = executeSplit(feature, store, createOpenKnifeLine([...line]));
  if (result === undefined) throw new Error('分けられない線');
  const proposal = assembleSplitProposal({
    target: feature,
    store: store.byId,
    result,
    choice: createInheritanceChoiceAt(largestPieceIndex(result)),
    nonInherited: { attributes: createBasicAttributes('新しい片', year, 3000), color: COLOR },
    ids: freshIdPorts(),
  });
  return applySplitProposal(root, toEditProposal(proposal, timePointYear(year)), CAL);
}

// A=(0,0)-(10,10)、B=(10,0)-(20,10)。共有辺は s1(10,0)–s2(10,10)。
const S1 = v('s1', 10, 0);
const S2 = v('s2', 10, 10);
const M = v('m', 10, 5); // 共有辺のちょうど中点（増分 8A の中点クリックで足すのと同じ点）
const A_V = [v('a0', 0, 0), S1, S2, v('a3', 0, 10)];
const B_V = [S1, v('b1', 20, 0), v('b2', 20, 10), S2];
const A = leaf('A', ['a0', 's1', 's2', 'a3']);
/**
 * B の輪が共有辺を引く向き 3 通り: A と逆向き（隣り合う面の普通の向き。s2 → s1）を途中の辺と
 * 閉じる辺で 1 つずつ、A と同じ向き（s1 → s2。輪の向きが逆の面）を 1 つ。
 */
const B_SHAPES = [
  ['隣が共有辺を逆向き（途中の辺）で引く', leaf('B', ['b1', 'b2', 's2', 's1'])],
  ['隣が共有辺を逆向き（閉じる辺）で引く', leaf('B', ['s1', 'b1', 'b2', 's2'])],
  ['隣が共有辺を同じ向きで引く', leaf('B', ['s2', 'b2', 'b1', 's1'])],
] as const;
const B_BACKWARD = B_SHAPES[1][1];

describe('分割 — 一直線上の元の頂点を片に戻す（継ぎ目の検証 2-2）', () => {
  const A_M = leaf('A', ['a0', 's1', 'm', 's2', 'a3']);
  const A_M_V = [...A_V, M];

  it('対照: 集合演算だけでは、共有辺の中点（一直線上の頂点）が片から落ちる', () => {
    const store = createVertexStore(A_M_V);
    const check = checkSplittable(A_M, store, createOpenKnifeLine([c(5, -1), c(5, 11)]));
    if (check.status !== SPLIT_CHECK_STATUS.Splittable) throw new Error('分けられない線');
    const coords = (check.pieces ?? []).flatMap((p) => p.area.flat(2));
    expect(coords.some((p) => p.lon === 10 && p.lat === 5)).toBe(false);
  });

  it('executeSplit は、どの片にも無い元の頂点を、それが乗る片の辺へ戻す', () => {
    const store = createVertexStore(A_M_V);
    const result = executeSplit(A_M, store, createOpenKnifeLine([c(5, -1), c(5, 11)]));
    if (result === undefined) throw new Error('分けられない線');
    const right = (result.pieces ?? []).find((p) => p.area.flat(2).some((q) => q.lon === 10));
    const ring = right!.area[0]![0]!;
    const i = ring.findIndex((q) => q.lon === 10 && q.lat === 5);
    expect(i).toBeGreaterThanOrEqual(0);
    // 戻した点は (10,0) と (10,10) の間に入る（辺に沿った順）。
    const prev = ring[(i - 1 + ring.length) % ring.length]!;
    const next = ring[(i + 1) % ring.length]!;
    expect([prev.lat, next.lat].sort((x, y) => x - y)).toEqual([0, 10]);
    expect(prev.lon).toBe(10);
    expect(next.lon).toBe(10);
    // 元の頂点なので切り口には数えない。
    expect(result.edgeCuts.some((e) => e.coordinate.lon === 10 && e.coordinate.lat === 5)).toBe(false);
  });

  for (const [label, bShape] of [
    ['隣が共有辺を逆向き（途中の辺）で引く', leaf('B', ['b1', 'b2', 's2', 'm', 's1'])],
    ['隣が共有辺を逆向き（閉じる辺）で引く', leaf('B', ['s1', 'b1', 'b2', 's2', 'm'])],
    ['隣が共有辺を同じ向きで引く', leaf('B', ['s2', 'b2', 'b1', 's1', 'm'])],
  ] as const) {
    for (const [lineLabel, line] of [
      ['共有辺に触れない縦線', [c(5, -1), c(5, 11)]],
      ['共有辺を中点と端の間で横切る線', [c(-1, 2.5), c(11, 2.5)]],
    ] as const) {
      it(`${label}・${lineLabel}: 分けたあと T 字 0、中点は片と隣が同じ id で引く`, () => {
        const root = project([
          history('A', [[0, [A_M], A_M_V]]),
          history('B', [[0, [bShape], [...B_V, M]]]),
        ]);
        const after = splitAt(root, 'A', 1500, line);
        expect(tJunctions(after, 1500)).toEqual([]);
        expect(idSplits(after, 1500)).toEqual([]);
        const pieceWithM = leavesAt(after, 1500).find(
          (p) => p.feature.id !== asFeatureId('B') && idAt(after, String(p.feature.id), 1500, c(10, 5)) !== undefined,
        );
        expect(pieceWithM).toBeDefined();
        expect(idAt(after, String(pieceWithM!.feature.id), 1500, c(10, 5))).toBe(
          idAt(after, 'B', 1500, c(10, 5)),
        );
        // 分ける前の年は触らない。
        expect(idAt(after, 'B', 0, c(10, 5))).toBe('m');
      });
    }
  }
});

describe('分割 — 切り口と付け替えを、隣の後ろの年の錨へも入れる（継ぎ目の検証 2-3）', () => {
  // 線 y=5 は共有辺を (10,5) で横切る（切り口が隣の辺の途中にできる）。
  const CUT = [c(-1, 5), c(11, 5)] as const;

  for (const [label, bShape] of B_SHAPES) {
    it(`${label}: 隣だけが後ろ（1700 年）に錨を持っていても、そこで T 字 0・id での共有が保たれる`, () => {
      const root = project([
        history('A', [[0, [A], A_V]]),
        history('B', [
          [0, [bShape], B_V],
          [1700, [bShape], B_V],
        ]),
      ]);
      const after = splitAt(root, 'A', 1500, CUT);
      for (const year of [1500, 1700, 2500]) {
        expect(tJunctions(after, year), `${String(year)} 年`).toEqual([]);
        expect(idSplits(after, year), `${String(year)} 年`).toEqual([]);
      }
      // 1700 年の B は切り口 (10,5) を、片と同じ id で引く。
      expect(idAt(after, 'B', 1700, c(10, 5))).toBeDefined();
      expect(idAt(after, 'B', 1700, c(10, 5))).toBe(idAt(after, 'A', 1700, c(10, 5)));
      // 分ける前の年は触らない。
      expect(idAt(after, 'B', 0, c(10, 0))).toBe('s1');
      expect(idAt(after, 'B', 0, c(10, 5))).toBeUndefined();
    });
  }

  it('逆の組: B を分け、A だけが後ろの年に錨を持つ', () => {
    const root = project([
      history('A', [
        [0, [A], A_V],
        [1700, [A], A_V],
      ]),
      history('B', [[0, [B_BACKWARD], B_V]]),
    ]);
    const after = splitAt(root, 'B', 1500, [c(9, 5), c(21, 5)]);
    for (const year of [1500, 1700]) {
      expect(tJunctions(after, year), `${String(year)} 年`).toEqual([]);
      expect(idSplits(after, year), `${String(year)} 年`).toEqual([]);
    }
  });

  it('隣の境目が変わった後ろの錨で打ち切る（その錨とその先は触らない）', () => {
    // B は 1700 年に遠くへ移り（A と何も共有しない）、1800 年に元の形へ戻る。
    const far = [v('f0', 30, 0), v('f1', 40, 0), v('f2', 40, 10), v('f3', 30, 10)];
    const bFar = leaf('B', ['f0', 'f1', 'f2', 'f3']);
    const root = project([
      history('A', [[0, [A], A_V]]),
      history('B', [
        [0, [B_BACKWARD], B_V],
        [1700, [bFar], far],
        [1800, [B_BACKWARD], B_V],
      ]),
    ]);
    const after = splitAt(root, 'A', 1500, CUT);
    const bBefore = root.histories[1]!.series.entries;
    const bAfter = after.histories.find((h) => h.featureId === asFeatureId('B'))!.series.entries;
    const at = (entries: typeof bBefore, year: number) =>
      entries.find((e) => e.start.year === year)!;
    expect(at(bAfter, 1700)).toBe(at(bBefore, 1700));
    expect(at(bAfter, 1800)).toBe(at(bBefore, 1800));
    // 1500 年（分けた年）は切り口を持つ。
    expect(tJunctions(after, 1500)).toEqual([]);
  });

  it('継承先に後ろの錨があれば、その年から先の隣は記録どおり（継承先の古い形と同じ id）のまま', () => {
    // A は 1800 年に錨を持つ（分ける前の形のまま）。B は 1700 年と 1900 年に錨を持つ。
    const root = project([
      history('A', [
        [0, [A], A_V],
        [1800, [A], A_V],
      ]),
      history('B', [
        [0, [B_BACKWARD], B_V],
        [1700, [B_BACKWARD], B_V],
        [1900, [B_BACKWARD], B_V],
      ]),
    ]);
    const after = splitAt(root, 'A', 1500, CUT);
    // 1700 年: 継承先は分けた結果のまま → 隣も新しい id・切り口を持つ。
    expect(tJunctions(after, 1700)).toEqual([]);
    expect(idAt(after, 'B', 1700, c(10, 0))).toBe(idAt(after, 'A', 1700, c(10, 0)));
    // 1900 年: 継承先は記録どおり分ける前の形（s1・s2）→ 隣もそのまま。
    expect(idAt(after, 'A', 1900, c(10, 0))).toBe('s1');
    expect(idAt(after, 'B', 1900, c(10, 0))).toBe('s1');
    expect(idAt(after, 'B', 1900, c(10, 5))).toBeUndefined();
    const bBefore = root.histories[1]!.series.entries.find((e) => e.start.year === 1900);
    const bAfter = after.histories
      .find((h) => h.featureId === asFeatureId('B'))!
      .series.entries.find((e) => e.start.year === 1900);
    expect(bAfter).toBe(bBefore);
  });
});
