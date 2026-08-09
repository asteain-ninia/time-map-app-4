// デーレ共和国 (agg-02) の集約形状を JSON に書き出す (実キャンバス塗り時間の計測用)。
//   npx vite-node derle-import/tools/dump-agg-shape.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readTmap } from '../../src/shell/io/tmap';
import { isParsed, manifestToProject, parseManifest } from '../../src/domain/persistence';
import { timePointYear } from '../../src/domain/time/time-point';
import { resolveDisplayFor } from '../../src/ui/map/display-resolution-cache';
import type { DisplayControlInput } from '../../src/render/display-pipeline';

const bytes = new Uint8Array(readFileSync(resolve('derle-import', 'derle-world-full.tmap')));
const r = readTmap(bytes);
if (!r.ok) throw new Error(r.message);
const parsed = parseManifest(r.contents.manifest);
if (!isParsed(parsed)) throw new Error('parse failed');
const project = manifestToProject(parsed.manifest);

const CTL: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
const res = resolveDisplayFor(project, timePointYear(1000), CTL);

const out: { id: string; points: number; rings: number[][][] }[] = [];
for (const s of res.resolved.shapes) {
  let points = 0;
  for (const poly of s.shape) for (const ring of poly) points += ring.length;
  out.push({
    id: String(s.featureId),
    points,
    rings: s.shape.map((poly) => poly.map((ring) => ring.flat())) as unknown as number[][][],
  });
}
out.sort((a, b) => b.points - a.points);
console.log('頂点数の多い描画領域 上位5件:');
for (const o of out.slice(0, 5)) console.log(`  ${o.id}: ${o.points} 点`);

const top = out.slice(0, 3);
writeFileSync(
  resolve('derle-import', 'agg-shapes.json'),
  JSON.stringify(top.map((t) => ({ id: t.id, points: t.points, rings: t.rings }))),
);
console.log(`wrote agg-shapes.json (上位3件)`);
