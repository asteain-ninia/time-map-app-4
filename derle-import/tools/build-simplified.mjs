// 間引き版 .gimoza を「整合性クリーンになるまで」自動で作り直すドライバ。
//
// 間引きは各リングを独立に動かすため、まれに穴が親をはみ出す (hole-not-contained /
// hole-crosses-parent)。どの面がそうなるかは幾何依存で事前に読めないので、
//   ビルド → アプリの整合性チェック → 失敗した面を --keep-full に追加 → 再ビルド
// を収束するまで繰り返す (失敗面だけ原型解像度に戻す = 局所的な間引き解除)。
//
// 実行: node derle-import/tools/build-simplified.mjs [--target-vertices=16500]
// 出力: derle-import/derle-world.gimoza

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

// 引数はそのまま build-tmap へ渡す (--keep-full だけは本ドライバが管理する)。
//   引数なし              → フル版 (derle-world-full.gimoza) を冗長点除去つきで
//   --target-vertices=N   → 間引き版 (derle-world.gimoza) を目標頂点数へ
//   --full                → 明示的にフル版 (既定と同じ)
const passthrough = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--keep-full') && a !== '--full');
const isSimplified = passthrough.some((a) => a.startsWith('--target-vertices'));
const target = passthrough;
const outName = isSimplified ? 'derle-world.gimoza' : 'derle-world-full.gimoza';

const run = (args) =>
  execFileSync('node', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
const runVite = (args) =>
  execFileSync('npx', ['vite-node', ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });

const keepFull = new Set();
const MAX_ROUNDS = 6;

for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const args = ['derle-import/tools/build-tmap.mjs', ...target];
  if (keepFull.size > 0) args.push(`--keep-full=${[...keepFull].join(',')}`);
  const out = run(args);
  const wrote = out.split('\n').find((l) => l.startsWith('wrote')) ?? '';
  console.log(`[round ${round}] ${wrote.trim()}`);

  const report = runVite(['derle-import/tools/diagnose-consistency.ts', outName]);
  const head = report.split('\n')[0] ?? '';
  console.log(`[round ${round}] ${head.trim()}`);
  if (head.startsWith('ok=true')) {
    console.log(`収束: ${round} ラウンド / keep-full = ${[...keepFull].join(',') || 'なし'}`);
    process.exit(0);
  }

  // 失敗した地物 id (area-NNN) を polygon id に戻して keep-full へ追加
  let added = 0;
  for (const line of report.split('\n')) {
    if (!line.startsWith('{')) continue;
    let inc;
    try {
      inc = JSON.parse(line);
    } catch {
      continue;
    }
    for (const fid of inc.featureIds ?? []) {
      const m = /^area-(\d+)$/.exec(fid);
      if (m === null) continue;
      const pid = Number(m[1]);
      if (!keepFull.has(pid)) {
        keepFull.add(pid);
        added += 1;
      }
    }
  }
  console.log(`[round ${round}] keep-full に ${added} 面を追加 (計 ${keepFull.size})`);
  if (added === 0) {
    console.error('収束せず: 新たに追加できる面がありません。');
    process.exit(1);
  }
}
console.error(`収束せず: ${MAX_ROUNDS} ラウンド上限に到達。`);
process.exit(1);
