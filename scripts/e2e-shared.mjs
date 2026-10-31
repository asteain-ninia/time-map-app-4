// E2E を起動の使い回しで走らせる（npm run e2e:shared）。既定の `npm run e2e` は変えていない。
//
//   npm run e2e:shared                          main を使い回しで全件
//   npm run e2e:shared -- --seed=101            ファイルの順番を乱数で変えて全件
//   npm run e2e:shared -- e2e/view-mode.spec.ts 指定があれば playwright へそのまま渡す
//
// 仕組みと見逃す範囲は docs/開発ガイド.md §1.12、本体は e2e/shared-launch.ts。
// 終わると、使い回した回数と、起動し直しの原因になった残すものを出す。
// 記録の全部は test-results/shared-launch-log.jsonl（E2E_LAUNCH_LOG で変えられる）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logPath = process.env['E2E_LAUNCH_LOG'] ?? join(root, 'test-results', 'shared-launch-log.jsonl');

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const passThrough = args.filter((a) => a !== seedArg);
if (!passThrough.some((a) => a.startsWith('--project'))) passThrough.unshift('--project=main');

const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const env = { ...process.env, E2E_LAUNCH_MODE: 'shared' };
const entry = seedArg === undefined ? cli : join(root, 'scripts', 'e2e-shuffled-cli.mjs');
if (seedArg !== undefined) {
  env['E2E_SHUFFLE_SEED'] = seedArg.slice('--seed='.length);
  env['E2E_PLAYWRIGHT_CLI'] = cli;
}

const result = spawnSync(process.execPath, [entry, 'test', ...passThrough], { cwd: root, env, stdio: 'inherit' });

if (existsSync(logPath)) {
  const records = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
  const launches = records.filter((r) => r.ev === 'launch');
  const leavers = records.filter((r) => r.ev === 'checkin' && Object.keys(r.left).length > 0);
  const reused = launches.filter((r) => r.kind === 'reused').length;
  console.log(`\n[起動の使い回し] 使い回し ${String(reused)} 回 / 起動 ${String(launches.length - reused)} 回 / 記録 ${logPath}`);
  const byKey = new Map();
  for (const record of leavers) {
    for (const key of Object.keys(record.left)) {
      const group = key.replace(/\.\d+\..*$/, '').replace(/^(driver\.\w+)\..*$/, '$1');
      byKey.set(group, (byKey.get(group) ?? 0) + 1);
    }
  }
  for (const [key, count] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(count)} 本が残した: ${key}`);
  }
}

process.exit(result.status ?? 1);
