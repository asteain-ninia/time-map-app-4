// 読み込みの修復の既定「各地物に自分の年表を作って残す」（所有者の裁定 2026-09-07）の検査。
//
// 固定すること:
//   1. 孤立した歴史（持ち主が全部の錨に居ない）への修復の既定は「起こして残す」で、
//      「捨てる」は 2 番目（最後の手段）。
//   2. 既定を当てると中の地物は 1 件も失われず、各自の系列を持ち、消えた親を指さない。
//   3. 起こした系列は写し元の歴史の位置に置かれる（末尾へ足さない ―― 並びが変わると
//      頂点の勝ち負けが入れ替わり、修復が不動点へ収束しなくなる）。
//   4. 食い違う頂点を揃える修復は、どの地物も使っていない紛れ込みの版ではなく、
//      地物が実際に使っている版を正とする。

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { anchorOf, fid, leafTile } from '../deletion/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex } from '../vertex';
import { asVertexId } from '../ids';

import { checkConsistency, INCONSISTENCY, type Inconsistency } from './consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from './fixtures';
import { applyRepairChecked, repairOptionsFor, REPAIR_OPTION } from './repair';
import type { DomainProject, FeatureHistory } from './serialize';

const CAL = getCalendar('gregorian');

/** 持ち主 P が錨から消え、子 a・b だけが残った古いファイルの形。外に Z が居る。 */
function orphanProject(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'P');
  const b = leafTile('b', 10, 0, 10, 10, 'P');
  const z = leafTile('Z', 100, 0, 10, 10);
  const pEntries = [1000, 1200].map((year) => ({
    anchor: anchorOf(
      `anchor-P-${String(year)}`,
      [a.feature, b.feature],
      [...a.vertices, ...b.vertices],
    ),
    start: timePointYear(year),
    end: null,
  }));
  const histories: FeatureHistory[] = [
    { featureId: fid('P'), series: { entries: pEntries } },
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

function orphanInc(project: DomainProject): Inconsistency {
  const inc = checkConsistency(project, CAL).inconsistencies.find(
    (i) => i.kind === INCONSISTENCY.OrphanHistory,
  );
  if (inc === undefined) throw new Error('orphan not detected');
  return inc;
}

describe('孤立した歴史の修復 — 既定は「起こして残す」', () => {
  it('既定（1 番目）は MaterializeOrphanHistory、捨てるのは 2 番目', () => {
    const ids = repairOptionsFor(orphanInc(orphanProject())).map((o) => o.id);
    expect(ids).toEqual([
      REPAIR_OPTION.MaterializeOrphanHistory,
      REPAIR_OPTION.DropOrphanHistory,
    ]);
  });

  it('既定を当てると子は 1 件も失われず、自分の系列を持ち、消えた親を指さない', () => {
    const project = orphanProject();
    const inc = orphanInc(project);
    const defaultOption = repairOptionsFor(inc)[0]!;
    const applied = applyRepairChecked(project, inc, defaultOption.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.inconsistencies).toEqual([]);

    const owners = applied.project.histories.map((h) => h.featureId);
    expect(owners).toContain(fid('a'));
    expect(owners).toContain(fid('b'));
    expect(owners).not.toContain(fid('P'));
    for (const id of [fid('a'), fid('b')]) {
      const h = applied.project.histories.find((x) => x.featureId === id)!;
      // 全部の年の記録が写っている。
      expect(h.series.entries.map((e) => e.start)).toEqual([
        timePointYear(1000),
        timePointYear(1200),
      ]);
      for (const e of h.series.entries) {
        expect(e.anchor.snapshot.features.find((f) => f.id === id)?.parentId).toBeUndefined();
      }
    }
  });

  it('起こした系列は写し元の歴史の位置に置かれる（後ろの歴史より前）', () => {
    const project = orphanProject();
    const inc = orphanInc(project);
    const applied = applyRepairChecked(project, inc, REPAIR_OPTION.MaterializeOrphanHistory, CAL);
    expect(applied.project.histories.map((h) => h.featureId)).toEqual([
      fid('a'),
      fid('b'),
      fid('Z'),
    ]);
  });
});

describe('食い違う頂点を揃える修復 — 使われている版を正とする', () => {
  it('どの地物も使っていない紛れ込みの版が先にあっても、使われている版へ揃える', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const z = leafTile('Z', 100, 0, 10, 10);
    const shared = a.vertices[0]!;
    // Z の錨に、a の頂点と同じ id の **ずれた写し**が紛れ込んでいる（Z は使っていない）。
    const stray = createVertex(shared.id, createCoordinate(shared.coordinate.lon + 5, shared.coordinate.lat + 5));
    const project: DomainProject = {
      histories: [
        {
          featureId: fid('Z'),
          series: {
            entries: [
              {
                anchor: anchorOf('anchor-Z', [z.feature], [...z.vertices, stray]),
                start: timePointYear(0),
                end: null,
              },
            ],
          },
        },
        {
          featureId: fid('a'),
          series: {
            entries: [
              { anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: timePointYear(0), end: null },
            ],
          },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = checkConsistency(project, CAL).inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(inc).toBeDefined();
    const applied = applyRepairChecked(project, inc!, REPAIR_OPTION.ReconcileVertexCoordinate, CAL);
    expect(applied.resolved).toBe(true);
    // a が使っている座標が正になり、紛れ込みの方がそれに揃う。
    for (const h of applied.project.histories) {
      const body = h.series.entries[0]!.anchor.snapshot.vertices.byId.get(asVertexId(String(shared.id)));
      if (body !== undefined) expect(body.coordinate).toEqual(shared.coordinate);
    }
  });
});


/**
 * 持ち主の居る歴史と、同じ持ち主 id の孤立した歴史が **同時に**ある古いファイルの形
 * （実装係 1 が seed 36004 の解析で見つけた。増分 7 の手直し 項目 10）。
 *
 * 歴史は持ち主 id で引かれるので、「その id の歴史を落とす」「その id の歴史の居候を数える」
 * をそのまま書くと、**持ち主がちゃんと居る方**まで巻き込む。所有者の原則「削除以外で
 * データが勝手に消えるのは良くない」に反するので、どちらの修復も孤立した方だけを相手にする。
 */
function duplicateWithOrphanProject(): DomainProject {
  const p = leafTile('P', 0, 0, 10, 10);
  const c = leafTile('c', 20, 0, 10, 10);
  const histories: FeatureHistory[] = [
    // 持ち主 P が居る、まっとうな歴史（先に並ぶ）。
    {
      featureId: fid('P'),
      series: {
        entries: [
          { anchor: anchorOf('anchor-P-live', [p.feature], p.vertices), start: timePointYear(1000), end: null },
        ],
      },
    },
    // 同じ持ち主 id なのに P が居ない、孤立した歴史（中に c が居候している）。
    {
      featureId: fid('P'),
      series: {
        entries: [
          { anchor: anchorOf('anchor-P-orphan', [c.feature], c.vertices), start: timePointYear(1000), end: null },
        ],
      },
    },
  ];
  return { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
}

/** その地物がどこかの歴史の錨に居るか。 */
function presentAnywhere(project: DomainProject, id: string): boolean {
  return project.histories.some((h) =>
    h.series.entries.some((e) => e.anchor.snapshot.features.some((f) => f.id === fid(id))),
  );
}

describe('孤立した歴史の修復 — 持ち主の居る同じ id の歴史を巻き込まない（項目 10）', () => {
  it('「捨てる」は孤立した方だけを落とし、持ち主の居る P は残る', () => {
    const project = duplicateWithOrphanProject();
    const inc = orphanInc(project);
    const applied = applyRepairChecked(project, inc, REPAIR_OPTION.DropOrphanHistory, CAL);
    // P は地物として残る（以前は持ち主 id が一致する歴史を全部落としたので P ごと消えた）。
    expect(presentAnywhere(applied.project, 'P')).toBe(true);
    expect(applied.project.histories).toHaveLength(1);
    expect(applied.project.histories[0]!.series.entries[0]!.anchor.id).toBe(
      project.histories[0]!.series.entries[0]!.anchor.id,
    );
    // 「捨てる」を選んだのだから、孤立した方の中身（c）は落ちる ―― それがこの選択肢の意味。
    expect(presentAnywhere(applied.project, 'c')).toBe(false);
  });

  it('既定の「起こして残す」は、孤立した方の居候（c）を起こし、P も残す', () => {
    const project = duplicateWithOrphanProject();
    const inc = orphanInc(project);
    const defaultOption = repairOptionsFor(inc)[0]!;
    expect(defaultOption.id).toBe(REPAIR_OPTION.MaterializeOrphanHistory);
    const applied = applyRepairChecked(project, inc, defaultOption.id, CAL);
    expect(presentAnywhere(applied.project, 'P')).toBe(true);
    // c は失われず、自分の系列を持つ（以前は最初の同 id 歴史＝持ち主の居る方の居候を
    // 数えていたので、c を起こさないまま孤立した歴史ごと落としていた）。
    expect(presentAnywhere(applied.project, 'c')).toBe(true);
    expect(applied.project.histories.some((h) => h.featureId === fid('c'))).toBe(true);
  });
});
