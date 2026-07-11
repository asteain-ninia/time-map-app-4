// REAL-DATA hotspot benchmark for the derle world map (NFR 5.1 / 5.2 / 5.8).
//
// PURPOSE (次の最適化ユニットの対象決定材料): the間引かない実データ
// `derle-world-full.tmap`（722 地物・共有頂点 99,314）はアプリで実用速度が出ない、と
// 報告された。どの層が支配的かを実測で確定するため、UI(React)を起動せず純 TS 層 +
// fake-canvas でホットスポットを計測する。比較用に間引き版 `derle-world.tmap`
// （共有頂点 16,546）も同じ計測にかける。
//
// STYLE (既存ベンチ流儀の踏襲): feature-benchmark.test.ts / spatial/benchmark.test.ts と
// 同じく、壁時計 60FPS を CI で ASSERT しない（マシン依存）。performance.now() で
// 各項目ウォームアップ 1 回 + 計測 3 回の中央値を console.log する。数値そのものが
// 成果物（親エージェントが生データとして扱う）。
//
// CI SAFETY: .tmap のパスは環境変数 `DERLE_TMAP_DIR` から読み、未設定またはファイルが
// 無ければ test.skip（CI で赤にならない）。フォールバック既定値は置かない — 置くと
// このマシンでは通常の `npm run test` に本ベンチ（数分）が毎回混入する
// (Codex レビュー指摘 #6)。実行例:
//   DERLE_TMAP_DIR=C:/!WORKSPACE/time-map-app/derle-import npx vitest run src/ui/map/derle-benchmark.test.ts
//
// PLACEMENT: このベンチはアプリが実際に走らせるホットスポット（committed-features /
// display-resolution-cache / live-hit-test / live-existence — すべて ui 層）を直接
// 計測する。render 層は ui を import できない（eslint import/no-restricted-paths）ので、
// render ではなく ui/map に置く（「既存ベンチの流儀に合う場所」）。プロダクションコードは
// 一切変更していない（ベンチ追加のみ）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// --- load path (shell ZIP adapter → domain parse boundary → domain reconstruct) ---
import { readTmap } from '../../shell/io/tmap';
import {
  checkConsistency,
  isParsed,
  manifestToProject,
  parseManifest,
  type DomainProject,
} from '../../domain/persistence';

// --- domain time / hierarchy / selection --------------------------------------
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import { buildForest } from '../../domain/hierarchy/forest';
import { FEATURE_KIND, type LeafFeature } from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { WorldCoordinate } from '../../domain/coordinate';
import {
  EMPTY_SELECTION,
  revalidateForTime,
  withActiveFeature,
  withVertexSet,
} from '../../domain/selection';

// --- render layer (pure): camera / transform / clip / primitives / fake canvas ---
import {
  buildDisplayAreas,
  buildFeaturePrimitives,
  Canvas2DMapRenderer,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  initialCamera,
  selectVisibleFeatures,
  worldToScreen,
  type BuildOptions,
  type Camera,
  type DisplayControlInput,
  type EvaluatedFeature,
  type ScreenPoint,
  type Viewport,
} from '../../render';
import { FakeCanvasSurface } from '../../render/fake-canvas';
import type { PresentationFor } from '../../render/display-bridge';

// --- ui hotspots the app actually runs per frame / per pointer / per tick ------
import { featuresAt, verticesAt, clearLiveLookupCache } from '../live-lookup';
import { leafAtPoint } from '../live-lookup';
import { createLiveExistenceResolver } from '../live-existence';
import {
  computeCommittedFeatures,
  clearCommittedFeaturesCache,
} from './committed-features';
import {
  resolveDisplayFor,
  clearDisplayResolutionCache,
} from './display-resolution-cache';
import { liveHitTestAt } from './live-hit-test';

// ---------------------------------------------------------------------------
// Fixtures / knobs
// ---------------------------------------------------------------------------

const TMAP_DIR = process.env.DERLE_TMAP_DIR;

const CASES = [
  { key: 'full', file: 'derle-world-full.tmap', note: '99,314 shared vertices' },
  { key: 'simplified', file: 'derle-world.tmap', note: '16,546 shared vertices' },
] as const;

/** The map surface the app measures at (matches the synthetic harness VP). */
const VIEWPORT: Viewport = { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 };

/** A representative timeline instant. (Every derle feature is present at all times,
 * verified: presence@{0,1000,…,9999} = 722, so any time resolves the whole set.) */
const TIME: TimePoint = timePointYear(1000);
/** A DIFFERENT instant, for the revalidate-on-time-change tick (genuine cache miss). */
const TIME_NEXT: TimePoint = timePointYear(2000);

/** The default display-control the store/renderer use on load (FR-42: N=0, no focus).
 * ONE object identity, reused everywhere so the shared caches hit as they do live. */
const CONTROL: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};

/** The three camera positions the task asks for (全体表示 / 中間 / 拡大). */
function cameras(): { label: string; camera: Camera }[] {
  return [
    { label: '全体表示 full', camera: initialCamera(VIEWPORT) },
    { label: '中間     mid ', camera: { centerLon: 0.2, centerLat: -0.5, zoom: 12 } },
    { label: '拡大     close', camera: { centerLon: 0.2, centerLat: -0.5, zoom: 48 } },
  ];
}

const HIT_POINTS = 100;

// ---------------------------------------------------------------------------
// Measurement helpers (performance.now, warmup 1 + 3 runs, median)
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
  /** Untimed hook run before each warmup + measured iteration (e.g. cache reset). */
  readonly before?: () => void;
}

/** Median wall-clock ms of `fn` over `runs` measured iterations after `warmup`. */
function bench(fn: () => void, opts: BenchOptions = {}): number {
  const runs = opts.runs ?? 3;
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

/** A deterministic LCG (no Math.random) so the hit-test point field is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** `n` world points spread over the data bbox (inset from the ±180/±90 edges). */
function genWorldPoints(n: number): WorldCoordinate[] {
  const rng = makeRng(0x51ade);
  const pts: WorldCoordinate[] = [];
  for (let i = 0; i < n; i += 1) {
    pts.push({ lon: rng() * 340 - 170, lat: rng() * 160 - 80 });
  }
  return pts;
}

// Reporting ------------------------------------------------------------------

const rows: string[] = [];
function row(label: string, ms: number, extra = ''): void {
  const line = `  ${label.padEnd(46)} ${ms.toFixed(2).padStart(10)} ms  ${extra}`;
  rows.push(line);
}
function section(title: string): void {
  rows.push('');
  rows.push(`  -- ${title} --`);
}

// A neutral presentation for the direct buildDisplayAreas timing (style/label/selected
// are the selection-dependent part; geometry/verdict is what we are timing here).
const BENCH_PRESENTATION: PresentationFor = () => ({
  style: { fill: '#3366cc', stroke: '#1a3366', selectedColor: '#00e5ff' },
  label: '',
  selected: false,
});

// ---------------------------------------------------------------------------
// The per-file benchmark run
// ---------------------------------------------------------------------------

function runFile(caseKey: string, filePath: string, note: string): void {
  rows.length = 0;
  rows.push('');
  rows.push(`========================================================================`);
  rows.push(`[derle-bench] ${caseKey}  (${note})`);
  rows.push(`  file: ${filePath}`);
  rows.push(`  viewport: ${VIEWPORT.widthCss}x${VIEWPORT.heightCss}  |  warmup 1 + median of 3`);
  rows.push(`========================================================================`);

  // Reset every process-local memo so the "cold" numbers are genuinely cold and one
  // file's caches never serve another's (root identity differs anyway).
  clearLiveLookupCache();
  clearDisplayResolutionCache();
  clearCommittedFeaturesCache();

  // === 1. LOAD ============================================================
  section('1. load  (readTmap → parseManifest → manifestToProject → checkConsistency)');

  const bytes = new Uint8Array(readFileSync(filePath));

  const tRead = bench(() => {
    const r = readTmap(bytes);
    if (!r.ok) throw new Error(`readTmap failed: ${r.message}`);
  });
  const extracted = readTmap(bytes);
  if (!extracted.ok) throw new Error(`readTmap failed: ${extracted.message}`);
  const rawManifest = extracted.contents.manifest;
  row('readTmap (unzip + JSON.parse manifest)', tRead);

  const tParse = bench(() => {
    const p = parseManifest(rawManifest);
    if (!isParsed(p)) throw new Error('parseManifest rejected the manifest');
  });
  const parsed = parseManifest(rawManifest);
  if (!isParsed(parsed)) throw new Error('parseManifest rejected the manifest');
  const manifest = parsed.manifest;
  row('parseManifest (Zod structural validation)', tParse);

  const tToProject = bench(() => {
    manifestToProject(manifest);
  });
  const project: DomainProject = manifestToProject(manifest);
  row('manifestToProject (deserialize)', tToProject);

  const calendar = getCalendar(project.settings.calendarId);
  const consistency = checkConsistency(project, calendar);
  const tConsistency = bench(() => {
    checkConsistency(project, calendar);
  });
  row(
    'checkConsistency (FR-106, all slices)',
    tConsistency,
    `report.ok=${consistency.ok} inconsistencies=${consistency.inconsistencies.length}`,
  );

  const featureCount = featuresAt(project, TIME).length;
  const vertexCount = verticesAt(project, TIME).byId.size;
  rows.push(
    `  (resolved @${TIME.year}: features=${featureCount}, unique vertices=${vertexCount})`,
  );

  // === 2. DISPLAY RESOLUTION (buildDisplayAreas 相当) =====================
  section('2. display resolution  (featuresAt/verticesAt → forest → U34 shapes)');

  // Pre-resolved forest + store (for the isolated U34 geometry/bridge timing).
  const featsForForest = featuresAt(project, TIME);
  const storeForForest = verticesAt(project, TIME);
  const areaFeatures = featsForForest.filter(
    (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
  );

  const tForest = bench(() => {
    buildForest(areaFeatures);
  });
  row('buildForest (over area features)', tForest);

  const tBuildDisplayAreas = bench(() => {
    const forest = buildForest(areaFeatures);
    buildDisplayAreas(forest, storeForForest, CONTROL, BENCH_PRESENTATION);
  });
  const drawnAreas = buildDisplayAreas(
    buildForest(areaFeatures),
    storeForForest,
    CONTROL,
    BENCH_PRESENTATION,
  ).length;
  row(
    'buildDisplayAreas (U34 resolve + U19 bridge)',
    tBuildDisplayAreas,
    `areas=${drawnAreas}`,
  );

  // End-to-end 初回 (cold): clear BOTH the display memo and the live-lookup memo so
  // the resolveAt sweep + vertex-store build are included, exactly like the first
  // frame after a load / time change.
  const tDisplayCold = bench(() => resolveDisplayFor(project, TIME, CONTROL), {
    before: () => {
      clearDisplayResolutionCache();
      clearLiveLookupCache();
    },
  });
  row('display resolution 初回 (cold, full pipeline)', tDisplayCold);

  // 2回目 (memoized): warm, then the shared (root,time,control) cache HIT — the cost a
  // pointerdown / camera-only frame pays after the frame that just drew.
  resolveDisplayFor(project, TIME, CONTROL);
  const tDisplayHit = bench(() => resolveDisplayFor(project, TIME, CONTROL));
  row('display resolution 2回目 (memoized hit)', tDisplayHit);

  // === 3. RENDER (per camera; selectVisible vs draw body split) ==========
  section('3. render  (fake-canvas 1-frame CPU: clip / build / draw)  clip+LOD on');

  // The committed feature draw set (areas via U34 + points/lines). resolveDisplayFor is
  // warm, so this isolates the presentation + bridge build cost.
  clearCommittedFeaturesCache();
  resolveDisplayFor(project, TIME, CONTROL);
  const tCommitBuild = bench(() =>
    computeCommittedFeatures(project, TIME, null, CONTROL),
  );
  const features: EvaluatedFeature[] = computeCommittedFeatures(
    project,
    TIME,
    null,
    CONTROL,
  );
  row('committed EvaluatedFeature[] build', tCommitBuild, `features=${features.length}`);

  for (const { label, camera } of cameras()) {
    const opts: BuildOptions = {
      camera,
      viewport: VIEWPORT,
      sizes: DEFAULT_SCREEN_SIZES,
      thresholds: DEFAULT_LABEL_THRESHOLDS,
      clip: true,
      lod: true,
    };

    const visible = selectVisibleFeatures(
      features,
      camera,
      VIEWPORT,
      DEFAULT_SCREEN_SIZES,
      true,
    );
    const tSelect = bench(() =>
      selectVisibleFeatures(features, camera, VIEWPORT, DEFAULT_SCREEN_SIZES, true),
    );

    const prims = buildFeaturePrimitives(features, opts);
    const tBuild = bench(() => buildFeaturePrimitives(features, opts));

    const surface = new FakeCanvasSurface();
    const renderer = new Canvas2DMapRenderer(surface, { camera, viewport: VIEWPORT });
    const tDraw = bench(() => renderer.drawBatch({ primitives: prims }));

    const tFrame = bench(() => {
      const p = buildFeaturePrimitives(features, opts);
      renderer.drawBatch({ primitives: p });
    });

    rows.push(`  [${label}]  visible=${visible.length}  primitives=${prims.length}`);
    row('  selectVisibleFeatures (view clip)', tSelect);
    row('  buildFeaturePrimitives (clip+LOD+emit)', tBuild);
    row('  drawBatch (rasterize → fake canvas)', tDraw);
    row('  frame total (build + draw)', tFrame);
  }

  // === 4. HIT TESTING (100 scattered points, full-world camera) ==========
  section('4. hit testing  (100 points on the full-world view)');

  const hitCamera = initialCamera(VIEWPORT);
  const pts = genWorldPoints(HIT_POINTS);
  // Warm the shared resolutions the app has warm at pointer-time.
  featuresAt(project, TIME);
  verticesAt(project, TIME);
  resolveDisplayFor(project, TIME, CONTROL);

  const tLeafAll = bench(() => {
    for (const wp of pts) leafAtPoint(project, TIME, wp);
  });
  row('leafAtPoint x100 (knife target lookup)', tLeafAll, `= ${(tLeafAll / HIT_POINTS).toFixed(3)} ms/pt`);

  const toScreen = (w: WorldCoordinate): ScreenPoint =>
    worldToScreen(w, hitCamera, VIEWPORT);
  const tHitAll = bench(() => {
    for (const wp of pts) {
      const sp = worldToScreen(wp, hitCamera, VIEWPORT);
      liveHitTestAt(
        {
          root: project,
          time: TIME,
          displayControl: CONTROL,
          toScreen,
          wrap: { camera: hitCamera, viewport: VIEWPORT },
          point: sp,
        },
        wp,
      );
    }
  });
  row('liveHitTestAt x100 (vertex→edge→body)', tHitAll, `= ${(tHitAll / HIT_POINTS).toFixed(3)} ms/pt`);

  // === 5. TIME SYSTEM (resolveAt tick / revalidateForTime tick) ==========
  section('5. time system  (1 timeline tick)');

  // resolveAt sweep + vertex-store build for the whole project at a new time (cold).
  const tResolveTick = bench(
    () => {
      featuresAt(project, TIME);
      verticesAt(project, TIME);
    },
    { before: () => clearLiveLookupCache() },
  );
  row('resolveAt tick (featuresAt + verticesAt cold)', tResolveTick);

  // revalidateForTime with a realistic selection (active feature + a vertex set),
  // backed by the SAME live existence resolver the app injects. Clearing the lookup
  // memo before each call reproduces a genuine time change (first existence call is a
  // cold resolution, the rest are cheap membership checks).
  const firstLeaf = featuresAt(project, TIME).find(
    (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf,
  );
  if (firstLeaf === undefined) throw new Error('no leaf feature to build a selection');
  const leafVids: VertexId[] = [];
  for (const ring of firstLeaf.shape.rings) {
    for (const vid of ring.vertexIds) leafVids.push(vid);
  }
  const selVids = new Set<VertexId>(leafVids.slice(0, 200));
  const ownerId: FeatureId = firstLeaf.id;
  let selection = withActiveFeature(EMPTY_SELECTION, ownerId);
  selection = withVertexSet(selection, ownerId, selVids);
  const existence = createLiveExistenceResolver(() => project);

  const tRevalidate = bench(
    () => {
      revalidateForTime(selection, TIME_NEXT, existence);
    },
    { before: () => clearLiveLookupCache() },
  );
  row(
    'revalidateForTime (active + 200 vertices)',
    tRevalidate,
    `K≈${1 + selVids.size} existence calls`,
  );

  // Emit the whole table as ONE block (mirroring benchmark.test.ts's console reporting).
  console.log(rows.join('\n'));

  // Structural sanity so the test is a real gate (not just a printer): the pipeline
  // produced the expected 722-feature world and non-empty draw work.
  expect(featureCount).toBeGreaterThan(0);
  expect(features.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Tests (one per file; skipped when the data is absent, for CI safety)
// ---------------------------------------------------------------------------

describe('derle real-data hotspot benchmark (NFR 5.1 / 5.2)', () => {
  for (const c of CASES) {
    const filePath = TMAP_DIR === undefined ? undefined : join(TMAP_DIR, c.file);
    if (filePath === undefined || !existsSync(filePath)) {
      it.skip(`${c.key}: measures load / display / render / hit / time hotspots`, () => {});
      continue;
    }
    it(
      `${c.key}: measures load / display / render / hit / time hotspots`,
      () => {
        runFile(c.key, filePath, c.note);
      },
      600_000,
    );
  }
});
