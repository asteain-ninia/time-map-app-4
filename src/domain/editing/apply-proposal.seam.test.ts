// B113: 継ぎ目をまたぐ辺の切り口を、隣の輪へ辺に沿った順に差し込むための距離。
//
// 頂点の体は [-180, 180) に畳んであるので、170° から東へ継ぎ目を越える辺の切り口 182°・186° は
// -178°・-174° で持っている。素の差で測ると 186° のほうが近いと読まれ、逆の順に差し込まれる。

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';

import { squaredDistance } from './apply-proposal';

const C = (lon: number, lat = 0) => createCoordinate(lon, lat);

describe('squaredDistance', () => {
  it('継ぎ目の向こうの切り口も、辺の始点から近い順に並ぶ', () => {
    const start = C(170);
    const cuts = [C(-174), C(-178), C(178)]; // 186°, 182°, 178°
    const sorted = [...cuts].sort(
      (p, q) => squaredDistance(start, p) - squaredDistance(start, q),
    );
    expect(sorted.map((c) => c.lon)).toEqual([178, -178, -174]);
  });

  it('継ぎ目をまたがない 2 点は素の距離', () => {
    expect(squaredDistance(C(10, 3), C(13, 7))).toBeCloseTo(25, 9);
  });
});
