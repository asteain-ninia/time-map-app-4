// 巡回の書き出しと文言の目録を突き合わせる（`npm run ui-text:tour-match -- …`）。
//
// 引数:
//   --catalog <catalog.json>   `npm run ui-text:catalog` が書いた目録（必須）
//   --tour <ディレクトリ>       巡回（`npm run e2e:tour`）が書いた場面の置き場（必須。`scenes/*.json`）
//   --project <.gimoza>        利用者のデータの語（地物の名前・種別・参照名・作業メモ）を拾うファイル（何本でも）
//   --out <ディレクトリ>        `match.json` と `match.md` の書き出し先（既定は --tour と同じ）
// 巡回が書いた `user-words.json`（合成データの名前など）があれば、それも利用者のデータとして取り除く。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';

import type { Catalog } from './ui-text-catalog';
import { matchTour, renderMatchMarkdown, type TourScene } from './ui-text-tour-match';

const args = process.argv.slice(2);
function values(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const v = args[i + 1];
    if (a === name && v !== undefined) out.push(v);
  });
  return out;
}
function required(name: string): string {
  const v = values(name)[0];
  if (v === undefined) {
    console.error(`${name} が要ります`);
    process.exit(2);
  }
  return v;
}

/** 地物の名前・種別・参照名・作業メモを、保存ファイルの中身から全部拾う。 */
function wordsFromProject(path: string): string[] {
  const entries = unzipSync(readFileSync(path));
  const manifest = entries['manifest.json'];
  if (manifest === undefined) return [];
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'name' || k === 'kindLabel' || k === 'referenceName' || k === 'projectName') && typeof x === 'string' && x !== '') out.add(x);
      else if ((k === 'detailDocument' || k === 'projectDescription') && typeof x === 'string') {
        for (const line of x.split('\n')) if (line.trim() !== '') out.add(line.trim());
      } else visit(x);
    }
  };
  visit(JSON.parse(strFromU8(manifest)) as unknown);
  return [...out];
}

const catalog = JSON.parse(readFileSync(resolve(required('--catalog')), 'utf8')) as Catalog;
const tourDir = resolve(required('--tour'));
const sceneDir = join(tourDir, 'scenes');
const scenes: TourScene[] = readdirSync(sceneDir)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => JSON.parse(readFileSync(join(sceneDir, n), 'utf8')) as TourScene);
const words: string[] = [];
for (const p of values('--project')) words.push(...wordsFromProject(resolve(p)));
const userWordsFile = join(tourDir, 'user-words.json');
if (existsSync(userWordsFile)) words.push(...(JSON.parse(readFileSync(userWordsFile, 'utf8')) as string[]));

const result = matchTour(catalog, scenes, words);
const outDir = resolve(values('--out')[0] ?? tourDir);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'match.json'), `${JSON.stringify(result, null, 1)}\n`);
writeFileSync(join(outDir, 'match.md'), renderMatchMarkdown(result, scenes));
console.log(JSON.stringify({ scenes: { total: result.scenes.total, ok: result.scenes.ok }, entries: result.entries, uncovered: result.uncovered.length }));
console.log(`書き出し先: ${outDir}`);
