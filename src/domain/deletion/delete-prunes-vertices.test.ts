// 地物を消したら、その地物しか引いていなかった頂点の体も錨の頂点表から消える（現状.md B40）。
//
// 残すと保存データが太るだけでなく、消えた地物の古い写しが「同じ年に同じ頂点の座標が食い違う」と
// 読み込みの検査に言われる（隣がその頂点を動かしても、誰も引いていない写しは動かないので）。
// 削除以外の確定（分ける・結ぶ・穴あけ・所属変更）はもともと `pruneVertexStore` で揃えている。
//
//   npx vitest run src/domain/deletion/delete-prunes-vertices.test.ts

import { describe, expect, it } from 'vitest';

import { createAnchor } from '../anchor';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createEditProposal } from '../consistency/types';
import { buildSnapshot } from '../editing/edit-flow';
import { applyEditProposal } from '../editing/apply-proposal';
import { coord, fid, territory, vid } from '../editing/fixtures';
import { createAggregateFeature, createLeafFeature, type Feature } from '../feature';
import { asAnchorId } from '../ids';
import { checkConsistency, INCONSISTENCY, type Inconsistency } from '../persistence/consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../persistence/fixtures';
import {
  PARSE_OUTCOME,
  manifestToProject,
  parseManifest,
  serialize,
  type DomainProject,
  type FeatureHistory,
} from '../persistence/index';
import { applyRepair, REPAIR_OPTION } from '../persistence/repair';
import { createShape } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex } from '../vertex';

import { deleteFeatureFromHistories } from './bundle';

const calendar = getCalendar('gregorian');
const ATTRS = createBasicAttributes('test', 0, 9999);
const COLOR = createColorInfo(true, '#111', '#222', '#333');
const T = timePointYear(1000);

function body(id: string, lon: number, lat: number): Vertex {
  return createVertex(vid(id), coord(lon, lat));
}

function leaf(id: string, parent: string | undefined, vertexIds: readonly string[]): Feature {
  return createLeafFeature(
    fid(id),
    ATTRS,
    COLOR,
    createShape([territory(`r-${id}`, vertexIds)]),
    parent === undefined ? {} : { parentId: fid(parent) },
  );
}

function historyOf(owner: string, features: readonly Feature[], vertices: readonly Vertex[]): FeatureHistory {
  return {
    featureId: fid(owner),
    series: {
      entries: [
        createAnchorEntry(
          createAnchor(asAnchorId(`a-${owner}`), {
            features,
            vertices: createVertexStore(vertices),
          }),
          T,
          null,
        ),
      ],
    },
  };
}

/**
 * 集約地物 F の錨に子 a・b が居候していて（実データの集約地物と同じ形）、外に自分の系列を持つ c が居る。
 *   - a と b は s を共有する。a と c は x を共有する。
 *   - a1 は a だけが引く。
 */
function world(): DomainProject {
  const a = leaf('a', 'F', ['s', 'x', 'a1']);
  const b = leaf('b', 'F', ['s', 'b1', 'b2']);
  const c = leaf('c', undefined, ['x', 'c1', 'c2']);
  const f = createAggregateFeature(fid('F'), ATTRS, COLOR, [fid('a'), fid('b')]);
  return {
    histories: [
      historyOf(
        'F',
        [f, a, b],
        [body('s', 0, 0), body('x', 0, 10), body('a1', -10, 5), body('b1', 10, 0), body('b2', 10, -10)],
      ),
      historyOf('c', [c], [body('x', 0, 10), body('c1', 10, 20), body('c2', 0, 20)]),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function bodiesOf(p: DomainProject, owner: string): readonly string[] {
  const h = p.histories.find((x) => x.featureId === fid(owner))!;
  const r = resolveAt(h.series, T, calendar);
  if (r.kind !== 'present') throw new Error('居ない');
  return [...r.entry.anchor.snapshot.vertices.byId.keys()].map(String).sort();
}

function reopen(p: DomainProject): DomainProject {
  const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(p))) as unknown);
  if (parsed.outcome !== PARSE_OUTCOME.Ok) throw new Error(parsed.outcome);
  return manifestToProject(parsed.manifest);
}

describe('地物を消すと、誰も引かなくなった頂点の体も消える（B40）', () => {
  it('消した地物だけが引いていた頂点は錨の表から消え、残る地物が引く頂点は残る', () => {
    const before = world();
    expect(bodiesOf(before, 'F')).toEqual(['a1', 'b1', 'b2', 's', 'x']);
    const done = deleteFeatureFromHistories(before.histories, fid('a'), calendar);
    expect(done).not.toBeNull();
    const after: DomainProject = { ...before, histories: done!.histories };
    // a1 と x は F の錨の誰も引かなくなった。s は b が引くので残る。
    expect(bodiesOf(after, 'F')).toEqual(['b1', 'b2', 's']);
    // c の錨は c が引く頂点をそのまま持つ。
    expect(bodiesOf(after, 'c')).toEqual(['c1', 'c2', 'x']);
  });

  it('消したあと隣が共有していた頂点を動かしても、保存して開き直して検査が何も言わない', () => {
    const before = world();
    const done = deleteFeatureFromHistories(before.histories, fid('a'), calendar)!;
    const deleted: DomainProject = { ...before, histories: done.histories };

    const c = leaf('c', undefined, ['x', 'c1', 'c2']);
    const moved = applyEditProposal(
      deleted,
      createEditProposal(
        fid('c'),
        T,
        buildSnapshot({ feature: c, vertices: [body('x', 3, 13), body('c1', 10, 20), body('c2', 0, 20)] }),
      ),
      calendar,
    );

    const report = checkConsistency(reopen(moved), calendar);
    expect(report.inconsistencies.filter((i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('修復の「読み込みから除外」でも、除外した地物だけが引いていた頂点は表に残らない', () => {
    const before = world();
    const inc: Inconsistency = {
      kind: INCONSISTENCY.RingHierarchyInvalid,
      featureIds: [fid('a')],
      featureNames: [],
    };
    const after = applyRepair(before, inc, REPAIR_OPTION.DropRingHierarchyFeature, calendar);
    expect(bodiesOf(after, 'F')).toEqual(['b1', 'b2', 's']);
    expect(bodiesOf(after, 'c')).toEqual(['c1', 'c2', 'x']);
  });
});
