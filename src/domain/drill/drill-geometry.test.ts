// U27 — drill geometry tests (受け入れ基準 1 / 5 / 6 / 7 / 8 / 10).

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { difference, union, isOk, type GeoMultiPolygon } from '../geometry/index';
import { RING_KIND } from '../ring';
import {
  checkDrillable,
  DRILL_CHECK_STATUS,
  DRILL_REJECT,
  executeDrill,
} from './drill-geometry';
import { assembleDrillProposal } from './proposal';
import {
  aggregate,
  bowTieRegion,
  centralRegion,
  escapingRegion,
  freshIdPorts,
  unitSquare,
} from './fixtures';

/** Total positive area of a multi-polygon (outer − holes). */
function area(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      let sum = 0;
      const n = ring.length;
      for (let k = 0; k < n; k += 1) {
        const a = ring[k]!;
        const b = ring[(k + 1) % n]!;
        sum += a.lon * b.lat - b.lon * a.lat;
      }
      const ringArea = Math.abs(sum) / 2;
      total += i === 0 ? ringArea : -ringArea;
    });
  }
  return total;
}

describe('checkDrillable — 妥当性検証 (受け入れ6 / 7)', () => {
  it('集約地物は拒否される (FR-35 / 受け入れ7)', () => {
    const { store } = unitSquare();
    const res = checkDrillable(aggregate(), store, centralRegion());
    expect(res.status).toBe(DRILL_CHECK_STATUS.NotDrillable);
    if (res.status === DRILL_CHECK_STATUS.NotDrillable) {
      expect(res.reason).toBe(DRILL_REJECT.NotTerminal);
    }
  });

  it('3 頂点未満の指定領域は拒否される (受け入れ6)', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, [createCoordinate(3, 3), createCoordinate(7, 7)]);
    expect(res).toMatchObject({ reason: DRILL_REJECT.DegenerateRegion });
  });

  it('自己交差する指定領域は拒否される (受け入れ6)', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, bowTieRegion());
    expect(res).toMatchObject({ reason: DRILL_REJECT.SelfIntersecting });
  });

  it('外周境界をはみ出す指定領域は拒否される (受け入れ6)', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, escapingRegion());
    expect(res.status).toBe(DRILL_CHECK_STATUS.NotDrillable);
    if (res.status === DRILL_CHECK_STATUS.NotDrillable) {
      expect(res.reason).toBe(DRILL_REJECT.NotContained);
    }
  });
});

describe('checkDrillable — 穴形成 + 新領域 (受け入れ1 / 5)', () => {
  it('内部の指定領域から穴付き原末端と新領域を算出する', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, centralRegion());
    expect(res.status).toBe(DRILL_CHECK_STATUS.Drillable);
    if (res.status !== DRILL_CHECK_STATUS.Drillable) return;

    // 穴付き原末端は1ピース・2リング (territory + hole).
    expect(res.holedOriginal.length).toBe(1);
    expect(res.holedOriginal[0]!.length).toBe(2);
    // 新領域は1ピース・1リング (territory only).
    expect(res.newRegion.length).toBe(1);
    expect(res.newRegion[0]!.length).toBe(1);
  });

  it('新地物の領土 == 元末端の穴 (受け入れ5: 新地物と穴の対応)', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, centralRegion());
    if (res.status !== DRILL_CHECK_STATUS.Drillable) throw new Error('expected drillable');

    // 新領域の面積 == くり抜いた穴の面積 ([3,7]² = 16).
    expect(area(res.newRegion)).toBeCloseTo(16, 6);

    // 元末端の元形状 == 穴付き原末端 + 新地物 (くり抜いた分が過不足なく新地物).
    const recombined = union(res.holedOriginal, res.newRegion);
    expect(isOk(recombined)).toBe(true);
    if (isOk(recombined)) {
      expect(area(recombined.result)).toBeCloseTo(100, 4); // 元の [0,10]² = 100.
    }
  });

  it('穴付き原末端の実効面積 == 元 − 穴 (100 − 16 = 84)', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, centralRegion());
    if (res.status !== DRILL_CHECK_STATUS.Drillable) throw new Error('expected drillable');
    expect(area(res.holedOriginal)).toBeCloseTo(84, 4);
  });
});

describe('executeDrill — 再検証 (教訓5.26)', () => {
  it('検証を通る入力は穴形成幾何を返す', () => {
    const { feature, store } = unitSquare();
    const geo = executeDrill(feature, store, centralRegion());
    expect(geo).toBeDefined();
    expect(geo!.holedOriginal[0]![0]!.length).toBeGreaterThanOrEqual(3);
  });

  it('集約地物では undefined を返す (確定しない)', () => {
    const { store } = unitSquare();
    expect(executeDrill(aggregate(), store, centralRegion())).toBeUndefined();
  });
});

describe('複数片の保持 (受け入れ8 / 教訓5.1)', () => {
  it('原末端を実際に複数領土ピースへ分断する指定領域でも全片を保持する', () => {
    // 受け入れ8の固有シナリオ: a region that BRIDGES the target edge-to-edge so the
    // difference splits the surviving original into TWO separate territory pieces
    // (飛び地) — not a single piece with a hole. A full-width interior bar
    // [0,10]×[4.5,5.5] touches the left/right外周 only (no crossing/はみ出し: its
    // vertices sit on the boundary, its edge midpoints are strictly inside), so it is
    // 包含 valid, yet U06 difference necessarily returns two pieces (top + bottom).
    const { feature, store } = unitSquare();
    const bar = [
      createCoordinate(0, 4.5),
      createCoordinate(10, 4.5),
      createCoordinate(10, 5.5),
      createCoordinate(0, 5.5),
    ];
    const res = checkDrillable(feature, store, bar);
    expect(res.status).toBe(DRILL_CHECK_STATUS.Drillable);
    if (res.status !== DRILL_CHECK_STATUS.Drillable) return;

    // 飛び地分岐が実行される: the holed original is genuinely MULTIPLE pieces, each a
    // standalone territory (no piece dropped, no piece collapsed into a hole).
    expect(res.holedOriginal.length).toBeGreaterThanOrEqual(2);
    res.holedOriginal.forEach((piece) => {
      // Each surviving piece is an独立した領土 (outer ring only, ≥3 頂点).
      expect(piece.length).toBe(1);
      expect(piece[0]!.length).toBeGreaterThanOrEqual(3);
    });

    // ALL pieces contribute to area conservation (片落とし禁止): top 45 + bottom 45 +
    // carved bar 10 == 元の 100. If any piece were dropped this sum would shrink.
    const piecesArea = res.holedOriginal.reduce((acc, piece) => acc + area([piece]), 0);
    expect(piecesArea).toBeCloseTo(90, 4);
    const recombined = union(res.holedOriginal, res.newRegion);
    expect(isOk(recombined)).toBe(true);
    if (isOk(recombined)) expect(area(recombined.result)).toBeCloseTo(100, 4);
  });

  it('proposal 側で複数領土ピースが個別の領土リングとして materialise される (受け入れ8)', () => {
    // The geometry's multi-piece飛び地 must survive into the assembled proposal as
    // SEPARATE territory rings — reparentByContainment must NOT fold them into one
    // another (top-level outer pieces have no container ⇒ each stays a territory).
    const { feature, store } = unitSquare();
    const bar = [
      createCoordinate(0, 4.5),
      createCoordinate(10, 4.5),
      createCoordinate(10, 5.5),
      createCoordinate(0, 5.5),
    ];
    const geometry = executeDrill(feature, store, bar);
    expect(geometry).toBeDefined();
    if (geometry === undefined) return;
    expect(geometry.holedOriginal.length).toBeGreaterThanOrEqual(2);

    const proposal = assembleDrillProposal({
      target: feature,
      geometry,
      newProperties: {
        attributes: createBasicAttributes('新地物', 1500, 1600),
        color: createColorInfo(true, '#abc', '#0f0', '#000'),
      },
      ids: freshIdPorts(),
    });

    // Both飛び地 survive as territory rings on the holed original (no hole rings: the
    // bridge produced two disjoint territories, not a territory-with-hole).
    const holedRings = proposal.holedShape.rings;
    const territories = holedRings.filter((r) => r.kind === RING_KIND.Territory);
    expect(territories.length).toBeGreaterThanOrEqual(2);
    expect(holedRings.every((r) => r.kind === RING_KIND.Territory)).toBe(true);
  });

  it('差演算結果の全リングが原形状の再構成に寄与する', () => {
    const { feature, store } = unitSquare();
    const res = checkDrillable(feature, store, centralRegion());
    if (res.status !== DRILL_CHECK_STATUS.Drillable) throw new Error('drillable');
    // The carved region differenced back out of the original equals the holed shape.
    const back = difference(
      [[[createCoordinate(0, 0), createCoordinate(10, 0), createCoordinate(10, 10), createCoordinate(0, 10)]]],
      res.newRegion,
    );
    expect(isOk(back)).toBe(true);
    if (isOk(back)) expect(area(back.result)).toBeCloseTo(area(res.holedOriginal), 4);
  });
});
