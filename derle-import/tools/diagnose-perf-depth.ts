// 実データでの (1) 階層深度ごとの描画/選択の挙動 と (2) 表示解決のキャッシュ効きを実測する。
//   npx vite-node derle-import/tools/diagnose-perf-depth.ts -- derle-world-full.gimoza

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readTmap } from '../../src/shell/io/tmap';
import { isParsed, manifestToProject, parseManifest } from '../../src/domain/persistence';
import { timePointYear } from '../../src/domain/time/time-point';
import { resolveDisplayFor } from '../../src/ui/map/display-resolution-cache';
import { drawnAreaAt } from '../../src/ui/map/live-hit-test';
import type { DisplayControlInput } from '../../src/render/display-pipeline';

const name = process.argv[2] ?? 'derle-world-full.gimoza';
const bytes = new Uint8Array(readFileSync(resolve('derle-import', name)));
const r = readTmap(bytes);
if (!r.ok) throw new Error(r.message);
const parsed = parseManifest(r.contents.manifest);
if (!isParsed(parsed)) throw new Error('parse failed');
const project = manifestToProject(parsed.manifest);

const ms = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

const ctl = (globalDepth: number): DisplayControlInput => ({
  globalDepth,
  focus: { originId: null, depth: 0, emphasize: false },
});

const T1 = timePointYear(1000);
const T2 = timePointYear(2000);
const d0 = ctl(0);
const d1 = ctl(1);

console.log('=== 表示解決のコスト ===');
console.log(`深度0 初回      : ${ms(() => resolveDisplayFor(project, T1, d0)).toFixed(0)} ms`);
console.log(`深度0 2回目     : ${ms(() => resolveDisplayFor(project, T1, d0)).toFixed(2)} ms`);
console.log(`深度1 初回      : ${ms(() => resolveDisplayFor(project, T1, d1)).toFixed(0)} ms`);
console.log(`深度0 に戻す    : ${ms(() => resolveDisplayFor(project, T1, d0)).toFixed(2)} ms`);
console.log(`別時刻で深度0   : ${ms(() => resolveDisplayFor(project, T2, d0)).toFixed(0)} ms  ← 時刻移動`);
console.log(`同 2回目        : ${ms(() => resolveDisplayFor(project, T2, d0)).toFixed(2)} ms`);
console.log(`元の時刻へ戻す  : ${ms(() => resolveDisplayFor(project, T1, d0)).toFixed(0)} ms  ← 容量2のLRU`);

console.log('\n=== 描かれる領域の数 (= クリックで選べる対象) ===');
for (const depth of [0, 1, 2]) {
  const res = resolveDisplayFor(project, T1, ctl(depth));
  console.log(`深度${depth}: 描画領域 ${res.resolved.shapes.length} 件`);
}

console.log('\n=== 同一点のクリックで選ばれる地物 (デーレ本土の一点) ===');
const at = { lon: -87.2, lat: 24.0 } as never;
for (const depth of [0, 1]) {
  const hit = drawnAreaAt({ root: project, time: T1, displayControl: ctl(depth) }, at);
  const res = resolveDisplayFor(project, T1, ctl(depth));
  const f = hit === null ? null : res.features.find((x) => x.id === hit);
  console.log(
    `深度${depth}: ${hit ?? 'なし'} ${f ? `(${f.attributes.name} / ${f.kind})` : ''}`,
  );
}
