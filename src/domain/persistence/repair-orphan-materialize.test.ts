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
//   5. 一部の年だけ自分の年表を持つ子の、その外の年の記録を捨てない（増分 7 の手直し 2 回目 /
//      反証 #2・GPT #1）。同じ年で食い違えば自分の年表を正とし、捨てた件数を返す。
//      「中身のある記録を黙って捨てない」を性質検査でも固定する。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { anchorOf, fid, leafTile } from '../deletion/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex } from '../vertex';
import { asVertexId } from '../ids';

import { checkConsistency, INCONSISTENCY, type Inconsistency } from './consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from './fixtures';
import { resolveAt } from '../anchor-series';
import { withAttributes, type Feature } from '../feature';
import { createBasicAttributes } from '../attributes';

import { applyRepairChecked, applyRepairWithReport, repairOptionsFor, REPAIR_OPTION } from './repair';
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

/** その年に `id` が居るか（全系列のその年に効いている錨で見る）。 */
function presentAt(project: DomainProject, id: string, year: number): Feature | undefined {
  for (const h of project.histories) {
    const r = resolveAt(h.series, timePointYear(year), CAL);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === fid(id));
    if (f !== undefined) return f;
  }
  return undefined;
}

/**
 * 持ち主 O の居ない歴史の 1000 年の錨に c・d が居る。c は 1200 年からの自分の年表も持つ
 * （反証 #2 の再現の形）。`renamedOwn` なら c の自分の年表の名前が違う（同じ年で食い違う）。
 */
function partlyOwnedProject(renamedOwn = false): DomainProject {
  const c1000 = leafTile('c', 0, 0, 10, 10, 'O');
  const d1000 = leafTile('d', 10, 0, 10, 10, 'O');
  const c1200 = leafTile('c', 0, 0, 10, 10);
  const own = renamedOwn
    ? withAttributes(c1200.feature, createBasicAttributes('別の名前', 0, 1))
    : c1200.feature;
  return {
    histories: [
      {
        featureId: fid('O'),
        series: {
          entries: [
            {
              anchor: anchorOf('O-1000', [c1000.feature, d1000.feature], [...c1000.vertices, ...d1000.vertices]),
              start: timePointYear(1000),
              end: null,
            },
          ],
        },
      },
      {
        featureId: fid('c'),
        series: {
          entries: [{ anchor: anchorOf('c-1200', [own], c1200.vertices), start: timePointYear(1200), end: null }],
        },
      },
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('孤立した歴史の修復 — 一部の年だけ自分の年表を持つ子の記録を捨てない（手直し 2 回目）', () => {
  it('自分の年表が覆っていない年の記録は、自分の年表へ時刻順に足して残す', () => {
    const project = partlyOwnedProject();
    const inc = orphanInc(project);
    const applied = applyRepairWithReport(project, inc, REPAIR_OPTION.MaterializeOrphanHistory, CAL);
    expect(presentAt(applied.project, 'c', 1000)).toBeDefined();
    expect(presentAt(applied.project, 'c', 1100)).toBeDefined();
    expect(presentAt(applied.project, 'c', 1200)).toBeDefined();
    expect(presentAt(applied.project, 'd', 1000)).toBeDefined();
    const c = applied.project.histories.find((h) => h.featureId === fid('c'))!;
    expect(c.series.entries.map((e) => e.start.year)).toEqual([1000, 1200]);
    // 親だけが違う（居なくなった持ち主を指していた）記録は捨てたうちに数えない。
    expect(applied.discardedRecords).toBe(0);
    expect(checkConsistency(applied.project, CAL).inconsistencies).toEqual([]);
  });

  it('同じ年で中身が食い違うなら自分の年表を正とし、捨てた件数を返す', () => {
    const project = partlyOwnedProject(true);
    const inc = orphanInc(project);
    const applied = applyRepairWithReport(project, inc, REPAIR_OPTION.MaterializeOrphanHistory, CAL);
    expect(presentAt(applied.project, 'c', 1100)?.attributes.name).toBe('leaf-c');
    expect(presentAt(applied.project, 'c', 1200)?.attributes.name).toBe('別の名前');
    expect(applied.discardedRecords).toBe(1);
  });

  it('性質: 孤立した歴史の居候は、修復のあとも居た年に居る（自分の年表の有無・範囲によらない）', () => {
    // 居候 c0..c3 が孤立した歴史の錨（年 starts）に居る。各居候は、ランダムな年から始まる
    // 自分の年表を持つことも持たないこともある。既定の修復のあと、孤立した歴史に居た
    // すべての年で、その居候がどこかに居ることを確かめる。
    const arb = fc.record({
      starts: fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 4 }),
      own: fc.array(fc.option(fc.integer({ min: 0, max: 25 }), { nil: undefined }), { minLength: 4, maxLength: 4 }),
    });
    fc.assert(
      fc.property(arb, ({ starts, own }) => {
        const years = [...starts].sort((a, b) => a - b).map((n) => 1000 + n * 10);
        const tiles = [0, 1, 2, 3].map((i) => leafTile(`c${String(i)}`, i * 10, 0, 10, 10, 'O'));
        const histories: FeatureHistory[] = [
          {
            featureId: fid('O'),
            series: {
              entries: years.map((year) => ({
                anchor: anchorOf(`O-${String(year)}`, tiles.map((t) => t.feature), tiles.flatMap((t) => t.vertices)),
                start: timePointYear(year),
                end: null,
              })),
            },
          },
        ];
        own.forEach((n, i) => {
          if (n === undefined) return;
          const t = leafTile(`c${String(i)}`, i * 10, 0, 10, 10);
          const year = 1000 + n * 10;
          histories.push({
            featureId: fid(`c${String(i)}`),
            series: {
              entries: [{ anchor: anchorOf(`c${String(i)}-own`, [t.feature], t.vertices), start: timePointYear(year), end: null }],
            },
          });
        });
        const project: DomainProject = { histories, settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
        const inc = orphanInc(project);
        const applied = applyRepairWithReport(project, inc, REPAIR_OPTION.MaterializeOrphanHistory, CAL);
        const sample = [...years, ...years.map((y) => y + 5), 1300];
        for (const year of sample) {
          if (year < (years[0] ?? 0)) continue;
          for (let i = 0; i < 4; i += 1) {
            if (presentAt(applied.project, `c${String(i)}`, year) === undefined) return false;
          }
        }
        return applied.project.histories.every((h) => h.featureId !== fid('O'));
      }),
      { numRuns: 200, seed: 77001 },
    );
  });
});
