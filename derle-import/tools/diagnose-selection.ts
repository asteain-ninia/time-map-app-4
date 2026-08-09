// 「デーレ共和国を選択すると待たされる」の内訳を実データで計測する。
//   npx vite-node derle-import/tools/diagnose-selection.ts -- derle-world-full.tmap

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readTmap } from '../../src/shell/io/tmap';
import { isParsed, manifestToProject, parseManifest } from '../../src/domain/persistence';
import { timePointYear } from '../../src/domain/time/time-point';
import { asFeatureId } from '../../src/domain/ids';
import { resolveDisplayFor } from '../../src/ui/map/display-resolution-cache';
import { computeCommittedFeatures } from '../../src/ui/map/committed-features';
import { buildFeaturePrimitives, initialCamera, DEFAULT_SCREEN_SIZES, DEFAULT_LABEL_THRESHOLDS } from '../../src/render';
import type { DisplayControlInput } from '../../src/render/display-pipeline';
import type { Viewport } from '../../src/render';

const name = process.argv[2] ?? 'derle-world-full.tmap';
const bytes = new Uint8Array(readFileSync(resolve('derle-import', name)));
const r = readTmap(bytes);
if (!r.ok) throw new Error(r.message);
const parsed = parseManifest(r.contents.manifest);
if (!isParsed(parsed)) throw new Error('parse failed');
const project = manifestToProject(parsed.manifest);

const T = timePointYear(1000);
const CTL: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
const VP: Viewport = { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 };

const ms = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const med = (fn: () => void, n = 5): number => {
  const xs: number[] = [];
  for (let i = 0; i < n; i += 1) xs.push(ms(fn));
  xs.sort((a, b) => a - b);
  return xs[Math.floor(n / 2)]!;
};

// 表示解決を温めておく (選択とは無関係の初回コストを除外)
console.log(`表示解決 (初回・選択とは無関係) : ${ms(() => resolveDisplayFor(project, T, CTL)).toFixed(0)} ms`);

const AGG = asFeatureId('agg-02'); // デーレ共和国 (集約・子63)
const LEAF = asFeatureId('area-001'); // 通常の末端地物

console.log('\n=== 選択の切り替えごとの committed 再構築 (描画入力の組み立て) ===');
console.log(`選択なし          : ${med(() => computeCommittedFeatures(project, T, null, CTL)).toFixed(1)} ms`);
console.log(`末端を選択        : ${med(() => computeCommittedFeatures(project, T, LEAF, CTL)).toFixed(1)} ms`);
console.log(`デーレ共和国を選択: ${med(() => computeCommittedFeatures(project, T, AGG, CTL)).toFixed(1)} ms`);
console.log(
  `選択を交互に切替  : ${med(() => {
    computeCommittedFeatures(project, T, AGG, CTL);
    computeCommittedFeatures(project, T, null, CTL);
  }).toFixed(1)} ms  ← クリックのたびに起きる往復`,
);

console.log('\n=== 1 フレームの描画入力生成 (全体表示) ===');
const cam = initialCamera(VP);
const opts = {
  camera: cam,
  viewport: VP,
  sizes: DEFAULT_SCREEN_SIZES,
  thresholds: DEFAULT_LABEL_THRESHOLDS,
  clip: true,
  lod: true,
};
const featsNone = computeCommittedFeatures(project, T, null, CTL);
const featsAgg = computeCommittedFeatures(project, T, AGG, CTL);
console.log(`選択なし          : ${med(() => buildFeaturePrimitives(featsNone, opts)).toFixed(1)} ms`);
console.log(`デーレ共和国を選択: ${med(() => buildFeaturePrimitives(featsAgg, opts)).toFixed(1)} ms`);
