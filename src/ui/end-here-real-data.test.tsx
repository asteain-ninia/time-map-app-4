// 実データで「まとめ役を終わらせても、子が後の年に移った別の親との所属は外れない」を固定する
// （増分 7 の手直し 2 回目。反証 #1 の実データの再現そのもの）。
//
// 正統ノル王国の州「正統ノル王国領海01」を 1700 年にハルナ君主国の下へ移し（所属変更の確定と
// 同じ道）、王国を 1500 年で終わらせる（存続期間の確定と同じ道）。直す前は 1700 年の親が
// 「なし」になり、王国が 1700 年の錨で子の居ない殻として現れ、整合検査が 3 件出ていた。
//
// 実データは `derle-import/`（または `DERLE_TMAP_DIR`）にあるときだけ読む。**読むだけ**で
// 保存はしない（正準のファイルを書き換える経路を通らない）。無ければ飛ばす。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveAt } from '../domain/anchor-series';
import { parentExisting } from '../domain/affiliation/decision';
import { planEnding } from '../domain/affiliation/interval-edit';
import { buildAffiliationProposalForTargets } from '../domain/affiliation/proposal';
import {
  applyAffiliationProposal,
  toAffiliationEditProposal,
} from '../domain/editing/apply-proposal';
import type { Feature } from '../domain/feature';
import { createIdGeneratorState } from '../domain/id-generator';
import { checkConsistency } from '../domain/persistence/consistency';
import { checkBeforeSave } from '../domain/persistence/pre-save';
import { manifestToProject, type DomainProject } from '../domain/persistence/serialize';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';
import { createVertexStore, type Vertex } from '../domain/vertex';
import { loadTmapBytes } from '../shell/io/load';

import { createAnchorIntervalCommandForRoot } from './consistency-binding';
import { buildSetEndIntent } from './property/index';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const realPath = join(dataDir, REAL_DATA_FILE);
const calendar = getCalendar('gregorian');

function load(): DomainProject {
  const res = loadTmapBytes(realPath, new Uint8Array(readFileSync(realPath)));
  if (!res.ok) throw new Error(`load failed: ${res.reason}`);
  return manifestToProject(res.manifest);
}

function at(p: DomainProject, year: number): { features: Feature[]; vertices: Vertex[] } {
  const features: Feature[] = [];
  const vertices: Vertex[] = [];
  for (const h of p.histories) {
    const r = resolveAt(h.series, timePointYear(year), calendar);
    if (r.kind !== 'present') continue;
    features.push(...r.entry.anchor.snapshot.features);
    vertices.push(...r.entry.anchor.snapshot.vertices.byId.values());
  }
  return { features, vertices };
}

describe.skipIf(!existsSync(realPath))('実データ — 王国を終わらせても、1700 年に移した州の親はハルナ君主国のまま', () => {
  it('領海01 を 1700 年にハルナ君主国へ → 王国を 1500 年で終わらせる', () => {
    const root = load();
    const w1700 = at(root, 1700);
    const king = w1700.features.find((f) => f.kind === 'aggregate' && f.attributes.name === '正統ノル王国');
    const sea = w1700.features.find((f) => f.attributes.name === '正統ノル王国領海01');
    const harna = w1700.features.find((f) => f.attributes.name === 'ハルナ君主国');
    expect(king).toBeDefined();
    expect(sea?.parentId).toBe(king?.id);
    expect(harna).toBeDefined();

    // 1700 年に領海01 をハルナ君主国の下へ（所属変更の確定と同じ道）。
    const prop = buildAffiliationProposalForTargets(w1700.features, [sea!.id], parentExisting(harna!.id), {
      idState: createIdGeneratorState(),
      now: () => 1,
      vertexStore: createVertexStore(w1700.vertices),
    });
    if (prop.status !== 'proposal') throw new Error(JSON.stringify(prop).slice(0, 300));
    const moved = applyAffiliationProposal(root, toAffiliationEditProposal(prop.proposal, timePointYear(1700)), calendar);
    expect(checkConsistency(moved, calendar).inconsistencies).toEqual([]);

    // 1500 年に王国を終わらせる（押す前の板の数え上げと、存続期間の確定）。
    const plan = planEnding(moved.histories, king!.id, timePointYear(1500), calendar);
    // 領海01 は 1500〜1700 年はまだ王国の子なので、その間は最上位になる（数える）。
    expect(plan?.promoted).toContain(sea!.id);
    expect(plan?.reappearsAt?.year).toBe(1700);
    const kingHistory = moved.histories.find((h) => h.featureId === king!.id)!;
    const effective = resolveAt(kingHistory.series, timePointYear(1500), calendar);
    if (effective.kind !== 'present') throw new Error('王国が 1500 年に居ない');
    const built = createAnchorIntervalCommandForRoot(
      moved,
      buildSetEndIntent(king!.id, effective.entry.anchor.id, timePointYear(1500)),
    );
    if (!built.ok) throw new Error(JSON.stringify(built.reason));
    const ended = built.command.execute(moved).state;

    // 1700 年の親はハルナ君主国のまま。1600 年は最上位。王国は 1700 年に子とともに再び現れる。
    expect(at(ended, 1700).features.find((f) => f.id === sea!.id)?.parentId).toBe(harna!.id);
    expect(at(ended, 1600).features.find((f) => f.id === sea!.id)?.parentId).toBeUndefined();
    expect(at(ended, 1600).features.some((f) => f.id === king!.id)).toBe(false);
    const kingAt1700 = at(ended, 1700).features.find((f) => f.id === king!.id);
    expect(kingAt1700?.kind).toBe('aggregate');
    expect(at(ended, 1700).features.some((f) => f.parentId === king!.id)).toBe(true);
    // 読み込みの検査も保存前の検査も何も言わない（開き直しで修復を聞かれない）。
    expect(checkConsistency(ended, calendar).inconsistencies).toEqual([]);
    expect(checkBeforeSave(ended, calendar)).toEqual([]);
  }, 120_000);
});
