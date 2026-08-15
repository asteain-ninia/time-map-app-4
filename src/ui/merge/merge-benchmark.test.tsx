// REAL-DATA merge-flow benchmark for the derle world map (A5 — 実機報告「結合が重たい」).
//
// PURPOSE: the間引かない実データ `derle-world-full.gimoza`（722 地物・共有頂点 99,314）で
// ユーザーが「地物の結合(merge)操作が重たい」と報告した。結合フロー全体
// (buildMergeProposal → applyMergeProposal → 整合性検証(spatial) → undo command 生成) の
// どの層が支配的かを実測で確定するため、UI(React) を起動せず純 TS 層でホットスポットを
// 計測する。比較用に間引き版 `derle-world.gimoza`（16,546）も同じ計測にかける。
//
// STYLE (既存 derle-benchmark.test.ts の流儀を踏襲): 壁時計を CI で ASSERT しない
// (マシン依存)。performance.now() で各項目ウォームアップ 1 + 計測 3 回の中央値を
// console.log する。数値そのものが成果物 (親エージェントが生データとして扱う)。
//
// CI SAFETY: .gimoza のパスは環境変数 `DERLE_TMAP_DIR` から読み、未設定/欠落なら test.skip
// (CI で赤にならない・通常 `npm run test` に本ベンチが混入しない)。実行例:
//   DERLE_TMAP_DIR=C:/!WORKSPACE/time-map-app/derle-import \
//     npx vitest run src/ui/merge/merge-benchmark.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTmap } from '../../shell/io/tmap';
import {
  isParsed,
  manifestToProject,
  parseManifest,
  type DomainProject,
} from '../../domain/persistence';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import { buildForest, directChildIds } from '../../domain/hierarchy/forest';
import {
  FEATURE_KIND,
  pruneVertexStore,
  referencedVertexIds,
  type Feature,
  type LeafFeature,
} from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../../domain/ids';
import {
  MERGE_STATUS,
  buildMergeProposal,
  parentNone,
  propertyInherit,
  toMergeEditProposal,
  type MergeIdPorts,
  type MergeProposal,
} from '../../domain/merge/index';
import { applyMergeProposal } from '../../domain/editing/apply-proposal';
import {
  createTerminalShapeCache,
  detectTerminalOverlaps,
  extractTerminalShapes,
} from '../../domain/spatial/index';
import { PROCESS_STATUS } from '../../domain/consistency/index';
import { createLiveMergeBinding } from '../consistency-binding';
import { featuresAt, verticesAt, clearLiveLookupCache } from '../live-lookup';

// ---------------------------------------------------------------------------
// Fixtures / knobs
// ---------------------------------------------------------------------------

const TMAP_DIR = process.env.DERLE_TMAP_DIR;

const CASES = [
  { key: 'full', file: 'derle-world-full.gimoza', note: '99,314 shared vertices' },
  { key: 'simplified', file: 'derle-world.gimoza', note: '16,546 shared vertices' },
] as const;

/** All derle features are present at every time (verified in derle-benchmark). */
const TIME: TimePoint = timePointYear(1000);

// ---------------------------------------------------------------------------
// Measurement helpers (performance.now, warmup 1 + N runs, median)
// ---------------------------------------------------------------------------

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return NaN;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface BenchOptions {
  readonly runs?: number;
  readonly warmup?: number;
  readonly before?: () => void;
}

function bench(fn: () => void, opts: BenchOptions = {}): number {
  const runs = opts.runs ?? 5;
  const warmup = opts.warmup ?? 1;
  for (let i = 0; i < warmup; i += 1) {
    opts.before?.();
    fn();
  }
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    opts.before?.();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}

// Reporting ------------------------------------------------------------------

const rows: string[] = [];
function row(label: string, ms: number, extra = ''): void {
  rows.push(`  ${label.padEnd(52)} ${ms.toFixed(3).padStart(10)} ms  ${extra}`);
}
function section(title: string): void {
  rows.push('');
  rows.push(`  -- ${title} --`);
}

/** Deterministic monotonic id minter (unique prefix so it never collides with loaded ids). */
function makeIdPorts(prefix: string): MergeIdPorts {
  let f = 0;
  let v = 0;
  let r = 0;
  return {
    nextFeatureId: (): FeatureId => asFeatureId(`${prefix}-f${f++}`),
    nextVertexId: (): VertexId => asVertexId(`${prefix}-v${v++}`),
    nextRingId: (): RingId => asRingId(`${prefix}-r${r++}`),
  };
}

/** Count the vertices a leaf feature references. */
function leafVertexCount(f: LeafFeature): number {
  let n = 0;
  for (const ring of f.shape.rings) n += ring.vertexIds.length;
  return n;
}

interface Pair {
  readonly a: FeatureId;
  readonly b: FeatureId;
  readonly note: string;
  readonly combinedVertices: number;
}

/**
 * Pick a realistic HEAVY leaf-only merge pair. Prefer two sibling leaves under a
 * common aggregate (geographically adjacent ⇒ real union clipping work); fall back
 * to the two largest leaves overall. Returns the first candidate that yields a
 * non-rejected proposal, preferring the largest combined boundary.
 */
function pickMergePair(features: readonly Feature[]): Pair | undefined {
  const forest = buildForest(features);
  const leaves = features.filter((f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf);
  const vcount = new Map<FeatureId, number>();
  for (const l of leaves) vcount.set(l.id, leafVertexCount(l));

  const candidates: Pair[] = [];

  // Sibling leaf pairs (same parent aggregate ⇒ likely adjacent).
  for (const f of features) {
    if (f.kind !== FEATURE_KIND.Aggregate) continue;
    const childLeaves = directChildIds(forest, f.id).filter(
      (id) => forest.byId.get(id)?.kind === FEATURE_KIND.Leaf,
    );
    // The two child leaves with the largest combined boundary.
    const sorted = [...childLeaves].sort((x, y) => (vcount.get(y) ?? 0) - (vcount.get(x) ?? 0));
    if (sorted.length >= 2) {
      const a = sorted[0]!;
      const b = sorted[1]!;
      candidates.push({
        a,
        b,
        note: `sibling leaves under ${String(f.id)}`,
        combinedVertices: (vcount.get(a) ?? 0) + (vcount.get(b) ?? 0),
      });
    }
  }

  // Two largest leaves overall (whole-map heaviest boundary).
  const byV = [...leaves].sort((x, y) => (vcount.get(y.id) ?? 0) - (vcount.get(x.id) ?? 0));
  if (byV.length >= 2) {
    candidates.push({
      a: byV[0]!.id,
      b: byV[1]!.id,
      note: 'two largest leaves overall',
      combinedVertices: (vcount.get(byV[0]!.id) ?? 0) + (vcount.get(byV[1]!.id) ?? 0),
    });
  }

  candidates.sort((x, y) => y.combinedVertices - x.combinedVertices);
  return candidates[0];
}

interface BloatAudit {
  readonly maxStored: number;
  readonly maxGap: number;
  readonly totalStored: number;
  readonly worst: string;
}

/**
 * Audit every anchor snapshot's vertex store: how many vertices it STORES vs how many
 * its features actually REFERENCE. A large gap = orphan bloat (剪定欠落). Reproduces the
 * 実機 finding (95k stored vs 16-240 referenced) and locks the fix (gap → 0).
 */
function auditSnapshotBloat(project: DomainProject): BloatAudit {
  let maxStored = 0;
  let maxGap = 0;
  let totalStored = 0;
  let worst = '(none)';
  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      const snap = entry.anchor.snapshot;
      const stored = snap.vertices.byId.size;
      const referenced = new Set<VertexId>();
      for (const f of snap.features) for (const id of referencedVertexIds(f)) referenced.add(id);
      const gap = stored - referenced.size;
      totalStored += stored;
      if (stored > maxStored) maxStored = stored;
      if (gap > maxGap) {
        maxGap = gap;
        worst = `${String(history.featureId)} (stored=${stored} referenced=${referenced.size})`;
      }
    }
  }
  return { maxStored, maxGap, totalStored, worst };
}

/** Build a valid leaf-only merge proposal for `pair`, or throw. */
function buildProposalFor(
  project: DomainProject,
  pair: Pair,
  ids: MergeIdPorts,
): MergeProposal {
  const features = featuresAt(project, TIME);
  const vertices = verticesAt(project, TIME);
  const result = buildMergeProposal({
    features,
    vertices,
    targetIds: [pair.a, pair.b],
    atTime: TIME.year,
    parentDecision: parentNone,
    propertyDecision: propertyInherit(pair.a),
    ids,
  });
  if (result.status !== MERGE_STATUS.Proposal) {
    throw new Error(`merge proposal rejected for ${pair.note}: ${JSON.stringify(result)}`);
  }
  return result.proposal;
}

// ---------------------------------------------------------------------------
// The per-file benchmark run
// ---------------------------------------------------------------------------

function runFile(caseKey: string, filePath: string, note: string): void {
  rows.length = 0;
  rows.push('');
  rows.push('========================================================================');
  rows.push(`[merge-bench] ${caseKey}  (${note})`);
  rows.push('========================================================================');

  clearLiveLookupCache();

  const bytes = new Uint8Array(readFileSync(filePath));
  const extracted = readTmap(bytes);
  if (!extracted.ok) throw new Error(`readTmap failed: ${extracted.message}`);
  const parsed = parseManifest(extracted.contents.manifest);
  if (!isParsed(parsed)) throw new Error('parseManifest rejected the manifest');
  const project: DomainProject = manifestToProject(parsed.manifest);
  const calendar = getCalendar(project.settings.calendarId);

  const features = featuresAt(project, TIME);
  const vertices = verticesAt(project, TIME);
  rows.push(`  features@${TIME.year}=${features.length}  unique vertices=${vertices.byId.size}  histories=${project.histories.length}`);

  const pair = pickMergePair(features);
  if (pair === undefined) throw new Error('no mergeable leaf pair found');
  rows.push(`  merge pair: ${pair.note}  combinedBoundary=${pair.combinedVertices} vertices`);

  // === 1. buildMergeProposal (domain assembly: union + reparent + prune + sync) ===
  section('1. buildMergeProposal (union / reparent / buildRemap / pruneVertexStore / syncChildIds)');
  const tBuild = bench(() => {
    const ids = makeIdPorts('mb');
    buildProposalFor(project, pair, ids);
  });
  const proposal = buildProposalFor(project, pair, makeIdPorts('mb0'));
  row('buildMergeProposal (full)', tBuild,
    `remap=${proposal.vertexRemap.size} created=${proposal.createdIds.length} deleted=${proposal.deletedIds.length} survived=${proposal.survivedTouchedIds.length}`);

  // sub-cost: pruneVertexStore over the FULL store + all after-features (the O(V) prune
  // buildMergeProposal runs once for末端のみ結合).
  const afterFeatures = proposal.nextFeatures;
  const tPrune = bench(() => pruneVertexStore(vertices, afterFeatures));
  row('  ├ pruneVertexStore(full store, all after-features)', tPrune,
    `store=${vertices.byId.size} features=${afterFeatures.length}`);

  // === 2. applyMergeProposal (snapshot → project histories: remove/rewrite/create/remap) ===
  section('2. applyMergeProposal (deleted-remove / survived-rewrite / created-history / vertexRemap over ALL histories)');
  const editProposal = toMergeEditProposal(proposal, TIME);
  const tApply = bench(() => applyMergeProposal(project, editProposal, calendar));
  const trialState = applyMergeProposal(project, editProposal, calendar);
  row('applyMergeProposal (full)', tApply, `histories=${project.histories.length}`);

  // ATTRIBUTION: same proposal but with the vertexRemap EMPTIED — step 4
  // (applyVertexRemapToHistories, the O(H×R×V) citesRemapped scan over all histories)
  // returns early on an empty remap, so this isolates steps 1-3 from step 4.
  const noRemapEP = toMergeEditProposal({ ...proposal, vertexRemap: new Map() }, TIME);
  const tApplyNoRemap = bench(() => applyMergeProposal(project, noRemapEP, calendar));
  row('  ├ applyMergeProposal WITHOUT vertexRemap (steps 1-3 only)', tApplyNoRemap,
    `⇒ step 4 (remap over ${project.histories.length} histories) ≈ ${(tApply - tApplyNoRemap).toFixed(1)} ms`);

  // === 2b. SNAPSHOT VERTEX BLOAT AUDIT (実機報告: per-feature スナップショット頂点剪定欠落) ===
  // Every anchor snapshot's vertex store must hold ONLY the vertices its features
  // reference (referencedVertexIds — the single source of truth 波7/10/11 established).
  // A snapshot storing far more than it references is orphan bloat that (a) balloons the
  // .gimoza on save and (b) is a latent VertexCoordinateDivergence hazard (第7波).
  section('2b. snapshot vertex bloat (stored vs referenced per anchor snapshot)');
  const baselineAudit = auditSnapshotBloat(project);
  const trialAudit = auditSnapshotBloat(trialState);
  rows.push(`  baseline (loaded, untouched): maxStored=${baselineAudit.maxStored} maxGap=${baselineAudit.maxGap} totalStored=${baselineAudit.totalStored}`);
  rows.push(`  AFTER merge (trial state):    maxStored=${trialAudit.maxStored} maxGap=${trialAudit.maxGap} totalStored=${trialAudit.totalStored}  worst=${trialAudit.worst}`);

  // === 3. spatial detection (整合性検証: forest → extractTerminalShapes → detectOverlaps) ===
  section('3. spatial overlap detection over the trial state (U10, the merge commit re-detects)');
  const trialFeatures = featuresAt(trialState, TIME);
  const trialVertices = verticesAt(trialState, TIME);
  clearLiveLookupCache();
  const tDetectCold = bench(() => {
    const forest = buildForest(featuresAt(trialState, TIME));
    const terminals = extractTerminalShapes(forest, verticesAt(trialState, TIME));
    detectTerminalOverlaps(terminals);
  }, { before: () => clearLiveLookupCache() });
  row('detectSpatial COLD (no cache: 722 terminal resolutions)', tDetectCold);

  // warm cache: the binding holds one long-lived TerminalShapeCache; after the first
  // commit only the touched terminals re-resolve. Pre-warm on the BASELINE, then
  // re-run on the trial (only the merged result terminal changed).
  const warmCache = createTerminalShapeCache();
  extractTerminalShapes(buildForest(features), vertices, warmCache);
  const tDetectWarm = bench(() => {
    const forest = buildForest(trialFeatures);
    const terminals = extractTerminalShapes(forest, trialVertices, warmCache);
    detectTerminalOverlaps(terminals);
  });
  row('detectSpatial WARM (cache: only touched terminals)', tDetectWarm);

  // === 4. startProcess end-to-end (the REAL merge commit via the live binding) ===
  section('4. startProcess end-to-end (applyProposal + checkTime + detectSpatial + makeCommand)');
  // Fresh binding each iteration ⇒ COLD spatial cache = first-merge-after-load cost.
  const tCommitCold = bench(() => {
    const ids = makeIdPorts('mc');
    const binding = createLiveMergeBinding({
      getRoot: () => project,
      nextVertexId: ids.nextVertexId,
      nextRingId: ids.nextRingId,
    });
    const p = buildProposalFor(project, pair, ids);
    const ep = toMergeEditProposal(p, TIME);
    const res = binding.startProcess(ep);
    // Committed OR ConflictsPending are both valid full-pipeline outcomes (both ran
    // applyProposal + checkTime + detectSpatial); only Rejected is a benchmark error.
    if (res.status === PROCESS_STATUS.Rejected) {
      throw new Error(`commit rejected: ${JSON.stringify(res)}`);
    }
  });
  const coldOutcome = (() => {
    const ids = makeIdPorts('mco');
    const binding = createLiveMergeBinding({
      getRoot: () => project,
      nextVertexId: ids.nextVertexId,
      nextRingId: ids.nextRingId,
    });
    return binding.startProcess(toMergeEditProposal(buildProposalFor(project, pair, ids), TIME)).status;
  })();
  row('FULL merge commit COLD (build + startProcess, cold cache)', tCommitCold, `outcome=${coldOutcome}`);

  // Warm binding (2nd+ merge in a session): reuse the binding so its spatial cache is warm.
  const warmIds = makeIdPorts('mw');
  const warmBinding = createLiveMergeBinding({
    getRoot: () => project,
    nextVertexId: warmIds.nextVertexId,
    nextRingId: warmIds.nextRingId,
  });
  // prime the cache once
  {
    const p = buildProposalFor(project, pair, warmIds);
    warmBinding.startProcess(toMergeEditProposal(p, TIME));
  }
  const tCommitWarm = bench(() => {
    const p = buildProposalFor(project, pair, warmIds);
    const res = warmBinding.startProcess(toMergeEditProposal(p, TIME));
    if (res.status === PROCESS_STATUS.Rejected) throw new Error('warm commit rejected');
  });
  row('FULL merge commit WARM (build + startProcess, warm cache)', tCommitWarm);

  console.log(rows.join('\n'));

  // Structural sanity so the test is a real gate (not just a printer).
  expect(features.length).toBeGreaterThan(0);
  expect(proposal.deletedIds.length).toBe(2);
  expect(referencedVertexIds).toBeTypeOf('function');
}

// ---------------------------------------------------------------------------
// Tests (one per file; skipped when the data is absent, for CI safety)
// ---------------------------------------------------------------------------

describe('derle real-data MERGE-flow benchmark (A5)', () => {
  for (const c of CASES) {
    const filePath = TMAP_DIR === undefined ? undefined : join(TMAP_DIR, c.file);
    if (filePath === undefined || !existsSync(filePath)) {
      it.skip(`${c.key}: measures buildProposal / applyProposal / detectSpatial / commit`, () => {});
      continue;
    }
    it(
      `${c.key}: measures buildProposal / applyProposal / detectSpatial / commit`,
      () => {
        runFile(c.key, filePath, c.note);
      },
      600_000,
    );
  }
});
