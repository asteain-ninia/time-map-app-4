// E2E を起動の使い回しで走らせる（npm run e2e:shared）。既定の `npm run e2e` は変えていない。
//
//   npm run e2e:shared                          main を使い回しで全件
//   npm run e2e:shared -- --seed=101            ファイルの順番を乱数で変えて全件
//   npm run e2e:shared -- e2e/view-mode.spec.ts 指定があれば playwright へそのまま渡す
//
// 仕組みと見逃す範囲は docs/開発ガイド.md §1.12、本体は e2e/shared-launch.ts。
// 終わると、使い回した回数と、起動し直しの原因になった残すものを出す。
// 閉じ忘れと終了の失敗が 1 件でもあれば、検査が全部緑でも終了コードを非 0 にする。
// 記録の全部は test-results/shared-launch-log.jsonl（E2E_LAUNCH_LOG で変えられる）。

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitCodeFor, summarizeLaunchLog } from './e2e-shared-summary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logPath = process.env['E2E_LAUNCH_LOG'] ?? join(root, 'test-results', 'shared-launch-log.jsonl');

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const passThrough = args.filter((a) => a !== seedArg);
if (!passThrough.some((a) => a.startsWith('--project'))) passThrough.unshift('--project=main');

const cli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const runId = randomUUID();
const env = { ...process.env, E2E_LAUNCH_MODE: 'shared', E2E_LAUNCH_RUN: runId };
const entry = seedArg === undefined ? cli : join(root, 'scripts', 'e2e-shuffled-cli.mjs');
if (seedArg !== undefined) {
  env['E2E_SHUFFLE_SEED'] = seedArg.slice('--seed='.length);
  env['E2E_PLAYWRIGHT_CLI'] = cli;
}

const result = spawnSync(process.execPath, [entry, 'test', ...passThrough], { cwd: root, env, stdio: 'inherit' });

let problemCount = 0;
if (existsSync(logPath)) {
  const summary = summarizeLaunchLog(readFileSync(logPath, 'utf8'), runId);
  problemCount = summary.problemCount;
  console.log(`\n[起動の使い回し] 使い回し ${String(summary.reused)} 回 / 起動 ${String(summary.started)} 回 / 記録 ${logPath}`);
  for (const [key, count] of summary.leftByGroup.slice(0, 10)) {
    console.log(`  ${String(count)} 本が残した: ${key}`);
  }
  console.log(`[起動の使い回し] 閉じ忘れ ${String(summary.notClosed.length)} 件 / 終了の失敗 ${String(summary.closeFailed.length)} 件`);
  for (const record of summary.notClosed) console.log(`  閉じ忘れ: ${String(record.test)}`);
  for (const record of summary.closeFailed) {
    const state = record.exited === true ? (record.forced === true ? '強制的に止めた' : '止まっていた') : '止められなかった';
    console.log(`  終了の失敗（${state}）: ${String(record.owner)}: ${String(record.error)}`);
  }
}

process.exit(exitCodeFor(result.status, problemCount));
