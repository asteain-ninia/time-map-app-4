// B106 — 整列の入口で、片の中の外周と穴が別の周へ分かれないこと。
//
// `alignMultiPolygon` は輪を 1 本ずつ基準へ寄せていたので、基準から 180 度前後の片では外周が
// +180 側、穴が -180 側へ分かれ、集合演算が穴を黙って捨てていた。期待値はどれも、手で組んだ
// 形から書いている（実装の出力を写さない）。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { union, isOk, type GeoMultiPolygon, type GeoRing } from '../geometry/index';
import { LONGITUDE_PERIOD, alignMultiPolygon, wrapLonDeg } from './index';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

/** 連続の経度で書いた四角を、保存される経度（代表区間へ畳んだ値）で返す。 */
function storedBox(west: number, south: number, east: number, north: number): GeoRing {
  return [
    c(wrapLonDeg(west), south),
    c(wrapLonDeg(east), south),
    c(wrapLonDeg(east), north),
    c(wrapLonDeg(west), north),
  ];
}

const lons = (ring: GeoRing): number[] => ring.map((p) => p.lon);

/** `inner` の経度が全部、`outer` の経度の範囲に入る。 */
function expectInsideLonRange(inner: GeoRing, outer: GeoRing): void {
  const lo = Math.min(...lons(outer));
  const hi = Math.max(...lons(outer));
  for (const lon of lons(inner)) {
    expect(lon).toBeGreaterThan(lo);
    expect(lon).toBeLessThan(hi);
  }
}

function shoelace(ring: GeoRing): number {
  let sum = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  });
  return Math.abs(sum) / 2;
}

function netArea(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      total += i === 0 ? shoelace(ring) : -shoelace(ring);
    });
  }
  return total;
}

describe('alignMultiPolygon は片ごとに揃える（B106）', () => {
  it('外周の先頭が西側、穴が東側に保存された片（基準 0）で、穴は外周の中に入る', () => {
    const outer = storedBox(170, 0, 190, 20); // 先頭は 170。
    const hole = storedBox(183, 5, 186, 8); // 保存は -177 〜 -174。
    const [aligned] = alignMultiPolygon([[outer, hole]], 0);
    expect(Math.min(...lons(aligned![0]!))).toBeCloseTo(170, 9);
    expect(Math.max(...lons(aligned![0]!))).toBeCloseTo(190, 9);
    expectInsideLonRange(aligned![1]!, aligned![0]!);
  });

  it('外周の平均は基準の 180 度の内、穴の平均は外の形（平均 180 と 181）で、穴は外周の中に入る', () => {
    const first = storedBox(-10, 0, 10, 20);
    const second = storedBox(170, 0, 190, 20);
    const hole = storedBox(178, 5, 184, 8);
    const aligned = alignMultiPolygon([[first], [second, hole]]);
    expectInsideLonRange(aligned[1]![1]!, aligned[1]![0]!);
  });

  it('穴が基準の外側へ出る片を和に渡しても、穴が消えない（面積は手で数えた 400 + 400 - 18）', () => {
    const first: GeoMultiPolygon = [[storedBox(-10, 0, 10, 20)]];
    const second: GeoMultiPolygon = [[storedBox(170, 0, 190, 20), storedBox(178, 5, 184, 8)]];
    const merged = union(alignMultiPolygon(first, 0), alignMultiPolygon(second, 0));
    if (!isOk(merged)) throw new Error('和が断られた');
    expect(merged.result.map((p) => p.length).sort()).toEqual([1, 2]);
    expect(netArea(merged.result)).toBeCloseTo(782, 6);
  });

  it('幅の広い外周の頂点が片側に密でも、反対側の穴は外周の中に入る', () => {
    // 頂点の平均は西へ寄る（約 41）。穴の位置 255 はそこから 180 度より遠い。
    const outer: WorldCoordinate[] = [];
    for (let lon = 0; lon <= 60; lon += 1) outer.push(c(lon, lon % 2 === 0 ? 0 : -0.5));
    outer.push(c(180, 0), c(300, 0), c(300, 30), c(150, 30), c(0, 30));
    const stored = outer.map((p) => c(wrapLonDeg(p.lon), p.lat));
    const hole = storedBox(250, 5, 260, 15);
    const [aligned] = alignMultiPolygon([[stored, hole]], 150);
    expectInsideLonRange(aligned![1]!, aligned![0]!);
  });

  it('入力を書き換えない', () => {
    const outer = storedBox(170, 0, 190, 20);
    const hole = storedBox(183, 5, 186, 8);
    const before = JSON.stringify([outer, hole]);
    alignMultiPolygon([[outer, hole]], 0);
    expect(JSON.stringify([outer, hole])).toBe(before);
  });

  it('性質: 基準がどこでも、どの片の穴も外周の中にあり、面積は基準によらない', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -180, max: 179 }),
        fc.integer({ min: 4, max: 80 }).map((n) => n * 4),
        fc.double({ min: 0.05, max: 0.85, noNaN: true }),
        fc.integer({ min: 0, max: 3 }),
        fc.double({ min: -540, max: 540, noNaN: true }),
        (west, width, holeAt, rotate, ref) => {
          // 幅 180 度以上の四角は辺が長くなるので、東西の辺を 60 度以下に刻む。
          const south: WorldCoordinate[] = [];
          const north: WorldCoordinate[] = [];
          for (let lon = west; lon < west + width; lon += 60) {
            south.push(c(wrapLonDeg(lon), 0));
            north.unshift(c(wrapLonDeg(lon), 20));
          }
          const outer = [
            ...south,
            c(wrapLonDeg(west + width), 0),
            c(wrapLonDeg(west + width), 20),
            ...north,
          ];
          const holeWest = west + width * holeAt;
          const hole = storedBox(holeWest, 5, holeWest + 2, 8);
          // 先頭の頂点を回して、保存の順で結果が変わらないことも見る。
          const turned = [...hole.slice(rotate), ...hole.slice(0, rotate)];
          const [aligned] = alignMultiPolygon([[outer, turned]], ref);
          expectInsideLonRange(aligned![1]!, aligned![0]!);
          // 外周も穴も、畳む前の幅のまま（1 周ずれた分割が起きていない）。
          const span = Math.max(...lons(aligned![0]!)) - Math.min(...lons(aligned![0]!));
          expect(span).toBeCloseTo(width, 6);
          expect(span).toBeLessThan(LONGITUDE_PERIOD);
          expect(netArea(aligned === undefined ? [] : [aligned])).toBeCloseTo(width * 20 - 6, 5);
        },
      ),
    );
  });
});
