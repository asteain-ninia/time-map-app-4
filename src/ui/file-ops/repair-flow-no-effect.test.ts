// 修復の板の既定（各行の先頭）に、効かない方法を出さない（現状.md B79）。
//
//   1. 一度も子を持たない集約地物では「子の居ない年の間だけ無くす」は何もできない。これが先頭だと、
//      何も触らずに押すと「解消できませんでした」になる。
//   2. 1 回目で解消しなかった板が出直すとき、いま効かなかった方法をまた既定にしない
//      （2 回目も同じ結果になり、読み込みが止まる）。
//   3. どちらの場合も、捨てる方法を既定に繰り上げない（所有者の裁定「削除以外でデータが勝手に
//      消えるのは良くない」・B91）。
//
//   npx vitest run src/ui/file-ops/repair-flow-no-effect.test.ts

import { describe, expect, it, vi } from 'vitest';

import { aggregate, anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import { HIERARCHY_VIOLATION } from '../../domain/hierarchy/validate';
import {
  INCONSISTENCY,
  PARSE_OUTCOME,
  REPAIR_OPTION,
  checkConsistency,
  manifestToProject,
  parseManifest,
  serialize,
  type DomainProject,
  type Inconsistency,
} from '../../domain/persistence/index';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../../domain/persistence/fixtures';
import type { FeatureHistory } from '../../domain/persistence/serialize';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';

import { dropLoadCommand, type FileCommandPorts } from './file-commands';
import {
  REPAIR_OUTCOME,
  applyChosenRepairs,
  buildRepairRows,
  defaultRepairChoices,
} from './repair-flow';

const CAL = getCalendar('gregorian');
const y = timePointYear;

function project(histories: readonly FeatureHistory[]): DomainProject {
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

function reopen(p: DomainProject): DomainProject {
  const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(p))) as unknown);
  if (parsed.outcome !== PARSE_OUTCOME.Ok) throw new Error(parsed.outcome);
  return manifestToProject(parsed.manifest);
}

/** 一度も子を持たない集約地物。 */
function lonely(): DomainProject {
  return project([
    {
      featureId: fid('L'),
      series: { entries: [{ anchor: anchorOf('anchor-L', [aggregate('L', [])], []), start: y(1000), end: null }] },
    },
  ]);
}

/** 自分の系列では親が無いのに、別の錨の写しだけが居ない親 P を指す形（期間で外す修復は効かない）。 */
function danglingCopy(): DomainProject {
  const c = leafTile('c', 0, 0, 10, 10);
  const copy = leafTile('c', 0, 0, 10, 10, 'P');
  const x = leafTile('x', 20, 0, 10, 10);
  return project([
    {
      featureId: fid('c'),
      series: { entries: [{ anchor: anchorOf('anchor-c', [c.feature], c.vertices), start: y(1000), end: null }] },
    },
    {
      featureId: fid('x'),
      series: {
        entries: [
          {
            anchor: anchorOf('anchor-x', [x.feature, copy.feature], [...x.vertices, ...copy.vertices]),
            start: y(1000),
            end: null,
          },
        ],
      },
    },
  ]);
}

function optionIdsOf(p: DomainProject): string[][] {
  const report = checkConsistency(p, CAL);
  return buildRepairRows(report, { project: p, calendar: CAL }).map((r) => r.options.map((o) => o.id));
}

describe('効かない方法を既定にしない（B79）', () => {
  it('一度も子を持たない集約地物: 区間の修復を出さず、既定は「そのまま残す」で除外は最後', () => {
    expect(optionIdsOf(lonely())).toEqual([
      [REPAIR_OPTION.KeepEmptyAggregate, REPAIR_OPTION.DropShapeRoleFeature],
    ]);
  });

  it('板に理由の 1 行が出る', () => {
    const p = lonely();
    const rows = buildRepairRows(checkConsistency(p, CAL), { project: p, calendar: CAL });
    expect(rows[0]!.note).toBeTruthy();
  });

  it('何も触らずに押すと読み込める。記録は消えない。保存して開き直すと同じ行を聞かれるだけ', () => {
    const p = reopen(lonely());
    const rows = buildRepairRows(checkConsistency(p, CAL), { project: p, calendar: CAL });
    const applied = applyChosenRepairs(p, rows, defaultRepairChoices(rows), CAL);
    expect(applied.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (applied.outcome !== REPAIR_OUTCOME.Applied) return;
    expect(applied.project.histories.map((h) => h.featureId)).toEqual([fid('L')]);
    expect(applied.kept).toHaveLength(1);
    const again = checkConsistency(reopen(applied.project), CAL);
    expect(again.inconsistencies.map((i) => i.detail)).toEqual(['aggregate-no-children']);
  });

  it('除外を選べば、開き直して検査は何も言わない', () => {
    const p = reopen(lonely());
    const rows = buildRepairRows(checkConsistency(p, CAL), { project: p, calendar: CAL });
    const applied = applyChosenRepairs(p, rows, new Map([[0, REPAIR_OPTION.DropShapeRoleFeature]]), CAL);
    expect(applied.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (applied.outcome !== REPAIR_OUTCOME.Applied) return;
    expect(checkConsistency(reopen(applied.project), CAL).ok).toBe(true);
  });

  it('子の居た年がある集約地物では、区間の修復が先頭のまま（効くものは動かさない）', () => {
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
      {
        featureId: fid('a'),
        series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: y(1200), end: y(1400) }] },
      },
    ]);
    const row = optionIdsOf(old).find((ids) => ids.includes(REPAIR_OPTION.RemoveEmptyAggregateIntervals));
    expect(row?.[0]).toBe(REPAIR_OPTION.RemoveEmptyAggregateIntervals);
  });

  it('期間で親を外す修復が効かない形: 全部の年で外す方法が先頭になる', () => {
    const p = danglingCopy();
    const rows = buildRepairRows(checkConsistency(p, CAL), { project: p, calendar: CAL });
    const row = rows.find((r) => r.inconsistency.detail === HIERARCHY_VIOLATION.DanglingParent);
    expect(row?.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.DetachToTopLevel,
      REPAIR_OPTION.DropTopologyFeature,
    ]);
  });
});

describe('出直した板で、いま効かなかった方法を既定にしない（B79）', () => {
  const inc = (detail: string): Inconsistency => ({
    kind: INCONSISTENCY.TreeTopology,
    featureIds: [fid('c')],
    featureNames: [],
    detail,
  });

  it('前回選んだ方法は先頭から外れ、次の方法が既定になる。理由の 1 行が出る', () => {
    const target = inc(HIERARCHY_VIOLATION.ChildParentMismatch);
    const rows = buildRepairRows(
      { ok: false, inconsistencies: [target] },
      {
        project: project([]),
        calendar: CAL,
        tried: [{ inconsistency: target, optionId: REPAIR_OPTION.ReconcileChildIds }],
      },
    );
    expect(rows[0]!.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.DetachToTopLevel,
      REPAIR_OPTION.ReconcileChildIds,
      REPAIR_OPTION.DropTopologyFeature,
    ]);
    expect(rows[0]!.note).toBeTruthy();
  });

  it('残りが捨てる方法だけなら、捨てる方法を既定に繰り上げない。理由の 1 行で別の方法を促す', () => {
    const target = inc(HIERARCHY_VIOLATION.TopLevelMismatch);
    const rows = buildRepairRows(
      { ok: false, inconsistencies: [target] },
      {
        project: project([]),
        calendar: CAL,
        tried: [{ inconsistency: target, optionId: REPAIR_OPTION.DetachToTopLevel }],
      },
    );
    expect(rows[0]!.options.map((o) => o.id)).toEqual([
      REPAIR_OPTION.DetachToTopLevel,
      REPAIR_OPTION.DropTopologyFeature,
    ]);
    expect(rows[0]!.note).toBeTruthy();
  });

  it('別の地物の行には効かない', () => {
    const target = inc(HIERARCHY_VIOLATION.ChildParentMismatch);
    const other: Inconsistency = { ...target, featureIds: [fid('d')] };
    const rows = buildRepairRows(
      { ok: false, inconsistencies: [other] },
      {
        project: project([]),
        calendar: CAL,
        tried: [{ inconsistency: target, optionId: REPAIR_OPTION.ReconcileChildIds }],
      },
    );
    expect(rows[0]!.options[0]!.id).toBe(REPAIR_OPTION.ReconcileChildIds);
    expect(rows[0]!.note).toBeUndefined();
  });

  it('読み込みの流れは、1 回目に選んだ方法を出直しの板へ渡す', async () => {
    const p = lonely();
    const seen: unknown[][] = [];
    const promptRepair = vi.fn((...args: unknown[]) => {
      seen.push(args);
      // 1 回目は（板には出ない）効かない方法を押した形。2 回目はやめる。
      return Promise.resolve(
        seen.length === 1 ? new Map([[0, REPAIR_OPTION.RemoveEmptyAggregateIntervals]]) : null,
      );
    });
    const ports = {
      guard: { isDirty: () => false, confirmUnsaved: vi.fn(), save: vi.fn() },
      loadDropped: () =>
        Promise.resolve({ ok: true, path: 'x.gimoza', parse: { outcome: PARSE_OUTCOME.Ok, manifest: {} } }),
      toProject: () => p,
      checkConsistency,
      calendar: CAL,
      promptRepair,
      reflectProject: vi.fn(),
      notify: vi.fn(),
    } as unknown as FileCommandPorts;
    await dropLoadCommand(ports, 'x.gimoza');
    expect(promptRepair).toHaveBeenCalledTimes(2);
    const tried = seen[1]![3] as readonly { readonly optionId: string }[];
    expect(tried.map((t) => t.optionId)).toEqual([REPAIR_OPTION.RemoveEmptyAggregateIntervals]);
  });
});
