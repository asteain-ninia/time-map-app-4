// ［動かす］で集約地物を引いたときの分類（所有者の裁定 2026-11-01）。動かす頂点と動かさない頂点を、
// その年に居る地物だけから決める。
//
//   npx vitest run src/domain/editing/move.aggregate.test.ts

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createAggregateFeature, createLeafFeature, type Feature } from '../feature';
import { createShape, type Ring } from '../ring';
import { fid, hole, line, point, territory, vid } from './fixtures';
import { planAggregateMove } from './move';

const ATTRS = createBasicAttributes('test', 0, 100);
const COLOR = createColorInfo(true, '#111', '#222', '#333');

function aggregate(id: string, children: readonly string[], parent?: string): Feature {
  return createAggregateFeature(
    fid(id),
    ATTRS,
    COLOR,
    children.map(fid),
    parent === undefined ? {} : { parentId: fid(parent) },
  );
}

function child(id: string, parent: string | undefined, rings: readonly Ring[]): Feature {
  return createLeafFeature(
    fid(id),
    ATTRS,
    COLOR,
    createShape(rings),
    parent === undefined ? {} : { parentId: fid(parent) },
  );
}

function ids(values: readonly string[]): unknown[] {
  return values.map(vid);
}

describe('planAggregateMove', () => {
  it('下位の末端地物の頂点を動かし、途中の集約地物をたどる', () => {
    const plan = planAggregateMove(fid('国'), [
      aggregate('国', ['地方', '州C']),
      aggregate('地方', ['州A', '州B'], '国'),
      child('州A', '地方', [territory('ra', ['a0', 'a1', 'a2'])]),
      child('州B', '地方', [territory('rb', ['b0', 'b1', 'b2'])]),
      child('州C', '国', [territory('rc', ['c0', 'c1', 'c2'])]),
    ]);
    expect(plan.leaves.map((f) => f.id)).toEqual([fid('州A'), fid('州B'), fid('州C')]);
    expect(plan.movingVertexIds).toEqual(ids(['a0', 'a1', 'a2', 'b0', 'b1', 'b2', 'c0', 'c1', 'c2']));
    expect(plan.fixedVertexIds).toEqual([]);
    expect(plan.movedLeafCount).toBe(3);
  });

  it('途中の集約地物を引くと、その下だけが対象で、横の下位領域は外である', () => {
    const plan = planAggregateMove(fid('地方'), [
      aggregate('国', ['地方', '州C']),
      aggregate('地方', ['州A'], '国'),
      child('州A', '地方', [territory('ra', ['s', 'a1', 'a2'])]),
      child('州C', '国', [territory('rc', ['s', 'c1', 'c2'])]),
    ]);
    expect(plan.leaves.map((f) => f.id)).toEqual([fid('州A')]);
    expect(plan.movingVertexIds).toEqual(ids(['a1', 'a2']));
    expect(plan.fixedVertexIds).toEqual(ids(['s']));
  });

  it('下位領域どうしだけで共有している頂点は動かし、1 度だけ数える', () => {
    const plan = planAggregateMove(fid('国'), [
      aggregate('国', ['州A', '州B']),
      child('州A', '国', [territory('ra', ['s', 'a1', 'a2'])]),
      child('州B', '国', [territory('rb', ['s', 'b1', 'b2'])]),
    ]);
    expect(plan.movingVertexIds).toEqual(ids(['s', 'a1', 'a2', 'b1', 'b2']));
    expect(plan.fixedVertexIds).toEqual([]);
  });

  it('外の面・線・点と共有している頂点は動かさない', () => {
    const plan = planAggregateMove(fid('国'), [
      aggregate('国', ['州A']),
      child('州A', '国', [territory('ra', ['面', '線', '点', 'a'])]),
      child('隣', undefined, [territory('rn', ['面', 'n1', 'n2'])]),
      line('道', ['線', 'l1']),
      point('町', '点'),
    ]);
    expect(plan.movingVertexIds).toEqual(ids(['a']));
    expect(plan.fixedVertexIds).toEqual(ids(['面', '線', '点']));
  });

  it('穴と飛び地の頂点も、外と共有していなければ動かす', () => {
    const plan = planAggregateMove(fid('国'), [
      aggregate('国', ['州A']),
      child('州A', '国', [
        territory('外周', ['o0', 'o1', 'o2']),
        hole('穴', ['h0', 'h1', 'h2'], '外周'),
        territory('穴の中', ['i0', 'i1', 'i2'], '穴'),
        territory('飛び地', ['e0', 'e1', '共有']),
      ]),
      child('隣', undefined, [territory('rn', ['共有', 'n1', 'n2'])]),
    ]);
    expect(plan.movingVertexIds).toEqual(
      ids(['o0', 'o1', 'o2', 'h0', 'h1', 'h2', 'i0', 'i1', 'i2', 'e0', 'e1']),
    );
    expect(plan.fixedVertexIds).toEqual(ids(['共有']));
  });

  it('渡した年に居ない下位領域は対象にならず、頂点が全部不動の下位領域は数えない', () => {
    // 州B は別の年にしか居ないので、この年の地物の並びに入らない（親の子の一覧には残っている）。
    const plan = planAggregateMove(fid('国'), [
      aggregate('国', ['州A', '州B']),
      child('州A', '国', [territory('ra', ['s0', 's1', 's2'])]),
      child('隣', undefined, [territory('rn', ['s0', 's1', 's2'])]),
    ]);
    expect(plan.leaves.map((f) => f.id)).toEqual([fid('州A')]);
    expect(plan.movingVertexIds).toEqual([]);
    expect(plan.fixedVertexIds).toEqual(ids(['s0', 's1', 's2']));
    expect(plan.movedLeafCount).toBe(0);
  });

  it('その年に下位領域が居ない・集約地物でない・居ないときは空である', () => {
    const empty = { leaves: [], movingVertexIds: [], fixedVertexIds: [], movedLeafCount: 0 };
    const leafAlone = child('面', undefined, [territory('r', ['a', 'b', 'c'])]);
    expect(planAggregateMove(fid('国'), [aggregate('国', ['州A'])])).toEqual(empty);
    expect(planAggregateMove(fid('面'), [leafAlone])).toEqual(empty);
    expect(planAggregateMove(fid('無'), [leafAlone])).toEqual(empty);
  });

  it('親子が輪になった壊れたデータでも止まる', () => {
    const plan = planAggregateMove(fid('A'), [aggregate('A', ['B'], 'B'), aggregate('B', ['A'], 'A')]);
    expect(plan.leaves).toEqual([]);
  });
});
