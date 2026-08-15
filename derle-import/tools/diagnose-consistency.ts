// 生成 .gimoza の checkConsistency 不整合の詳細を出力する (vite-node で実行)。
//   npx vite-node derle-import/tools/diagnose-consistency.ts -- derle-world-full.gimoza

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readTmap } from '../../src/shell/io/tmap';
import {
  checkConsistency,
  isParsed,
  manifestToProject,
  parseManifest,
} from '../../src/domain/persistence';
import { getCalendar } from '../../src/domain/time/calendar';

const name = process.argv[2] ?? 'derle-world-full.gimoza';
const bytes = new Uint8Array(readFileSync(resolve('derle-import', name)));

const r = readTmap(bytes);
if (!r.ok) throw new Error(r.message);
const parsed = parseManifest(r.contents.manifest);
if (!isParsed(parsed)) {
  console.log(JSON.stringify(parsed, null, 2).slice(0, 4000));
  throw new Error('parseManifest rejected');
}
const project = manifestToProject(parsed.manifest);
const report = checkConsistency(project, getCalendar(project.settings.calendarId));
console.log(`ok=${report.ok} count=${report.inconsistencies.length}`);
for (const inc of report.inconsistencies) {
  console.log(JSON.stringify(inc));
}
