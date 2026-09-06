// **検査そのものが走っているか**を見る検査（ビルド健全性）。
//
// `vitest.config.ts` の `include` は「どのディレクトリを見るか」を 1 本ずつ数え上げる形に
// なっている。この形は速いが **落とし穴が 1 つ**あり、増分 6 で実際に踏んだ：時刻の共有
// ロジックを `src/ui/property/` から `src/ui/time/` へ移した瞬間、`src/ui/time/**` が
// 一覧に無かったので **その 4 ファイルの検査が 1 つも走らなくなった**（赤くならず、
// ただ静かに消えた）。移した本人も「テストは緑」としか見えない。
//
// ここでは `src` の下の `*.test.ts` / `*.test.tsx` を全部数え、**どれかの include に
// 当たること**を確かめる。新しい置き場にテストを置いた人は、この 1 本が赤くなって
// 「`vitest.config.ts` に 1 行足す」ことに気づける。

import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSourceText } from './read-source-text';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..');
const configText = readSourceText(resolve(here, '../../vitest.config.ts'));

/** `include: [ ... ]` に並ぶ glob を設定ファイルそのものから読む。 */
function includeGlobs(): readonly string[] {
  const start = configText.indexOf('include: [');
  expect(start, 'vitest.config.ts に include が無い').toBeGreaterThan(-1);
  const end = configText.indexOf(']', start);
  const body = configText.slice(start, end);
  // **行そのものが 1 個の文字列である行だけ**を拾う。素朴に `'...'` を全部拾うと、
  // 英語のコメントのアポストロフィ（`vitest 2.x's`）が引用符として数えられ、対の
  // 取り方が 1 つずれて glob が丸ごと化ける（実際にここで一度そうなった）。
  return [...body.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1] ?? '');
}

/** `src` の下のテストファイルを全部集める（相対パス・`/` 区切り）。 */
function allTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      allTestFiles(full, out);
      continue;
    }
    if (!/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(`src/${relative(srcDir, full).replace(/\\/g, '/')}`);
  }
  return out;
}

/** glob（`**` と `*` だけ）を正規表現にする。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // `**/` → 「あってもなくてもよい途中の階層」、`**` → 「何でも」、`*` → 「/ 以外」。
  // 置き換えの順序が意味を持つので、いったん目印の語へ逃がしてから戻す
  // （目印は glob に現れない語にする ―― 制御文字は正規表現に直接書けない）。
  const DEEP_SLASH = '@@DEEP_SLASH@@';
  const DEEP = '@@DEEP@@';
  const body = escaped
    .split('**/')
    .join(DEEP_SLASH)
    .split('**')
    .join(DEEP)
    .split('*')
    .join('[^/]*')
    .split(DEEP_SLASH)
    .join('(?:.*/)?')
    .split(DEEP)
    .join('.*');
  return new RegExp(`^${body}$`);
}

describe('検査の取りこぼし（vitest の include）', () => {
  it('`src` の下のテストは 1 つ残らずどれかの include に当たる', () => {
    const globs = includeGlobs().map(globToRegExp);
    const missed = allTestFiles(srcDir).filter((f) => !globs.some((re) => re.test(f)));
    expect(
      missed,
      `この置き場は vitest の include に入っていない（テストが静かに走らなくなる）:\n${missed.join('\n')}`,
    ).toEqual([]);
  });

  it('include の書き方（`**` と `*`）を取り違えていない', () => {
    // 自分の道具（glob→正規表現）が正しいことを、既知の 2 例で固定しておく。
    expect(globToRegExp('src/ui/time/**/*.test.ts').test('src/ui/time/rail-fold.test.ts')).toBe(true);
    expect(globToRegExp('src/ui/**/*.test.tsx').test('src/ui/timeline/Timeline.test.tsx')).toBe(true);
    expect(globToRegExp('src/ui/time/**/*.test.ts').test('src/ui/timeline/step.test.ts')).toBe(false);
  });
});
