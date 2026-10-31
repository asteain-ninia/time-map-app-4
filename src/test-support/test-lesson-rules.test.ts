// テストの書き方の教訓を、ソースの走査で止める（開発ガイド §1.6）。
//
//   - §5.64 要素を探す言葉に日本語を直書きしない
//   - §5.39 オブジェクトリテラルをドメイン型へキャストしない
//   - §5.65 見た目のベースラインの置き場と名前が変わっていない
//   - §5.44 輪の包含を先頭の頂点 1 点で判定しない
//
// 設定値と対象の一覧は `scripts/test-lesson-rules.mjs` の 1 か所にある。§5.64 と §5.39 は
// 既存の違反が多いので、件数をそこの上限と比べる。

import { existsSync, readdirSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { readSourceText } from './read-source-text';
import {
  CAST_NOTE,
  FIRST_VERTEX_PROBE_NOTE,
  POINT_CONTAINMENT_PREDICATES,
  SCAN_FIXTURE_FILE_PATTERN,
  SCAN_TEST_FILE_PATTERN,
  SNAPSHOT_FILES,
  SNAPSHOT_PATH_TEMPLATE,
  TEXT_LOCK_NOTE,
  TEXT_QUERY_NAME_PATTERN,
  VIOLATION_LIMITS,
} from '../../scripts/test-lesson-rules.mjs';
import { UI_TEXT_CHAR_CLASS } from '../../scripts/ui-text-rule.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const JA = new RegExp(`[${UI_TEXT_CHAR_CLASS}]`, 'u');

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function parseSource(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
}

/** その行のすぐ上に、理由のある注記があるか。 */
function hasNoteAbove(lines: readonly string[], line: number, note: string): boolean {
  const above = lines[line - 1]?.trim() ?? '';
  if (!above.startsWith('//')) return false;
  const at = above.indexOf(note);
  return at >= 0 && above.slice(at + note.length).trim().length > 0;
}

function literalText(node: ts.Node): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  }
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return node.getText();
  return '';
}

/** `getByRole` なら `name` の値、ほかは第 1 引数が、画面の言葉を当てる部分。 */
function queriedText(call: ts.CallExpression, by: string): ts.Node | undefined {
  if (by !== 'Role') return call.arguments[0];
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return undefined;
  for (const p of options.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'name') return p.initializer;
  }
  return undefined;
}

/** §5.64: 要素を探す言葉の日本語の直書き。 */
function findTextQueryLiterals(file: string, text: string): Finding[] {
  const sf = parseSource(file, text);
  const lines = text.split('\n');
  const out: Finding[] = [];
  const report = (target: ts.Node, anchor: ts.Node): void => {
    if (!JA.test(literalText(target))) return;
    const line = lineOf(sf, target);
    if (hasNoteAbove(lines, line, TEXT_LOCK_NOTE)) return;
    if (hasNoteAbove(lines, lineOf(sf, anchor), TEXT_LOCK_NOTE)) return;
    out.push({ file, line: line + 1, text: target.getText(sf) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      const by = TEXT_QUERY_NAME_PATTERN.exec(name)?.[1];
      if (by !== undefined) {
        const target = queriedText(node, by);
        if (target !== undefined) report(target, node);
      }
      if (name === 'locator' && node.arguments[0] !== undefined) report(node.arguments[0], node);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'hasText') {
      report(node.initializer, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** 読み込んだ名前 → 読み込み元（型の名前がドメインのものかを引くため）。 */
function importedNames(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const bindings = st.importClause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.set(el.name.text, from);
    }
  }
  return out;
}

function isDomainModule(file: string, from: string): boolean {
  if (from.startsWith('@/domain')) return true;
  if (!from.startsWith('.')) return false;
  const target = resolve(repoRoot, dirname(file), from).replace(/\\/g, '/');
  return target.startsWith(`${repoRoot.replace(/\\/g, '/')}/src/domain`);
}

/** §5.39: `{...} as Vertex` と `{...} as unknown as Vertex`。 */
function findDomainLiteralCasts(file: string, text: string): Finding[] {
  const sf = parseSource(file, text);
  const lines = text.split('\n');
  const imports = importedNames(sf);
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type)) {
      const typeName = node.type.typeName;
      const from = ts.isIdentifier(typeName) ? imports.get(typeName.text) : undefined;
      let inner = unwrapParens(node.expression);
      if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
        inner = unwrapParens(inner.expression);
      }
      if (
        from !== undefined &&
        isDomainModule(file, from) &&
        ts.isObjectLiteralExpression(inner) &&
        !hasNoteAbove(lines, lineOf(sf, node), CAST_NOTE)
      ) {
        out.push({ file, line: lineOf(sf, node) + 1, text: typeName.getText(sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 括弧・`!`・`as` を外した式。 */
function unwrapCast(node: ts.Expression): ts.Expression {
  let e = unwrapParens(node);
  while (ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = unwrapParens(e.expression);
  return e;
}

/** `x[0]`／`x[0]!`／`x.at(0)` か。 */
function isFirstElement(node: ts.Expression): boolean {
  const e = unwrapCast(node);
  if (ts.isElementAccessExpression(e)) {
    return ts.isNumericLiteral(e.argumentExpression) && e.argumentExpression.text === '0';
  }
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'at' &&
    e.arguments.length === 1 &&
    e.arguments[0]!.getText() === '0'
  );
}

/**
 * §5.44: 点の包含の述語に、配列の先頭の要素（またはそれを入れた変数）を渡している所。
 * 変数は同じ関数の中の `const p = x[0]` を追う（B109 の写しがこの形だった）。
 */
function findFirstVertexProbes(file: string, text: string): Finding[] {
  const sf = parseSource(file, text);
  const lines = text.split('\n');
  const out: Finding[] = [];
  const firstElementVars = (fn: ts.Node): ReadonlySet<string> => {
    const names = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer !== undefined &&
        isFirstElement(n.initializer)
      ) {
        names.add(n.name.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(fn);
    return names;
  };
  const visit = (node: ts.Node, vars: ReadonlySet<string>): void => {
    const scope = ts.isFunctionLike(node) ? firstElementVars(node) : vars;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      POINT_CONTAINMENT_PREDICATES.includes(node.expression.text)
    ) {
      const arg = node.arguments[0];
      const first = arg === undefined ? undefined : unwrapCast(arg);
      const probing =
        first !== undefined &&
        (isFirstElement(first) || (ts.isIdentifier(first) && scope.has(first.text)));
      if (probing && !hasNoteAbove(lines, lineOf(sf, node), FIRST_VERTEX_PROBE_NOTE)) {
        out.push({ file, line: lineOf(sf, node) + 1, text: node.getText(sf).slice(0, 60) });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sf, new Set());
  return out;
}

function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'e2e'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => existsSync(resolve(repoRoot, f)));
}

function scan(
  pick: (file: string) => boolean,
  find: (file: string, text: string) => Finding[],
): readonly Finding[] {
  return trackedFiles()
    .filter(pick)
    .flatMap((f) => find(f, readSourceText(resolve(repoRoot, f))));
}

function limitMessage(what: string, limitName: string, limit: number, found: readonly Finding[]): string {
  const list = found.map((f) => `${f.file}:${String(f.line)} ${f.text}`).join('\n');
  return found.length > limit
    ? `${what}が増えた（上限 ${String(limit)}、いま ${String(found.length)}）。新しく足した所を直す。一覧:\n${list}`
    : `${what}が減った（上限 ${String(limit)}、いま ${String(found.length)}）。scripts/test-lesson-rules.mjs の ${limitName} を ${String(found.length)} に下げる`;
}

describe('§5.64 要素を探す言葉の日本語の直書き', () => {
  const finds = (text: string): number => findTextQueryLiterals('e2e/x.spec.ts', text).length;

  it('走査の道具が直書きを拾い、文言表の参照と注記つきの例外を通す', () => {
    expect(finds(`page.getByRole('button', { name: '消す' });`)).toBe(1);
    expect(finds(`screen.getByText(/消す/);`)).toBe(1);
    expect(finds('within(a).findAllByLabelText(`消す${n}`);')).toBe(1);
    expect(finds(`page.locator('button', { hasText: '消す' });`)).toBe(1);
    expect(finds(`page.locator('text=消す');`)).toBe(1);
    expect(finds(`page.getByRole('button', { name: STRINGS.remove });`)).toBe(0);
    expect(finds(`page.getByRole('button');`)).toBe(0);
    expect(finds(`page.getByTestId('消す');`)).toBe(0);
    expect(finds(`// ${TEXT_LOCK_NOTE} 設計書の言葉\npage.getByText('消す');`)).toBe(0);
    // 理由の無い注記は例外にならない。
    expect(finds(`// ${TEXT_LOCK_NOTE}\npage.getByText('消す');`)).toBe(1);
  });

  it(
    '既存の件数を超えない（§5.64）',
    () => {
      const found = scan((f) => SCAN_TEST_FILE_PATTERN.test(f), findTextQueryLiterals);
      const limit = VIOLATION_LIMITS.textQueryLiterals;
      expect(
        found.length,
        limitMessage('要素を探す言葉の日本語の直書き', 'textQueryLiterals', limit, found),
      ).toBe(limit);
    },
    60_000,
  );
});

describe('§5.39 オブジェクトリテラルのドメイン型へのキャスト', () => {
  const finds = (body: string): number =>
    findDomainLiteralCasts('src/domain/x.test.ts', `import type { Vertex } from './vertex';\n${body}`).length;

  it('走査の道具がキャストを拾い、ドメイン以外の型と注記つきの例外を通す', () => {
    expect(finds(`const a = { id: 1 } as Vertex;`)).toBe(1);
    expect(finds(`const a = { id: 1 } as unknown as Vertex;`)).toBe(1);
    expect(finds(`const a = ({ id: 1 }) as Vertex;`)).toBe(1);
    expect(finds(`const a = createVertex() as Vertex;`)).toBe(0);
    expect(finds(`const a = { id: 1 } as const;`)).toBe(0);
    expect(finds(`const a = { id: 1 } as LocalThing;`)).toBe(0);
    expect(finds(`const a: Vertex = { id: 1 };`)).toBe(0);
    expect(finds(`// ${CAST_NOTE} 壊れた入力を断るか見る\nconst a = { id: 1 } as Vertex;`)).toBe(0);
    // 読み込み元がドメインの外なら対象外。
    expect(
      findDomainLiteralCasts('src/ui/x.test.ts', `import type { P } from './p';\nconst a = { id: 1 } as P;`),
    ).toEqual([]);
  });

  it(
    '既存の件数を超えない（§5.39）',
    () => {
      const found = scan(
        (f) => SCAN_TEST_FILE_PATTERN.test(f) || SCAN_FIXTURE_FILE_PATTERN.test(f),
        findDomainLiteralCasts,
      );
      const limit = VIOLATION_LIMITS.domainLiteralCasts;
      expect(
        found.length,
        limitMessage('リテラルのドメイン型へのキャスト', 'domainLiteralCasts', limit, found),
      ).toBe(limit);
    },
    60_000,
  );
});

describe('§5.44 輪の包含を先頭の頂点 1 点で判定しない', () => {
  const finds = (body: string): number => findFirstVertexProbes('src/domain/x.ts', body).length;

  it('走査の道具が B109 の形を拾い、点そのものの判定と注記つきの例外を通す', () => {
    // B109 の写しの形そのまま。
    expect(
      finds(`function ringContains(outer, inner) {
        const probe = inner[0];
        if (probe === undefined) return false;
        return pointInPolygon(probe, [outer]) === POINT_LOCATION.Inside;
      }`),
    ).toBe(1);
    expect(finds(`const a = pointInPolygon(ring[0], poly);`)).toBe(1);
    expect(finds(`const a = pointInPolygon(ring[0]!, poly);`)).toBe(1);
    expect(finds(`const a = pointInPolygon(ring.at(0), poly);`)).toBe(1);
    expect(finds(`function f() { const p = rings[0]; return pointInPolygon(p as never, poly); }`)).toBe(1);
    expect(finds(`function f() { const p = rings[0]!; return pointInPolygon(p, poly); }`)).toBe(1);
    // 全部の頂点を回す・利用者の点を聞く形は通す。
    expect(finds(`for (const v of inner) pointInPolygon(v, poly);`)).toBe(0);
    expect(finds(`function f(p) { return pointInPolygon(p, poly); }`)).toBe(0);
    expect(finds(`function f(p) { const first = rings[0]; return pointInPolygon(p, first); }`)).toBe(0);
    expect(
      finds(`// ${FIRST_VERTEX_PROBE_NOTE} 互いに交わらないと分かっている輪の代表点\nconst a = pointInPolygon(ring[0], poly);`),
    ).toBe(0);
  });

  it(
    '本体のコードに無い',
    () => {
      const found = scan((f) => f.startsWith('src/') && !/\.test(-d)?\.tsx?$/.test(f), findFirstVertexProbes);
      expect(found.map((f) => `${f.file}:${String(f.line)} ${f.text}`)).toEqual([]);
    },
    60_000,
  );
});

describe('§5.65 見た目のベースラインの置き場', () => {
  it('snapshotPathTemplate の値が変わっていない', () => {
    const config = readSourceText(resolve(repoRoot, 'playwright.config.ts'));
    const values = [...config.matchAll(/^\s*snapshotPathTemplate:\s*'([^']*)'/gm)].map((m) => m[1]);
    expect(
      values,
      'playwright.config.ts の snapshotPathTemplate は既定の書式から {-projectName} だけを抜いた値で、全 project で 1 つ（開発ガイド §5.65）',
    ).toEqual([SNAPSHOT_PATH_TEMPLATE]);
  });

  it('e2e の下のベースラインの顔ぶれが想定どおり', () => {
    const e2eDir = resolve(repoRoot, 'e2e');
    const found: Record<string, string[]> = {};
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = `${prefix}${entry.name}`;
        if (entry.name.endsWith('-snapshots')) {
          found[rel] = readdirSync(resolve(dir, entry.name)).sort();
        } else {
          walk(resolve(dir, entry.name), `${rel}/`);
        }
      }
    };
    walk(e2eDir, '');
    const expected = Object.fromEntries(
      Object.entries(SNAPSHOT_FILES).map(([dir, files]) => [dir, [...files].sort()]),
    );
    expect(
      found,
      'ベースラインの名前か置き場が変わった。増やしたのなら scripts/test-lesson-rules.mjs の SNAPSHOT_FILES に足す。「新しいベースラインが増えた」を成功と読まない（開発ガイド §5.65）',
    ).toEqual(expected);
  });

  it('リポジトリの直下・親・ドライブの直下に *.spec.ts-snapshots が生えていない', () => {
    const places = [repoRoot, resolve(repoRoot, '..'), parse(repoRoot).root];
    const stray = places.flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.spec.ts-snapshots'))
        .map((name) => resolve(dir, name)),
    );
    expect(
      stray,
      'snapshotPathTemplate の先頭の {snapshotDir}/ を落とすと、ここへベースラインが書かれる（開発ガイド §5.65）',
    ).toEqual([]);
  });
});
