// 増分 7 の手直し 3 回目（再検証 #1）: 保存前の板が「このまま保存する」と勧める形を、開き直して
// **既定の修復**（各行の先頭）で直しても、記録が全部の年から消えないことを固定する。
//
//   - 集約地物の開始年を前へ動かした形（B74）／後ろへ動かしてから戻した形: 子の居ない区間だけ
//     集約地物を無くし、子の並びを揃える。子の居る年の集約地物の記録・子の記録は残る。
//   - 古いファイルの「子の居ない集約地物」「その年に居ない親を指す子」: 区間の修復が既定。
//   - 一度も子を持たない集約地物は区間の修復では消さない（未解決のまま、次の方法を選ぶ）。
//
// 開き直しは画面の読み込みと同じ関数（serialize → parseManifest → checkConsistency →
// buildRepairRows → applyChosenRepairs）を通す。

import { describe, expect, it } from 'vitest';

import { resolveAt } from '../../domain/anchor-series';
import { aggregate, anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import type { FeatureId } from '../../domain/ids';
import {
  INCONSISTENCY,
  PARSE_OUTCOME,
  REPAIR_OPTION,
  checkConsistency,
  manifestToProject,
  parseManifest,
  repairOptionsFor,
  serialize,
  type DomainProject,
} from '../../domain/persistence/index';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../../domain/persistence/fixtures';
import type { FeatureHistory } from '../../domain/persistence/serialize';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import { createAnchorIntervalCommandForRoot } from '../consistency-binding';
import { buildChangeStartIntent } from '../property/index';

import { REPAIR_OUTCOME, applyChosenRepairs, buildRepairRows } from './repair-flow';

const CAL = getCalendar('gregorian');
const y = timePointYear;

function project(histories: readonly FeatureHistory[]): DomainProject {
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

/** 連邦 F（1200 年から）と、自分の系列を持つ州 a・b（1200 年から F の子）。 */
function federation(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'F');
  const b = leafTile('b', 10, 0, 10, 10, 'F');
  return project([
    { featureId: fid('F'), series: { entries: [{ anchor: anchorOf('anchor-F-1200', [aggregate('F', ['a', 'b'])], []), start: y(1200), end: null }] } },
    { featureId: fid('a'), series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: y(1200), end: null }] } },
    { featureId: fid('b'), series: { entries: [{ anchor: anchorOf('anchor-b', [b.feature], b.vertices), start: y(1200), end: null }] } },
  ]);
}

/** 保存の形へ写して、読み込みの境界（parseManifest）を通して戻す。 */
function reopen(p: DomainProject): DomainProject {
  const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(p))) as unknown);
  if (parsed.outcome !== PARSE_OUTCOME.Ok) throw new Error(parsed.outcome);
  return manifestToProject(parsed.manifest);
}

/** 開き直して、各行の先頭（既定）の方法で修復する。 */
function reopenWithDefaults(p: DomainProject): { outcome: string; project: DomainProject | null; rows: number } {
  const loaded = reopen(p);
  const report = checkConsistency(loaded, CAL);
  if (report.ok) return { outcome: 'clean', project: loaded, rows: 0 };
  const rows = buildRepairRows(report);
  const choices = new Map(rows.map((r) => [r.index, r.options[0]!.id]));
  const applied = applyChosenRepairs(loaded, rows, choices, CAL);
  return {
    outcome: applied.outcome,
    project: applied.outcome === REPAIR_OUTCOME.Incomplete ? null : applied.project,
    rows: rows.length,
  };
}

function parentAt(p: DomainProject, id: string, year: number): string | null | undefined {
  for (const h of p.histories) {
    const r = resolveAt(h.series, y(year), CAL);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === fid(id));
    if (f !== undefined) return f.parentId === undefined ? null : String(f.parentId);
  }
  return undefined;
}

function changeStart(p: DomainProject, id: string, year: number): DomainProject {
  const own = p.histories.find((h) => h.featureId === fid(id))!;
  const built = createAnchorIntervalCommandForRoot(
    p,
    buildChangeStartIntent(fid(id) as FeatureId, own.series.entries[0]!.anchor.id, y(year)),
  );
  if (!built.ok) throw new Error(JSON.stringify(built.reason));
  return built.command.execute(p).state;
}

describe('既定の修復で記録を全部の年から消さない（手直し 3 回目 1-2 / 再検証 #1）', () => {
  it('(c) 集約地物の開始年を前へ動かした形: 子の居ない区間だけ無くし、1200 年からの連邦と州は残る', () => {
    const edited = changeStart(federation(), 'F', 1100);
    expect(parentAt(edited, 'F', 1150)).toBeNull(); // 動かした直後は 1100 年から居る
    const done = reopenWithDefaults(edited);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Applied);
    const p = done.project!;
    expect(parentAt(p, 'F', 1150)).toBeUndefined();
    expect(parentAt(p, 'F', 1300)).toBeNull();
    expect(parentAt(p, 'a', 1300)).toBe('F');
    expect(parentAt(p, 'b', 1300)).toBe('F');
  });

  it('(c) 後ろへ動かしてから戻した形も、連邦は全部の年から消えない', () => {
    const edited = changeStart(changeStart(federation(), 'F', 1300), 'F', 1200);
    const done = reopenWithDefaults(edited);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Applied);
    const p = done.project!;
    expect(parentAt(p, 'F', 1300)).toBeNull();
    expect(parentAt(p, 'a', 1300)).toBe('F');
  });

  it('(b) 子の開始年を親より前へ動かしても、親が居ない区間だけ親が外れ、開き直しで修復を聞かれない', () => {
    const edited = changeStart(federation(), 'a', 1100);
    expect(parentAt(edited, 'a', 1150)).toBeNull();
    expect(parentAt(edited, 'a', 1300)).toBe('F');
    expect(reopenWithDefaults(edited).outcome).toBe('clean');
  });

  it('古いファイル: 子の居ない区間を持つ集約地物は、既定で「その区間だけ無くす」（子の居た年の記録は残る）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const old = project([
      {
        featureId: fid('F'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-F-1200', [aggregate('F', ['a'])], []), start: y(1200), end: null },
            { anchor: anchorOf('anchor-F-1400', [aggregate('F', [])], []), start: y(1400), end: null },
          ],
        },
      },
      { featureId: fid('a'), series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: y(1200), end: y(1400) }] } },
    ]);
    const inc = checkConsistency(old, CAL).inconsistencies.find((i) => i.detail === 'aggregate-no-children')!;
    expect(repairOptionsFor(inc).map((o) => o.id)).toEqual([
      REPAIR_OPTION.RemoveEmptyAggregateIntervals,
      REPAIR_OPTION.DropShapeRoleFeature,
    ]);
    const done = reopenWithDefaults(old);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Applied);
    expect(parentAt(done.project!, 'F', 1300)).toBeNull();
    expect(parentAt(done.project!, 'a', 1300)).toBe('F');
    expect(parentAt(done.project!, 'F', 1500)).toBeUndefined();
  });

  it('古いファイル: その年に居ない親を指す子は、既定で「親が居ない年の間だけ最上位」（ほかの年の所属は残る）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const b = leafTile('b', 10, 0, 10, 10, 'F');
    const old = project([
      { featureId: fid('F'), series: { entries: [{ anchor: anchorOf('anchor-F-1200', [aggregate('F', ['a', 'b'])], []), start: y(1200), end: null }] } },
      { featureId: fid('a'), series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: y(1100), end: null }] } },
      { featureId: fid('b'), series: { entries: [{ anchor: anchorOf('anchor-b', [b.feature], b.vertices), start: y(1200), end: null }] } },
    ]);
    const inc = checkConsistency(old, CAL).inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.TreeTopology && i.detail === 'dangling-parent',
    )!;
    expect(repairOptionsFor(inc)[0]?.id).toBe(REPAIR_OPTION.DetachToTopLevelWithin);
    const done = reopenWithDefaults(old);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Applied);
    expect(parentAt(done.project!, 'a', 1150)).toBeNull();
    expect(parentAt(done.project!, 'a', 1300)).toBe('F');
  });

  it('一度も子を持たない集約地物は、区間の修復では消さない（未解決のまま次の方法を選ぶ。締め C）', () => {
    const lonely = project([
      { featureId: fid('L'), series: { entries: [{ anchor: anchorOf('anchor-L', [aggregate('L', [])], []), start: y(1000), end: null }] } },
    ]);
    const done = reopenWithDefaults(lonely);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Unresolved);
    expect(parentAt(done.project!, 'L', 1500)).toBeNull();
  });

  it('4 回目 #3: 区間の修復は、集約地物の錨に居る子でない居候の記録を道連れにしない（切る前に起こす）', () => {
    // F の錨: 1000 年 {F{a,b}, a<F>, b<F>}（1300 年で終わり）と、1500 年 {F{}, a, b}（a・b は F の子ではない居候）。
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const b = leafTile('b', 10, 0, 10, 10, 'F');
    const aTop = leafTile('a', 0, 0, 10, 10);
    const bTop = leafTile('b', 10, 0, 10, 10);
    const old = project([
      {
        featureId: fid('F'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-F-1000', [aggregate('F', ['a', 'b']), a.feature, b.feature], [...a.vertices, ...b.vertices]), start: y(1000), end: y(1300) },
            { anchor: anchorOf('anchor-F-1500', [aggregate('F', []), aTop.feature, bTop.feature], [...aTop.vertices, ...bTop.vertices]), start: y(1500), end: null },
          ],
        },
      },
    ]);
    const done = reopenWithDefaults(old);
    expect(done.outcome).toBe(REPAIR_OUTCOME.Applied);
    const p = done.project!;
    expect(parentAt(p, 'a', 1200)).toBe('F');
    expect(parentAt(p, 'a', 1550)).toBeNull();
    expect(parentAt(p, 'b', 3000)).toBeNull();
    expect(parentAt(p, 'F', 1550)).toBeUndefined();
    expect(parentAt(p, 'F', 1200)).toBeNull();
  });
});
