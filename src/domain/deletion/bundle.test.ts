// 「その時刻に効いている全系列の束」で掃除する削除の検査（所有者の裁定 2026-09-07「直す」）。
//
// 固定すること:
//   1. まとめ役 P から外のまとめ役 Q へ移した子は、P を全部の年から消しても Q の子のまま残る
//      （以前は Q の錨に子が居ないので「下位領域を全部失った」と読まれ、Q ごと消えていた）。
//   2. 連邦化で作ったまとめ役 F でも同じ形になる。
//   3. 関係の無い地物を消しても、子が自分の系列を持つまとめ役は消えない。
//   4. 消える親を指していた「自分の系列を持つ子」の parentId も同じ操作で外れる
//      （教訓 5.21。以前は子の錨に親が居ないので掃除されず、保存前検査で止まった）。
//   5. 子を本当に全部失ったまとめ役は、これまでどおり連鎖して消える（FR-35）。

import { describe, expect, it } from 'vitest';

import { resolveAt } from '../anchor-series';
import { parentCreate, parentExisting, parentNone } from '../affiliation/decision';
import { buildAffiliationProposalForTargets } from '../affiliation/proposal';
import {
  applyAffiliationProposal,
  toAffiliationEditProposal,
} from '../editing/apply-proposal';
import type { Feature } from '../feature';
import { createIdGeneratorState } from '../id-generator';
import type { FeatureId } from '../ids';
import { checkConsistency } from '../persistence/consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../persistence/fixtures';
import { checkBeforeSave } from '../persistence/pre-save';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { deleteFeatureFromHistories, deletionStateFromHistories } from './bundle';
import { describeDeletionImpact } from './impact';
import { judgeDeletion, DELETE_VERDICT } from './eligibility';
import { aggregate, anchorOf, fid, leafTile } from './fixtures';

const calendar = getCalendar('gregorian');
const MOVE_YEAR = 1200;

/**
 * 実データと同じ形: まとめ役 P が系列を持ち、その錨（1000 年・1200 年）に子 a・b・c が
 * 居候している。外に最上位の末端 Q（自分の系列つき）と、関係の無い末端 Z を置く。
 */
function nestedRoot(): DomainProject {
  const entries = [1000, MOVE_YEAR].map((year) => {
    const a = leafTile('a', 0, 0, 10, 10, 'P');
    const b = leafTile('b', 10, 0, 10, 10, 'P');
    const c = leafTile('c', 20, 0, 10, 10, 'P');
    return {
      anchor: anchorOf(
        `anchor-P-${String(year)}`,
        [aggregate('P', ['a', 'b', 'c']), a.feature, b.feature, c.feature],
        [...a.vertices, ...b.vertices, ...c.vertices],
      ),
      start: timePointYear(year),
      end: null,
    };
  });
  const q = leafTile('Q', 100, 0, 10, 10);
  const z = leafTile('Z', 200, 0, 10, 10);
  const histories: FeatureHistory[] = [
    { featureId: fid('P'), series: { entries } },
    {
      featureId: fid('Q'),
      series: {
        entries: [
          { anchor: anchorOf('anchor-Q', [q.feature], q.vertices), start: timePointYear(1000), end: null },
        ],
      },
    },
    {
      featureId: fid('Z'),
      series: {
        entries: [
          { anchor: anchorOf('anchor-Z', [z.feature], z.vertices), start: timePointYear(1000), end: null },
        ],
      },
    },
  ];
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

/** その時刻に効いている地物と頂点（全系列の束）。 */
function effectiveAt(
  histories: readonly FeatureHistory[],
  at: TimePoint,
): { features: Feature[]; store: VertexStore } {
  const features: Feature[] = [];
  const vertices: Vertex[] = [];
  for (const h of histories) {
    const r = resolveAt(h.series, at, calendar);
    if (r.kind !== 'present') continue;
    features.push(...r.entry.anchor.snapshot.features);
    vertices.push(...r.entry.anchor.snapshot.vertices.byId.values());
  }
  return { features, store: createVertexStore(vertices) };
}

/** 実際の所属変更の流れ（案を組む → 系列へ当てる）で a・b を動かす。 */
function moveAB(root: DomainProject, decision: Parameters<typeof buildAffiliationProposalForTargets>[2]): DomainProject {
  const at = timePointYear(MOVE_YEAR);
  const { features, store } = effectiveAt(root.histories, at);
  const result = buildAffiliationProposalForTargets(features, [fid('a'), fid('b')], decision, {
    idState: createIdGeneratorState(),
    now: () => 1,
    vertexStore: store,
  });
  if (result.status !== 'proposal') throw new Error(JSON.stringify(result));
  return applyAffiliationProposal(root, toAffiliationEditProposal(result.proposal, at), calendar);
}

function parentAt(histories: readonly FeatureHistory[], id: FeatureId, year: number): FeatureId | undefined | null {
  const f = effectiveAt(histories, timePointYear(year)).features.find((x) => x.id === id);
  return f === undefined ? null : f.parentId;
}

function deleteOrThrow(root: DomainProject, id: FeatureId): DomainProject {
  const out = deleteFeatureFromHistories(root.histories, id, calendar);
  if (out === null) throw new Error('no-op deletion');
  return { ...root, histories: out.histories };
}

describe('削除は「その時刻の全系列の束」で掃除する', () => {
  it('外のまとめ役へ移した子は、元のまとめ役を消しても行き先の子のまま残る', () => {
    const moved = moveAB(nestedRoot(), parentExisting(fid('Q')));
    // 前提: 移した子は自分の系列を持ち、Q の錨には居ない（Q は錨 1 枚だけ見ると空に見える形）。
    expect(moved.histories.some((h) => h.featureId === fid('a'))).toBe(true);
    expect(parentAt(moved.histories, fid('a'), MOVE_YEAR)).toBe(fid('Q'));

    const after = deleteOrThrow(moved, fid('P'));

    // Q は消えていない（系列が残り、1200 年に集約として居る）。
    expect(after.histories.some((h) => h.featureId === fid('Q'))).toBe(true);
    const q = effectiveAt(after.histories, timePointYear(MOVE_YEAR)).features.find(
      (f) => f.id === fid('Q'),
    );
    expect(q?.kind).toBe('aggregate');
    // 移した子の上位領域は Q のまま。
    expect(parentAt(after.histories, fid('a'), MOVE_YEAR)).toBe(fid('Q'));
    expect(parentAt(after.histories, fid('b'), MOVE_YEAR)).toBe(fid('Q'));
    // P は全部の年から居ない。
    expect(after.histories.some((h) => h.featureId === fid('P'))).toBe(false);
    // 残っていた子 c は最上位として生き残る（消える親を指したままにしない）。
    expect(parentAt(after.histories, fid('c'), 1000)).toBeUndefined();
    expect(parentAt(after.histories, fid('c'), MOVE_YEAR)).toBeUndefined();
    // 1000 年（移す前）の a も、消えた P を指したままにしない。
    expect(parentAt(after.histories, fid('a'), 1000)).toBeUndefined();

    // 読み込みの整合検査も保存前検査も通る。
    expect(checkConsistency(after, calendar).inconsistencies).toEqual([]);
    expect(checkBeforeSave(after, calendar)).toEqual([]);
  });

  it('連邦化で作ったまとめ役でも同じ（元のまとめ役を消しても連邦は残る）', () => {
    const federated = moveAB(nestedRoot(), parentCreate({ name: '連邦' }, parentNone));
    const fedId = parentAt(federated.histories, fid('a'), MOVE_YEAR);
    expect(fedId).not.toBeNull();
    expect(fedId).not.toBeUndefined();
    const federationId = fedId as FeatureId;
    expect(federationId).not.toBe(fid('P'));

    const after = deleteOrThrow(federated, fid('P'));

    expect(after.histories.some((h) => h.featureId === federationId)).toBe(true);
    expect(parentAt(after.histories, fid('a'), MOVE_YEAR)).toBe(federationId);
    expect(parentAt(after.histories, fid('b'), MOVE_YEAR)).toBe(federationId);
    expect(checkConsistency(after, calendar).inconsistencies).toEqual([]);
    expect(checkBeforeSave(after, calendar)).toEqual([]);
  });

  it('関係の無い地物を消しても、子が自分の系列を持つまとめ役は消えない', () => {
    const moved = moveAB(nestedRoot(), parentExisting(fid('Q')));
    const after = deleteOrThrow(moved, fid('Z'));
    expect(after.histories.some((h) => h.featureId === fid('Q'))).toBe(true);
    const q = effectiveAt(after.histories, timePointYear(MOVE_YEAR)).features.find(
      (f) => f.id === fid('Q'),
    );
    expect(q?.kind).toBe('aggregate');
    expect(parentAt(after.histories, fid('a'), MOVE_YEAR)).toBe(fid('Q'));
    expect(after.histories.some((h) => h.featureId === fid('Z'))).toBe(false);
  });

  it('子を本当に全部失ったまとめ役は連鎖して消える（FR-35 はそのまま）', () => {
    const moved = moveAB(nestedRoot(), parentCreate({ name: '連邦' }, parentNone));
    const federationId = parentAt(moved.histories, fid('a'), MOVE_YEAR) as FeatureId;
    // 連邦の子 a を消しても b が居るので連邦は残る。
    const afterA = deleteOrThrow(moved, fid('a'));
    expect(afterA.histories.some((h) => h.featureId === federationId)).toBe(true);
    // b も消すと連邦は下位領域を全部失って消える。
    const afterB = deleteOrThrow(afterA, fid('b'));
    expect(afterB.histories.some((h) => h.featureId === federationId)).toBe(false);
  });

  it('影響の一覧と判定も束で数える（行き先のまとめ役を「自動で消える」と言わない）', () => {
    const moved = moveAB(nestedRoot(), parentExisting(fid('Q')));
    const { state } = deletionStateFromHistories(moved.histories, calendar);
    const impact = describeDeletionImpact(state, fid('P'));
    expect(impact.autoRemovedIds).not.toContain(fid('Q'));
    // 束で見れば Q は子を持つので、「再編できない」の警告にもならない。
    expect(judgeDeletion(state, fid('P')).kind).toBe(DELETE_VERDICT.Allowed);
  });
});

describe('まとめ役の剪定は、その錨の区間のどの時点でも子が居ないときだけ（増分 7 の手直し 2 回目）', () => {
  /**
   * 連邦 F の錨は 1100 年から（開始年を前へ直した形）。子 a・b は 1200 年から F の子
   * （自分の系列）。関係の無い Z と W を置く。F の錨の始まりの時刻（1100 年）には子が居ない。
   */
  function federationStartedEarly(): DomainProject {
    const a = leafTile('a', 0, 0, 10, 10);
    const b = leafTile('b', 10, 0, 10, 10);
    const z = leafTile('Z', 200, 0, 10, 10);
    const own = (id: string, feature: Feature, vertices: Vertex[]): FeatureHistory => ({
      featureId: fid(id),
      series: {
        entries: [
          { anchor: anchorOf(`anchor-${id}-1000`, [feature], vertices), start: timePointYear(1000), end: null },
          {
            anchor: anchorOf(`anchor-${id}-1200`, [{ ...feature, parentId: fid('F') } as Feature], vertices),
            start: timePointYear(1200),
            end: null,
          },
        ],
      },
    });
    const histories: FeatureHistory[] = [
      {
        featureId: fid('F'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-F-1100', [aggregate('F', ['a', 'b'])], []), start: timePointYear(1100), end: null },
          ],
        },
      },
      own('a', a.feature, a.vertices),
      own('b', b.feature, b.vertices),
      {
        featureId: fid('Z'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-Z', [z.feature], z.vertices), start: timePointYear(1000), end: null },
          ],
        },
      },
    ];
    return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
  }

  it('区間の途中から子が居る連邦は、関係の無い地物を消しても消えない（反証 #3 H1b）', () => {
    const root = federationStartedEarly();
    const after = deleteOrThrow(root, fid('Z'));
    expect(after.histories.some((h) => h.featureId === fid('F'))).toBe(true);
    expect(parentAt(after.histories, fid('a'), 1200)).toBe(fid('F'));
    expect(parentAt(after.histories, fid('b'), 1300)).toBe(fid('F'));
    // 影響の一覧も「自動で消える」と言わず、判定も通す（削除の前からある形を削除のせいにしない）。
    const { state } = deletionStateFromHistories(root.histories, calendar);
    expect(describeDeletionImpact(state, fid('Z')).autoRemovedIds).not.toContain(fid('F'));
    expect(judgeDeletion(state, fid('Z')).kind).toBe(DELETE_VERDICT.Allowed);
  });

  it('区間の途中から子が居る連邦の、途中から入った子を消すと、もう子の居ない連邦は消える', () => {
    const afterA = deleteOrThrow(federationStartedEarly(), fid('a'));
    expect(afterA.histories.some((h) => h.featureId === fid('F'))).toBe(true);
    const afterB = deleteOrThrow(afterA, fid('b'));
    expect(afterB.histories.some((h) => h.featureId === fid('F'))).toBe(false);
  });
});

describe('削除の影響: 一部の年からだけ消えるまとめ役を「自動で消える」と数えない（手直し 3 回目 / 再検証 #3）', () => {
  it('連邦の州 a を 1400 年で終わらせてから州 b を消すと、連邦は 1400 年からだけ消え、前の年は残る', () => {
    // 連邦 F（1200 年から）。a は [1200, 1400)、b は 1200 年からずっと。F の記録は 1400 年で割られている。
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const b = leafTile('b', 10, 0, 10, 10, 'F');
    const histories: FeatureHistory[] = [
      {
        featureId: fid('F'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-F-1200', [aggregate('F', ['a', 'b'])], []), start: timePointYear(1200), end: null },
            { anchor: anchorOf('anchor-F-1400', [aggregate('F', ['b'])], []), start: timePointYear(1400), end: null },
          ],
        },
      },
      { featureId: fid('a'), series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: timePointYear(1200), end: timePointYear(1400) }] } },
      { featureId: fid('b'), series: { entries: [{ anchor: anchorOf('anchor-b', [b.feature], b.vertices), start: timePointYear(1200), end: null }] } },
    ];
    const { state } = deletionStateFromHistories(histories, calendar);
    const impact = describeDeletionImpact(state, fid('b'));
    expect(impact.autoRemovedIds).not.toContain(fid('F'));
    expect(impact.partlyRemovedIds).toContain(fid('F'));
    const out = deleteFeatureFromHistories(histories, fid('b'), calendar)!;
    expect(parentAt(out.histories, fid('a'), 1300)).toBe(fid('F'));
    expect(parentAt(out.histories, fid('F'), 1500)).toBeNull();
  });
});
