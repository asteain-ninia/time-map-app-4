// 文言の目録の道具（`scripts/ui-text-catalog.ts`）と、巡回との突き合わせ（`scripts/ui-text-tour-match.ts`）を
// 固定する（案/文言総点検-やり方の提案.md §6 の 3・4）。
//
// **見本の表は src/ に置かない。** 置くと規則（`scripts/ui-text-rule.mjs`）が本物の表として数え、
// 目録にも紛れ込む。だから核の関数には手で書いたソースと、手で作った「読み込んだ表」を渡す。
// 最後の 1 本だけ、本物のリポジトリで目録を作って、崩れていないこと（全部の表が載る・読み込めない表が
// 無い）を見る。

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSourceText } from '../../test-support/read-source-text';
import {
  buildCatalog,
  evaluateFunction,
  renderCatalogMarkdown,
  type Catalog,
  type SourceFile,
} from '../../../scripts/ui-text-catalog';
import { matchTour, renderMatchMarkdown, type TourScene } from '../../../scripts/ui-text-tour-match';
import { isUiTextTableFile } from '../../../scripts/ui-text-rule.mjs';

const FILES: readonly SourceFile[] = [
  {
    path: 'src/ui/foo/strings.ts',
    text: [
      'export const FOO_STRINGS = {',
      "  title: '見出し',",
      '  greet: (name: string): string => `${name}さん、ようこそ`,',
      "  pick: (on: boolean): string => (on ? '入れる' : '切る'),",
      "  unused: '使っていない文',",
      "  nested: { deep: '奥の文' },",
      '} as const;',
      "export const SAME = '見出し';",
      'export function countText(count: number): string {',
      '  return `${String(count)} 件あります`;',
      '}',
    ].join('\n'),
  },
  {
    path: 'src/ui/foo/Comp.tsx',
    text: [
      "import { FOO_STRINGS, SAME, countText } from './strings';",
      'export const a = FOO_STRINGS.title + FOO_STRINGS.greet(SAME) + FOO_STRINGS.nested.deep;',
      'export const b = FOO_STRINGS.pick(true) + countText(2);',
    ].join('\n'),
  },
  // 表を部品のファイルから再び公開し、別のディレクトリが部品のファイルから読む（増分の下準備 その 1 の形）
  { path: 'src/ui/bar/bar-strings.ts', text: "export const BAR = { one: 'いち', two: 'に' } as const;" },
  {
    path: 'src/ui/bar/Bar.tsx',
    text: "import { BAR } from './bar-strings';\nexport { BAR };\nexport const x = BAR.one;",
  },
  { path: 'src/ui/bar/index.ts', text: "export * from './Bar';" },
  {
    path: 'src/ui/baz/Use.tsx',
    text: "import { BAR } from '../bar/index';\nexport const all = Object.values(BAR);",
  },
  // 中核の表は、中核からしか引かれなければ表の置き場から画面を推定する
  { path: 'src/domain/knife/messages.ts', text: "export const MSG_KNIFE = '切れません。';" },
  { path: 'src/domain/knife/run.ts', text: "import { MSG_KNIFE } from './messages';\nexport const m = MSG_KNIFE;" },
  // 検査からの参照は別に数える
  {
    path: 'src/ui/foo/strings.test.ts',
    text: "import { FOO_STRINGS } from './strings';\nexpect(FOO_STRINGS.unused).toBe('使っていない文');",
  },
];

const MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'src/ui/foo/strings.ts': {
    FOO_STRINGS: {
      title: '見出し',
      greet: (name: string): string => `${name}さん、ようこそ`,
      pick: (on: boolean): string => (on ? '入れる' : '切る'),
      unused: '使っていない文',
      nested: { deep: '奥の文' },
    },
    SAME: '見出し',
    countText: (count: number): string => `${String(count)} 件あります`,
  },
  'src/ui/bar/bar-strings.ts': { BAR: { one: 'いち', two: 'に' } },
  'src/domain/knife/messages.ts': { MSG_KNIFE: '切れません。' },
};

async function fixtureCatalog(): Promise<Catalog> {
  return buildCatalog({
    files: FILES,
    loadModule: async (path) => {
      const m = MODULES[path];
      if (m === undefined) throw new Error(`no module ${path}`);
      return m;
    },
    generatedAt: '2026-10-04T00:00:00.000Z',
    commit: 'abc1234',
  });
}

function entry(catalog: Catalog, id: string) {
  const e = catalog.entries.find((x) => x.id === id);
  expect(e, `目録に ${id} が無い`).toBeDefined();
  return e!;
}

describe('文言の目録（scripts/ui-text-catalog.ts）', () => {
  it('表の見出し語を全部拾い、識別子は「ファイル#表.キー」（入れ子は a.b）', async () => {
    const c = await fixtureCatalog();
    expect(c.entries.map((e) => e.id).sort()).toEqual(
      [
        'src/domain/knife/messages.ts#MSG_KNIFE',
        'src/ui/bar/bar-strings.ts#BAR.one',
        'src/ui/bar/bar-strings.ts#BAR.two',
        'src/ui/foo/strings.ts#FOO_STRINGS.greet',
        'src/ui/foo/strings.ts#FOO_STRINGS.nested.deep',
        'src/ui/foo/strings.ts#FOO_STRINGS.pick',
        'src/ui/foo/strings.ts#FOO_STRINGS.title',
        'src/ui/foo/strings.ts#FOO_STRINGS.unused',
        'src/ui/foo/strings.ts#SAME',
        'src/ui/foo/strings.ts#countText',
      ].sort(),
    );
    expect(c.summary.tableFiles).toBe(3);
    expect(c.loadErrors).toEqual([]);
  });

  it('埋め込みのある関数は、目印で呼んで札入りの文と型を作り、見本の値でも呼ぶ', async () => {
    const c = await fixtureCatalog();
    const greet = entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.greet');
    expect(greet.evaluation).toBe('markers');
    expect(greet.text).toBe('〔名前〕さん、ようこそ');
    expect(greet.pattern).toEqual([{ param: 0, label: '名前' }, 'さん、ようこそ']);
    expect(greet.samples).toContain('南ケナ州さん、ようこそ');
    const count = entry(c, 'src/ui/foo/strings.ts#countText');
    expect(count.text).toBe('〔件数〕 件あります');
    expect(count.samples).toEqual(expect.arrayContaining(['3 件あります', '1 件あります', '0 件あります']));
  });

  it('引数で文を選ぶ関数は、値の組み合わせで出た文を全部見本に並べる', async () => {
    const pick = entry(await fixtureCatalog(), 'src/ui/foo/strings.ts#FOO_STRINGS.pick');
    expect(pick.samples).toEqual(expect.arrayContaining(['入れる', '切る']));
  });

  it('参照: 部品からの参照を数え、再公開と index の束ねをたどる。検査からの参照は別に数える', async () => {
    const c = await fixtureCatalog();
    expect(entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.title').refs).toEqual([{ file: 'src/ui/foo/Comp.tsx', line: 2 }]);
    expect(entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.nested.deep').refs).toHaveLength(1);
    expect(entry(c, 'src/ui/foo/strings.ts#SAME').refs).toHaveLength(1);
    const unused = entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.unused');
    expect(unused.refs).toEqual([]);
    expect(unused.testRefs).toEqual([{ file: 'src/ui/foo/strings.test.ts', line: 2 }]);
    // BAR.one は再公開した部品のファイルの中で使われている
    expect(entry(c, 'src/ui/bar/bar-strings.ts#BAR.one').refs.map((r) => r.file)).toEqual(['src/ui/bar/Bar.tsx']);
  });

  it('表がまるごと使われている（Object.values・[kind]）なら、名前で引かれない見出し語は「種類で引く」に分ける', async () => {
    const c = await fixtureCatalog();
    const two = entry(c, 'src/ui/bar/bar-strings.ts#BAR.two');
    expect(two.refs).toEqual([]);
    expect(two.tableUsedWhole).toBe(true);
    expect(entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.unused').tableUsedWhole).toBe(false);
    expect(c.summary.unreferenced).toBe(1);
    expect(c.summary.unreferencedButTableUsedWhole).toBe(1);
  });

  it('同じ文はまとめ、画面は参照元から引く（中核しか引かないものは推定）', async () => {
    const c = await fixtureCatalog();
    const title = entry(c, 'src/ui/foo/strings.ts#FOO_STRINGS.title');
    const same = entry(c, 'src/ui/foo/strings.ts#SAME');
    expect(title.sameTextGroup).not.toBeNull();
    expect(title.sameTextGroup).toBe(same.sameTextGroup);
    expect(c.summary.sameTextGroups).toBe(1);
    expect(entry(c, 'src/domain/knife/messages.ts#MSG_KNIFE').screens).toEqual([{ name: '分ける道具', inferred: true }]);
    expect(title.screens).toEqual([{ name: '画面側 foo', inferred: false }]);
  });

  it('Markdown は画面ごと・部品ごとに並べ、同じ文・参照 0 件・種類で引く・呼べない関数の節を持つ', async () => {
    const md = renderCatalogMarkdown(await fixtureCatalog());
    expect(md).toContain('### 画面側 foo');
    expect(md).toContain('#### src/ui/foo/Comp.tsx');
    expect(md).toContain('### 分ける道具（推定）');
    expect(md).toContain('| `FOO_STRINGS.greet` | 〔名前〕さん、ようこそ | 南ケナ州さん、ようこそ');
    expect(md).toMatch(/## 3\.[^\n]*\n[\s\S]*`src\/ui\/foo\/strings\.ts#FOO_STRINGS\.unused`/);
    expect(md).toMatch(/## 4\.[^\n]*\n[\s\S]*`src\/ui\/bar\/bar-strings\.ts#BAR\.two`/);
  });

  it('呼べない関数は failed にして、本体の中の日本語を手がかりに残す', () => {
    const ev = evaluateFunction((x: { kind: string }) => x.kind.toUpperCase(), [
      { name: 'x', type: 'Thing', label: 'x' },
    ]);
    expect(ev.evaluation).toBe('failed');
    expect(evaluateFunction('関数ではない', []).evaluation).toBe('failed');
  });
});

describe('巡回との突き合わせ（scripts/ui-text-tour-match.ts）', () => {
  const scenes: readonly TourScene[] = [
    {
      id: 'S01',
      title: '見本の場面',
      ok: true,
      pageTitle: 'gimoza',
      innerText: '見出し\n南ケナ州さん、ようこそ\n利用者の国\nまだ目録に無い文',
      attributes: [{ attr: 'aria-label', value: 'いち', tag: 'button', testid: 'x' }],
    },
    { id: 'S02', title: '作れなかった場面', ok: false, error: 'timeout' },
  ];

  it('出た見出し語・出なかった見出し語（理由つき）・目録で説明できない文字を出す', async () => {
    const r = matchTour(await fixtureCatalog(), scenes, ['利用者の国']);
    expect(r.scenes).toEqual({ total: 2, ok: 1, failed: ['S02: timeout'] });
    expect(r.seenIn['src/ui/foo/strings.ts#FOO_STRINGS.title']).toEqual(['S01']);
    // 関数は札の位置を何でもよい形にして当てる
    expect(r.seenIn['src/ui/foo/strings.ts#FOO_STRINGS.greet']).toEqual(['S01']);
    expect(r.seenIn['src/ui/bar/bar-strings.ts#BAR.one']).toEqual(['S01']);
    const unseen = r.notSeen.find((n) => n.id === 'src/ui/foo/strings.ts#FOO_STRINGS.unused');
    expect(unseen?.reason).toBe('unseen');
    const short = r.notSeen.find((n) => n.id === 'src/ui/bar/bar-strings.ts#BAR.two');
    expect(short?.reason).toBe('short');
    // 利用者のデータの語は取り除き、目録に無い文だけが残る
    expect(r.uncovered.map((u) => u.remainder)).toEqual(['まだ目録に無い文']);
    const md = renderMatchMarkdown(r, scenes);
    expect(md).toContain('まだ目録に無い文');
    expect(md).toContain('S02 作れなかった場面（作れなかった: timeout）');
  });
});

describe('本物のリポジトリで目録を作る', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
    }
    return out;
  };

  it('全部の表のファイルが読み込めて、見出し語が載り、識別子が重ならない', async () => {
    const files = [...walk(join(repoRoot, 'src')), ...walk(join(repoRoot, 'e2e'))].map((abs) => ({
      path: relative(repoRoot, abs).split('\\').join('/'),
      text: readSourceText(abs),
    }));
    const catalog = await buildCatalog({
      files,
      loadModule: async (path) =>
        (await import(/* @vite-ignore */ pathToFileURL(join(repoRoot, path)).href)) as Record<string, unknown>,
    });
    expect(catalog.loadErrors).toEqual([]);
    const tableFiles = files.filter((f) => f.path.startsWith('src/') && isUiTextTableFile(f.path) && !/\.test\./.test(f.path));
    expect(catalog.summary.tableFiles).toBe(tableFiles.length);
    for (const f of tableFiles) {
      expect(catalog.entries.some((e) => e.file === f.path), `${f.path} の見出し語が目録に無い`).toBe(true);
    }
    expect(catalog.entries.length).toBeGreaterThan(1000);
    expect(new Set(catalog.entries.map((e) => e.id)).size).toBe(catalog.entries.length);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  }, 120_000);
});
