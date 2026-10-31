// Playwright の CLI を、ファイルの配り順だけ乱数で並べ替えて起動する。
//
// Playwright に順番を乱す設定は無い（`--shard` は分割するだけ）。Runner の 1 行を、読み込むときに
// メモリの上で差し替える。node_modules のファイルは変えない。Playwright を更新して該当の行が
// 無くなったら、黙って並べ替えずに走るのではなく、ここで止まる。
//
// 環境変数: E2E_SHUFFLE_SEED（シード）、E2E_PLAYWRIGHT_CLI（@playwright/test の cli.js）。
// 入口は scripts/e2e-shared.mjs の --seed。

import Module, { createRequire } from 'node:module';

const NEEDLE = 'const testGroups = createTestGroups(projectSuite, testRun.config.config.workers);';
const REPLACEMENT =
  'const testGroups = globalThis.__e2eShuffleGroups(createTestGroups(projectSuite, testRun.config.config.workers));';

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function compile(content, filename) {
  const isRunner = filename.replaceAll('\\', '/').endsWith('playwright/lib/runner/index.js');
  if (!isRunner) return originalCompile.call(this, content, filename);
  if (!content.includes(NEEDLE)) {
    throw new Error(`Playwright の該当の行が見つからないので順番を変えられない: ${NEEDLE}`);
  }
  return originalCompile.call(this, content.replace(NEEDLE, REPLACEMENT), filename);
};

/** シードから同じ列を出す乱数（mulberry32）。 */
function randomFrom(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

globalThis.__e2eShuffleGroups = (groups) => {
  const seed = Number(process.env['E2E_SHUFFLE_SEED']);
  const random = randomFrom(seed);
  const shuffled = [...groups];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  console.log(`[順番] シード ${String(seed)}: ${shuffled.map((g) => g.tests[0]?.location.file.split(/[\\/]/).pop()).join(' ')}`);
  return shuffled;
};

const cli = process.env['E2E_PLAYWRIGHT_CLI'];
process.argv.splice(1, 1, cli);
createRequire(import.meta.url)(cli);
