// 地物を消したあと、集約地物が錨の途中から子の居ない殻として残らない（B73 を閉じた根拠）。
//
// 殻が残るのは「子が出入りする年で割られていない錨」だけで、今のアプリの操作ではこの形を作らない
// （存続期間の編集・所属の変更は子の並びを揃えて錨を割る）。古いファイルのこの形は開くときに
// 「子の並びの食い違い」の修復を聞かれ、修復で割られるので、開いたあとの削除では殻が残らない。
//
//   npx vitest run src/ui/file-ops/delete-empty-aggregate-shell.test.ts
import { describe, expect, it } from 'vitest';

import { resolveAt } from '../../domain/anchor-series';
import { parentNone } from '../../domain/affiliation/decision';
import { buildAffiliationProposalForTargets } from '../../domain/affiliation/proposal';
import { deleteFeatureFromHistories } from '../../domain/deletion/bundle';
import { aggregate, anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import { applyAffiliationProposal, toAffiliationEditProposal } from '../../domain/editing/apply-proposal';
import type { Feature } from '../../domain/feature';
import { createIdGeneratorState } from '../../domain/id-generator';
import {
  PARSE_OUTCOME,
  checkConsistency,
  manifestToProject,
  parseManifest,
  serialize,
  type DomainProject,
} from '../../domain/persistence/index';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../../domain/persistence/fixtures';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore, type Vertex } from '../../domain/vertex';
import { createAnchorIntervalCommandForRoot } from '../consistency-binding';
import {
  buildChangeStartIntent,
  buildDeleteAnchorIntent,
  buildEndHereIntent,
  buildSetEndIntent,
} from '../property/index';

import { REPAIR_OUTCOME, applyChosenRepairs, buildRepairRows, defaultRepairChoices } from './repair-flow';

const CAL = getCalendar('gregorian');
const y = timePointYear;

function own(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'F');
  const b = leafTile('b', 10, 0, 10, 10, 'F');
  const c = leafTile('c', 20, 0, 10, 10, 'F');
  const e = (id: string, fs: Feature[], vs: Vertex[]) => ({
    featureId: fid(id),
    series: { entries: [{ anchor: anchorOf(`anchor-${id}`, fs, vs), start: y(1000), end: null }] },
  });
  return {
    histories: [
      e('F', [aggregate('F', ['a', 'b', 'c'])], []),
      e('a', [a.feature], a.vertices),
      e('b', [b.feature], b.vertices),
      e('c', [c.feature], c.vertices),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function resident(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'F');
  const b = leafTile('b', 10, 0, 10, 10, 'F');
  const c = leafTile('c', 20, 0, 10, 10, 'F');
  return {
    histories: [
      {
        featureId: fid('F'),
        series: {
          entries: [
            {
              anchor: anchorOf(
                'anchor-F',
                [aggregate('F', ['a', 'b', 'c']), a.feature, b.feature, c.feature],
                [...a.vertices, ...b.vertices, ...c.vertices],
              ),
              start: y(1000),
              end: null,
            },
          ],
        },
      },
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function moveOut(p: DomainProject, id: string, year: number): DomainProject | null {
  const at = y(year);
  const features: Feature[] = [];
  const vs: Vertex[] = [];
  for (const h of p.histories) {
    const r = resolveAt(h.series, at, CAL);
    if (r.kind !== 'present') continue;
    features.push(...r.entry.anchor.snapshot.features);
    vs.push(...r.entry.anchor.snapshot.vertices.byId.values());
  }
  if (!features.some((f) => f.id === fid(id))) return null;
  const result = buildAffiliationProposalForTargets(features, [fid(id)], parentNone, {
    idState: createIdGeneratorState(),
    now: () => 1,
    vertexStore: createVertexStore(vs),
  });
  if (result.status !== 'proposal') return null;
  try {
    return applyAffiliationProposal(p, toAffiliationEditProposal(result.proposal, at), CAL);
  } catch {
    return null;
  }
}

function step(p: DomainProject, rnd: () => number): { next: DomainProject; label: string } {
  const ids = ['a', 'b', 'c'];
  const id = ids[Math.floor(rnd() * ids.length)]!;
  const year = 1000 + Math.floor(rnd() * 10) * 100;
  const op = Math.floor(rnd() * 5);
  if (op === 4) {
    const next = moveOut(p, id, year);
    return next === null ? { next: p, label: 'skip' } : { next, label: `moveOut ${id} ${year}` };
  }
  const h = p.histories.find((x) => x.featureId === fid(id));
  if (h === undefined) return { next: p, label: 'skip' };
  const entry = h.series.entries[Math.floor(rnd() * h.series.entries.length)]!;
  const intent =
    op === 0
      ? buildChangeStartIntent(fid(id), entry.anchor.id, y(year))
      : op === 1
        ? buildSetEndIntent(fid(id), entry.anchor.id, y(year))
        : op === 2
          ? buildEndHereIntent(fid(id), entry.anchor.id, y(year))
          : buildDeleteAnchorIntent(fid(id), entry.anchor.id);
  const built = createAnchorIntervalCommandForRoot(p, intent);
  if (!built.ok) return { next: p, label: 'skip' };
  return { next: built.command.execute(p).state, label: `${intent.op} ${id} ${year}` };
}

function noChildRows(p: DomainProject): Set<string> {
  const out = new Set<string>();
  for (const i of checkConsistency(p, CAL).inconsistencies) {
    if (i.detail === 'aggregate-no-children') out.add(`${String(i.featureIds[0])}@${String(i.atTime?.year)}`);
  }
  return out;
}

/** 子 a が 1400 年で終わるのに、集約地物 F の錨が 1400 年で割られていない古いファイルの形。 */
function oldFile(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'F');
  const b = leafTile('b', 10, 0, 10, 10, 'F');
  return {
    histories: [
      { featureId: fid('F'), series: { entries: [{ anchor: anchorOf('anchor-F', [aggregate('F', ['a', 'b'])], []), start: y(1200), end: null }] } },
      { featureId: fid('a'), series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: y(1200), end: y(1400) }] } },
      { featureId: fid('b'), series: { entries: [{ anchor: anchorOf('anchor-b', [b.feature], b.vertices), start: y(1200), end: null }] } },
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('削除で子の居ない殻を残さない（B73）', () => {
  it('対照: 古いファイルの形をそのまま消すと、1400 年から殻が残る（この検査が殻を見分けられる）', () => {
    const p = oldFile();
    expect(noChildRows(p).size).toBe(0);
    const done = deleteFeatureFromHistories(p.histories, fid('b'), CAL)!;
    expect([...noChildRows({ ...p, histories: done.histories })]).toEqual(['F@1400']);
  });

  it('古いファイルの形も、開くときの既定の修復を通すと、消したあと殻が残らず開き直して検査が何も言わない', () => {
    const p = oldFile();
    const rows = buildRepairRows(checkConsistency(p, CAL), { project: p, calendar: CAL });
    expect(rows.length).toBeGreaterThan(0);
    const applied = applyChosenRepairs(p, rows, defaultRepairChoices(rows), CAL);
    expect(applied.outcome).toBe(REPAIR_OUTCOME.Applied);
    if (applied.outcome !== REPAIR_OUTCOME.Applied) return;
    const done = deleteFeatureFromHistories(applied.project.histories, fid('b'), CAL)!;
    const deleted: DomainProject = { ...applied.project, histories: done.histories };
    const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(deleted))) as unknown);
    if (parsed.outcome !== PARSE_OUTCOME.Ok) throw new Error(parsed.outcome);
    expect(checkConsistency(manifestToProject(parsed.manifest), CAL).inconsistencies).toEqual([]);
  });

  it.each([
    ['子が自分の系列を持つ形', own],
    ['子が集約地物の錨に居る形', resident],
  ] as const)('%s: 存続期間の編集と所属の変更を重ねたあとで消しても、殻が増えない', (_name, make) => {
    let edits = 0;
    const shells: string[] = [];
    for (let seed = 1; seed <= 300; seed += 1) {
      const rnd = mulberry(seed);
      let p = make();
      const log: string[] = [];
      const count = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < count; k += 1) {
        const s = step(p, rnd);
        p = s.next;
        if (s.label !== 'skip') {
          log.push(s.label);
          edits += 1;
        }
      }
      const before = noChildRows(p);
      for (const t of ['a', 'b', 'c']) {
        const done = deleteFeatureFromHistories(p.histories, fid(t), CAL);
        if (done === null) continue;
        const after = noChildRows({ ...p, histories: done.histories });
        if ([...after].some((k) => !before.has(k))) shells.push(`seed ${String(seed)}: ${log.join(' / ')} -> ${t}`);
      }
    }
    expect(edits).toBeGreaterThan(100); // 編集が空回りしていない
    expect(shells).toEqual([]);
  });
});
