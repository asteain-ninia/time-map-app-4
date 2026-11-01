// 「利用者に見える文字列は文言の表から引く」をソースの走査で守る（開発ガイド §5.99 /
// 案/文言総点検-やり方の提案.md §5.2 (b)）。
//
// **ESLint の no-restricted-syntax と同じことを、もう 1 度ここで見る。** ESLint は書いた瞬間に
// 赤くなるが、設定を外したり `--no-eslintrc` で走らせたりすれば素通りになる。こちらは
// `npm run test` の中に居るので、lint を飛ばしても落ちる（`command-result.test.ts` と同じ書き方）。
// 文字の範囲・表のファイル・除外の一覧は `scripts/ui-text-rule.mjs` の 1 か所から読む ――
// ここに書き写すと、片方だけ直して「lint は通るのに単体が赤い」になる。
//
// 拾うもの（ESLint の規則と同じ）:
//   - 日本語の文字を含む文字列（'…' と `…`）
//   - テンプレート文字列の部品（埋め込みの前後）に日本語があるもの
//   - JSX の本文の日本語
//   - aria-label / title / placeholder / alt の直書き（言語を問わず、空でないもの）
// 1 行ずつの例外は、その行の直前の `// eslint-disable-next-line no-restricted-syntax -- 理由`。

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { readSourceText } from '../../test-support/read-source-text';
import {
  UI_TEXT_ATTRIBUTES,
  UI_TEXT_CHAR_CLASS,
  UI_TEXT_EXEMPT_FILES,
  UI_TEXT_TABLE_FILES,
  globToRegExp,
  isUiTextExemptFile,
  isUiTextTableFile,
} from '../../../scripts/ui-text-rule.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const srcRoot = join(repoRoot, 'src');

const JA = new RegExp(`[${UI_TEXT_CHAR_CLASS}]`, 'u');
const ATTRS = new Set(UI_TEXT_ATTRIBUTES);
const DISABLE = /eslint-disable-next-line\s+no-restricted-syntax/;

/**
 * 「出さない」と決めた語（用語集で定義された語に置き換えた旧称など）。所有者が語を決めたら
 * 1 行ずつ足す（総点検の手順は 案/文言総点検-やり方の提案.md §6）。
 * 表の中にその語が残っていたら下の検査が赤くなる。
 */
const FORBIDDEN_TERMS: readonly { readonly term: string; readonly reason: string }[] = [
  {
    term: 'まとめ役',
    reason: '用語集の語は「集約地物」（要件定義書 §6）。「まとめ役」は定義された語ではない',
  },
];

/** リポジトリ直下からの相対パス（`/` 区切り）で、`src` の下の .ts / .tsx を全部。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(relative(repoRoot, full).split('\\').join('/'));
  }
  return out;
}

interface Hit {
  readonly line: number;
  readonly text: string;
}

/** 1 ファイルの中の、規則に当たる直書き（注記で外した行は除く）。 */
function scanSource(fileName: string, text: string): { hits: Hit[]; strings: string[] } {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split('\n');
  const hits: Hit[] = [];
  const strings: string[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const report = (pos: number, value: string): void => {
    const line = lineOf(pos);
    if (DISABLE.test(lines[line - 2] ?? '')) return;
    hits.push({ line, text: value.replace(/\s+/g, ' ').trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push(node.text);
      const parent = node.parent;
      const isShownAttribute =
        parent !== undefined && ts.isJsxAttribute(parent) && ATTRS.has(parent.name.getText(sf));
      if (JA.test(node.text) || (isShownAttribute && /\S/.test(node.text))) {
        report(node.getStart(sf), node.text);
      }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // ESLint と同じく、部品（埋め込みの前後）ごとに見る
      const parts: ts.Node[] = [node.head, ...node.templateSpans.map((s) => s.literal)];
      for (const part of parts) {
        const value = (part as ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail).text;
        strings.push(value);
        if (JA.test(value)) report(part.getStart(sf), value);
      }
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    if (ts.isJsxText(node)) {
      if (JA.test(node.text)) report(node.getStart(sf), node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { hits, strings };
}

const ALL_FILES = sourceFiles(srcRoot);

describe('文言の表の外に、利用者に見える文字列を直書きしない（ソース走査）', () => {
  it('走査そのものが当たる（日本語の文字列・テンプレートの部品・JSX の本文・属性の直書き）', () => {
    // 走査が何も拾えない壊れ方（文字の範囲の綴り違いなど）で、下の検査が黙って緑にならないように。
    const sample = [
      "const a = '日本語';",
      'const b = `${x}の島`;',
      'const c = <b>見出し</b>;',
      'const d = <i aria-label="close" />;',
      '// eslint-disable-next-line no-restricted-syntax -- 見本',
      "const e = '外した行';",
      "const f = 'ascii only';",
    ].join('\n');
    const { hits } = scanSource('sample.tsx', sample);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });

  it('src の表でも除外でもないファイルに、日本語や画面に出る属性の直書きが 1 つも無い', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of ALL_FILES) {
      if (isUiTextTableFile(file) || isUiTextExemptFile(file)) continue;
      scanned += 1;
      const { hits } = scanSource(file, readSourceText(join(repoRoot, file)));
      for (const hit of hits) offenders.push(`${file}:${hit.line}  ${hit.text}`);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(
      offenders,
      `表の外の直書き（画面側 src/ui/**/strings.ts 等・中核 src/domain/**/messages.ts・本体側 src/shell/**/strings.ts へ移す）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('1 行ずつの例外には、必ず理由を書く（`-- 理由`）', () => {
    const missing: string[] = [];
    for (const file of ALL_FILES) {
      const text = readSourceText(join(repoRoot, file));
      text.split('\n').forEach((line, i) => {
        if (DISABLE.test(line) && !/no-restricted-syntax\s+--\s*\S/.test(line)) {
          missing.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(missing, `理由の無い例外:\n${missing.join('\n')}`).toEqual([]);
  });

  it('除外の一覧の各行は、いま実在するファイルに当たる（古い除外で穴を広げない）', () => {
    for (const glob of UI_TEXT_EXEMPT_FILES) {
      const re = globToRegExp(glob);
      expect(ALL_FILES.some((f) => re.test(f)), `どのファイルにも当たらない除外: ${glob}`).toBe(true);
    }
  });

  it('ESLint の設定が同じ規則（文字の範囲・表・除外）を読んでいる', () => {
    const config = readSourceText(join(repoRoot, 'eslint.config.js'));
    expect(config).toContain("from './scripts/ui-text-rule.mjs'");
    expect(config).toContain("'no-restricted-syntax': ['error', ...uiTextRestrictedSyntax()]");
    expect(config).toContain('ignores: [...UI_TEXT_TABLE_FILES, ...UI_TEXT_EXEMPT_FILES]');
    expect(UI_TEXT_TABLE_FILES.length).toBeGreaterThan(0);
  });

  it('`○○-strings.ts` / `○○-messages.ts` の表は何も読み込まない（読み込む側との import の輪を作らない）', () => {
    // 表を読み込む module を表自身が読み込むと、どちらが先に評価されるかで
    // 「初期化前の参照」になる（型の検査では見つからず、実行して初めて落ちる）。
    const offenders: string[] = [];
    for (const file of ALL_FILES.filter((f) => /-(strings|messages)\.ts$/.test(f))) {
      const sf = ts.createSourceFile(file, readSourceText(join(repoRoot, file)), ts.ScriptTarget.Latest, true);
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        if (st.importClause?.isTypeOnly === true) continue;
        offenders.push(`${file}: ${st.getText(sf)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('用語集で「出さない」と決めた語が、文言の表に残っていない', () => {
  it('表の文を全部集めて、出さない語の一覧と突き合わせる', () => {
    const tableStrings: string[] = [];
    for (const file of ALL_FILES.filter((f) => isUiTextTableFile(f))) {
      tableStrings.push(...scanSource(file, readSourceText(join(repoRoot, file))).strings);
    }
    // 表から文を集められていること（一覧に語を足したときに、この検査が空振りしないように）
    expect(tableStrings.length).toBeGreaterThan(1000);
    const found: string[] = [];
    for (const { term, reason } of FORBIDDEN_TERMS) {
      for (const s of tableStrings) {
        if (s.includes(term)) found.push(`「${term}」（${reason}）: ${s}`);
      }
    }
    expect(found, `出さないと決めた語が表に残っている:\n${found.join('\n')}`).toEqual([]);
  });
});
