// 画面の文言の目録を書き出す（`npm run ui-text:catalog -- --out <出力先>`）。
//
// 核は `ui-text-catalog.ts`。ここはファイルを読み、表を実際に読み込み（vite-node なので .ts を
// そのまま import できる）、`catalog.json` と `catalog.md` を書くだけ。出力先の既定は
// リポジトリの外（OS の一時ディレクトリの `gimoza-ui-text`）。
//
// 引数: --out <ディレクトリ>

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCatalog, renderCatalogMarkdown, type SourceFile } from './ui-text-catalog';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const outDir = resolve(argValue('--out') ?? join(tmpdir(), 'gimoza-ui-text'));
const files: SourceFile[] = [...walk(join(repoRoot, 'src')), ...walk(join(repoRoot, 'e2e'))].map((abs) => ({
  path: relative(repoRoot, abs).split(sep).join('/'),
  text: readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'),
}));
let commit: string | undefined;
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
} catch {
  commit = undefined;
}
const catalog = await buildCatalog({
  files,
  loadModule: async (path) => (await import(pathToFileURL(join(repoRoot, path)).href)) as Record<string, unknown>,
  generatedAt: new Date().toISOString(),
  ...(commit === undefined ? {} : { commit }),
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 1)}\n`);
writeFileSync(join(outDir, 'catalog.md'), renderCatalogMarkdown(catalog));
console.log(JSON.stringify(catalog.summary));
console.log(`書き出し先: ${outDir}`);
if (catalog.loadErrors.length > 0) {
  console.error(`読み込めなかった表: ${catalog.loadErrors.map((e) => e.file).join(', ')}`);
  process.exitCode = 1;
}
