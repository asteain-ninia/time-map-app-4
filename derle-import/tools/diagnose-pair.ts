// area-165 / area-660 の穴構造を照合するデバッグスクリプト。
//   npx vite-node derle-import/tools/diagnose-pair.ts -- derle-world.tmap area-165 area-660

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const name = process.argv[2] ?? 'derle-world.tmap';
const idA = process.argv[3] ?? 'area-165';
const idB = process.argv[4] ?? 'area-660';

const entries = unzipSync(new Uint8Array(readFileSync(resolve('derle-import', name))));
const manifest = JSON.parse(strFromU8(entries['manifest.json']));

interface AnyFeature {
  kind: string;
  id: string;
  attributes: { name: string };
  kindLabel?: string;
  shape?: { rings: { kind: string; id: string; vertexIds: string[] }[] };
}

const features = new Map<string, AnyFeature>();
for (const h of manifest.histories) {
  for (const f of h.entries[0].anchor.snapshot.features) features.set(f.id, f);
}

const fa = features.get(idA);
const fb = features.get(idB);
if (!fa?.shape || !fb?.shape) throw new Error('not found');

const ringKey = (ids: string[]) => [...ids].sort().join(',');
const bTerr = fb.shape.rings.find((r) => r.kind === 'territory');
const bKey = ringKey(bTerr!.vertexIds);

console.log(`${idA} (${fa.attributes.name} / ${fa.kindLabel}): rings=${fa.shape.rings.length}`);
for (const r of fa.shape.rings) {
  console.log(`  ${r.kind} ${r.id} n=${r.vertexIds.length}`);
}
console.log(`${idB} (${fb.attributes.name} / ${fb.kindLabel}): rings=${fb.shape.rings.length} terr_n=${bTerr!.vertexIds.length}`);

// idB のリングを穴として持つ地物を全探索
let holder: string | null = null;
for (const [fid, f] of features) {
  if (!f.shape) continue;
  for (const r of f.shape.rings) {
    if (r.kind === 'hole' && ringKey(r.vertexIds) === bKey) holder = `${fid} (${f.attributes.name}) の ${r.id}`;
  }
}
console.log(`${idB} を穴として持つ地物: ${holder ?? 'なし!'}`);
