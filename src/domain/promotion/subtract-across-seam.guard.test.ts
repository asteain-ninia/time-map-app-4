// B108 の守り — 引く形を全部の周へ複製する処理が壊れても、面 = 差分 + 共通部分 の検算が確定を断る。
//
// 読み直しの検算は差分の結果と比べるので、差分自体の誤りを通す。複製を差し替えて、いまの実装では
// 作れない「引き残し」の場面を作る（§5.41）。

import { describe, expect, it, vi } from 'vitest';

import { parentExisting } from '../affiliation/decision';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature } from '../feature';
import { wrapLonDeg } from '../geo/index';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import { subtractAcrossSeam } from './subtract-across-seam';

vi.mock('../geo/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('../geo/index')>();
  return {
    ...real,
    // 複製しない（直す前と同じ）。
    replicateAcrossSeam: (clip: unknown) => clip,
  };
});

const c = createCoordinate;
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const box = (w: number, s: number, e: number, n: number) => [c(w, s), c(e, s), c(e, n), c(w, n)];

function leafWithRings(id: string, rings: readonly (readonly ReturnType<typeof c>[])[]) {
  const vertices: Vertex[] = [];
  const shape = createShape(
    rings.map((ring, r) =>
      createTerritoryRing(
        asRingId(`${id}-${r}`),
        ring.map((q, i) => {
          const v = createVertex(asVertexId(`${id}-${r}-${i}`), c(wrapLonDeg(q.lon), q.lat));
          vertices.push(v);
          return v.id;
        }),
      ),
    ),
  );
  return {
    vertices,
    feature: createLeafFeature(asFeatureId(id), createBasicAttributes(id, 0, 0), COLOR, shape),
  };
}

describe('複製が効かないとき', () => {
  it('引き残しを検算が断る', () => {
    // 面の 2 つ目の片は基準 0 の窓の外へ出ていて、子は窓の反対側に置かれる。
    const r = subtractAcrossSeam(
      [[box(-10, -10, 10, 10)], [box(170, -10, 190, 10)]],
      [[box(181, -1, 183, 1)]],
      [],
    );
    expect(r).toEqual({ kind: 'rejected', stage: 'diff' });
  });

  it('子が基準の側に居て引けるなら通る（検算は正しい差分を断らない）', () => {
    const r = subtractAcrossSeam(
      [[box(-10, -10, 10, 10)], [box(170, -10, 190, 10)]],
      [[box(-2, -2, 2, 2)]],
      [],
    );
    expect(r.kind).toBe('ok');
  });

  it('所属変更は確定せず断る', () => {
    const parent = leafWithRings('P', [box(-10, -10, 10, 10), box(170, -10, 190, 10)]);
    const child = leafWithRings('C', [box(181, -1, 183, 1)]);
    const r = buildAffiliationProposal(
      [parent.feature, child.feature],
      child.feature.id,
      parentExisting(parent.feature.id),
      {
        idState: createIdGeneratorState(),
        now: () => 1000,
        vertexStore: createVertexStore([...parent.vertices, ...child.vertices]),
      },
    );
    expect(r.status).not.toBe('proposal');
  });
});
