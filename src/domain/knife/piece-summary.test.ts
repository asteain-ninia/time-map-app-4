import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { pointInPolygon, POINT_LOCATION, type GeoMultiPolygon } from '../geometry/index';
import { PIECE_DIRECTION, summarizePieces } from './piece-summary';

const c = createCoordinate;
const rect = (x0: number, y0: number, x1: number, y1: number): GeoMultiPolygon => [
  [[c(x0, y0), c(x1, y0), c(x1, y1), c(x0, y1)]],
];

describe('summarizePieces — 番号・方角・札の位置（V10 / N-09）', () => {
  it('南北に分けた 2 片は 1=北・2=南（番号は並びのまま）', () => {
    const s = summarizePieces([rect(0, 5, 10, 10), rect(0, 0, 10, 5)]);
    expect(s.map((p) => p.number)).toEqual([1, 2]);
    expect(s.map((p) => p.direction)).toEqual([PIECE_DIRECTION.North, PIECE_DIRECTION.South]);
  });

  it('東西に分けた 2 片は東・西', () => {
    const s = summarizePieces([rect(0, 0, 5, 10), rect(5, 0, 10, 10)]);
    expect(s.map((p) => p.direction)).toEqual([PIECE_DIRECTION.West, PIECE_DIRECTION.East]);
  });

  it('横長の面でも縦の半分どうしは北と南になる（外接矩形の半幅・半高で割る）', () => {
    const s = summarizePieces([rect(0, 1, 100, 2), rect(0, 0, 100, 1)]);
    expect(s.map((p) => p.direction)).toEqual([PIECE_DIRECTION.North, PIECE_DIRECTION.South]);
  });

  it('3 片の真ん中は中央', () => {
    const s = summarizePieces([rect(0, 0, 10, 3), rect(0, 3, 10, 7), rect(0, 7, 10, 10)]);
    expect(s.map((p) => p.direction)).toEqual([
      PIECE_DIRECTION.South,
      PIECE_DIRECTION.Center,
      PIECE_DIRECTION.North,
    ]);
  });

  it('凹んだ片（U の字）でも札は片の内側に置く', () => {
    const u: GeoMultiPolygon = [
      [[c(0, 0), c(10, 0), c(10, 10), c(7, 10), c(7, 3), c(3, 3), c(3, 10), c(0, 10)]],
    ];
    const [s] = summarizePieces([u]);
    // 重心 (5, ~4) は谷（面の外）に落ちる形。札は内側へ移る。
    expect(pointInPolygon(s!.labelPoint, u[0]!)).toBe(POINT_LOCATION.Inside);
  });

  it('穴のある片の札は穴に落ちない', () => {
    const holed: GeoMultiPolygon = [
      [
        [c(0, 0), c(10, 0), c(10, 10), c(0, 10)],
        [c(2, 2), c(8, 2), c(8, 8), c(2, 8)],
      ],
    ];
    const [s] = summarizePieces([holed]);
    expect(pointInPolygon(s!.labelPoint, holed[0]!)).toBe(POINT_LOCATION.Inside);
  });
});
