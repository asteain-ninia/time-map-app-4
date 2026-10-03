// 画面の文言の目録を作る（案/文言総点検-やり方の提案.md §2.1 / §6 の 3）。
//
// 文言の表（`scripts/ui-text-rule.mjs` の `UI_TEXT_TABLE_FILES`。ESLint の規則と同じ定義を読む）を
// TypeScript の構文で読み、見出し語（キー）ごとに 1 行を作る:
//   - 識別子（「ファイル#表.キー」）・層・行
//   - 文。埋め込みのある関数は **目印の引数で呼んで**、埋め込みの位置を〔名前〕〔年〕の札にした文と、
//     見本の値（南ケナ州・1200年・3 件 …）で呼んだ結果。引数で文を選ぶ関数（真偽値・数・配列で
//     分岐する）は、値の組み合わせを何通りか入れて、出た文を全部並べる
//   - 参照元（どの部品・どのファイルから引かれているか）。`export { X }` の再公開と `index.ts` の
//     束ねをたどって、元の表へ結びつける。検査（*.test.*・e2e/）からの参照は別に数える
//   - 同じ文のまとめ・参照 0 件の見出し語（「要確認」。表をまるごと渡したり `[kind]` で引いたり
//     している表の見出し語は、名前が直接は出てこないので 0 件に見える ―― 別に分けて出す）
//   - 出る画面（参照元のディレクトリから引く。中核の表は表の置き場から推定し、推定と書く）
//
// **画面の文は 1 文字も変えない。** この道具は読むだけで、表を書き換えない。
//
// 使い方は `scripts/ui-text-catalog-cli.ts`（`npm run ui-text:catalog -- --out <出力先>`）。
// 核の関数はファイルの読み方と表の読み込み方を外から受け取るので、単体
// （`src/ui/shell/ui-text-catalog.test.ts`）は手で書いたソースだけで固定できる。

import ts from 'typescript';

import { UI_TEXT_CHAR_CLASS, isUiTextTableFile } from './ui-text-rule.mjs';

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 読み込むソース 1 本（リポジトリ直下からの相対パス、`/` 区切り）。 */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** 目録を作る材料。 */
export interface CatalogInput {
  readonly files: readonly SourceFile[];
  /** 表のファイルを実際に読み込む（関数を呼んで文を作るため）。読めなければ例外。 */
  readonly loadModule: (path: string) => Promise<Readonly<Record<string, unknown>>>;
  /** 生成の印（いつ・どのコミットで作ったか）。 */
  readonly generatedAt?: string;
  readonly commit?: string;
}

export type CatalogLayer = 'ui' | 'domain' | 'shell' | 'render' | 'other';

/** 札（埋め込みの位置）か、決まった文字。 */
export type PatternPart = string | { readonly param: number; readonly label: string };

export interface CatalogParam {
  readonly name: string;
  readonly type: string;
  readonly label: string;
}

export interface CatalogRef {
  readonly file: string;
  readonly line: number;
}

export interface CatalogScreen {
  readonly name: string;
  /** 参照元から引けず、表の置き場から推定したもの。 */
  readonly inferred: boolean;
}

export type EntryKind =
  /** 決まった文（文字列そのもの）。 */
  | 'text'
  /** 引数を埋め込む関数。 */
  | 'function'
  /** 文字列でも関数でもない値（数・配列・入れ子でない表など）。 */
  | 'other';

export type Evaluation =
  /** 文字列そのもの。 */
  | 'literal'
  /** 目印の引数で呼べて、埋め込みの位置が全部分かった。 */
  | 'markers'
  /** 目印では全部の位置が出なかった（引数で文を選ぶ）。値の組み合わせで見本を作った。 */
  | 'variants'
  /** 呼べなかった（中の文字列だけを `fragments` に並べる）。 */
  | 'failed';

export interface CatalogEntry {
  /** 「ファイル#表.キー」（文そのものを識別子にしない＝提案書 §2.1）。 */
  readonly id: string;
  readonly file: string;
  readonly layer: CatalogLayer;
  /** 表の名前（`export const X`）。公開していない宣言は `exported: false`。 */
  readonly table: string;
  readonly exported: boolean;
  /** 表の中の見出し語（入れ子は `a.b`）。表そのものが 1 つの文なら null。 */
  readonly key: string | null;
  readonly line: number;
  readonly kind: EntryKind;
  readonly evaluation: Evaluation;
  /** 文。関数は埋め込みを〔札〕にしたもの。作れなければ null。 */
  readonly text: string | null;
  /** 関数の文の型（決まった文字と札の並び）。照合の道具が正規表現を作るのに使う。 */
  readonly pattern: readonly PatternPart[] | null;
  readonly params: readonly CatalogParam[];
  /** 見本の値で呼んだ結果（出た文を全部。重複なし）。 */
  readonly samples: readonly string[];
  /** 関数の本体の中にある日本語の文字列（呼べなかったときの手がかり）。 */
  readonly fragments: readonly string[];
  /** 実装からの参照。 */
  readonly refs: readonly CatalogRef[];
  /** 検査（*.test.*・*.test-d.ts・e2e/）からの参照。 */
  readonly testRefs: readonly CatalogRef[];
  /** この表がどこかで **まるごと**（`X[kind]`・値として渡す・分割代入）使われている。 */
  readonly tableUsedWhole: boolean;
  readonly screens: readonly CatalogScreen[];
  /** 同じ文を持つ見出し語のまとまりの番号（1 件だけなら null）。 */
  readonly sameTextGroup: number | null;
}

export interface CatalogSummary {
  readonly tableFiles: number;
  readonly tables: number;
  readonly entries: number;
  readonly byLayer: Readonly<Record<string, number>>;
  readonly byEvaluation: Readonly<Record<string, number>>;
  readonly sameTextGroups: number;
  /** 実装からの参照が 0 件で、表もまるごと使われていない見出し語（要確認）。 */
  readonly unreferenced: number;
  /** 実装からの参照が 0 件だが、表がまるごと使われている見出し語（種類で引く）。 */
  readonly unreferencedButTableUsedWhole: number;
}

export interface Catalog {
  readonly generatedAt: string | null;
  readonly commit: string | null;
  readonly summary: CatalogSummary;
  readonly entries: readonly CatalogEntry[];
  /** 読み込めなかった表のファイル（理由つき）。 */
  readonly loadErrors: readonly { readonly file: string; readonly error: string }[];
}

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------

/** 日本語とみなす文字（規則と同じ範囲。fragments を拾うのに使う）。 */
const JA = new RegExp(`[${UI_TEXT_CHAR_CLASS}]`, 'u');

export function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || /\.test-d\.ts$/.test(path) || path.startsWith('e2e/');
}

export function layerOf(path: string): CatalogLayer {
  const m = /^src\/(ui|domain|shell|render)\//.exec(path);
  return m === null ? 'other' : (m[1] as CatalogLayer);
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** `as const` / `satisfies` / 括弧 / 型の主張を剥がす。 */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** 関数の本体の中の日本語の文字列（テンプレートは埋め込みを〔…〕にして 1 本）。 */
function japaneseFragments(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (JA.test(n.text)) out.push(n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      const text =
        n.head.text +
        n.templateSpans.map((s) => `〔${s.expression.getText(sf)}〕${s.literal.text}`).join('');
      if (JA.test(text)) out.push(text);
      n.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// 引数の札と見本
// ---------------------------------------------------------------------------

interface LabelRule {
  readonly test: RegExp;
  readonly label: string;
  readonly sample: string;
}

/** 引数の名前 → 札と見本（上から順に当てる。提案書 §2.1 の対応表）。 */
const LABEL_RULES: readonly LabelRule[] = [
  { test: /^(names|shown|related|heads|parts|spacings|years)$/i, label: '名前の並び', sample: '南ケナ州・北ケナ州' },
  { test: /count|^n$|rest|members|total|amount|^index$|^length$/i, label: '件数', sample: '3' },
  { test: /year|edge|^from$|^to$|^at|time|created/i, label: '年', sample: '1200年' },
  { test: /kind/i, label: '種別', sample: '州' },
  { test: /name|label|owner|parent|target|feature|source|before|after/i, label: '名前', sample: '南ケナ州' },
  { test: /ratio/i, label: '縦横比', sample: '3:2' },
  { test: /bytes|size|^mb$|^kb$/i, label: '大きさ', sample: '約 306 KB' },
  { test: /min|max|floor|ceil|cap|counted|^number$|value|times|limit/i, label: '数', sample: '2,230' },
  { test: /detail|message|reason|error/i, label: '理由', sample: '（理由の文）' },
  { test: /title|field/i, label: '見出し', sample: '直接ジャンプ' },
  { test: /phrase/i, label: '言い回し', sample: '穴と穴が交わる' },
  { test: /where/i, label: '場所', sample: '（「南ケナ州」の1200年の形）' },
  { test: /axis/i, label: '向き', sample: '横' },
  { test: /full|date|saved/i, label: '日時', sample: '1200年3月15日' },
];

export function paramLabel(name: string): { label: string; sample: string } {
  for (const rule of LABEL_RULES) {
    if (rule.test.test(name)) return { label: rule.label, sample: rule.sample };
  }
  return { label: name, sample: `（${name}）` };
}

/** 引数の型の大まかな種類（見本の値を選ぶため）。 */
type ParamShape = 'string' | 'number' | 'boolean' | 'array' | 'nullable-string' | 'unknown' | { readonly oneOf: readonly string[] };

function shapeOf(typeText: string): ParamShape {
  const t = typeText.replace(/\s+/g, '');
  // 文字列の値の並び（'escape' | 'time' …）は、その値を全部入れてみる
  if (/^'[^']*'(\|'[^']*')*$/.test(t)) return { oneOf: t.split('|').map((s) => s.slice(1, -1)) };
  if (/\[\]$|^readonly|Array</.test(t)) return 'array';
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return 'number';
  if (t === 'string') return 'string';
  if (/^string\|(null|undefined)|(null|undefined)\|string$/.test(t)) return 'nullable-string';
  if (/string/.test(t)) return 'string';
  if (/number/.test(t)) return 'number';
  return 'unknown';
}

const MARK = (i: number): string => `\u0001${i}\u0002`;
// eslint-disable-next-line no-control-regex -- 目印に制御文字を使う（画面の文には現れないので取り違えない）
const MARK_RE = /\u0001(\d+)\u0002/g;

function markerArg(shape: ParamShape, i: number): unknown {
  if (typeof shape === 'object') return shape.oneOf[0];
  switch (shape) {
    case 'array':
      return [MARK(i)];
    case 'boolean':
      return true;
    default:
      return MARK(i);
  }
}

function variantsFor(shape: ParamShape, sample: string): readonly unknown[] {
  if (typeof shape === 'object') return shape.oneOf;
  switch (shape) {
    case 'number':
      return [1, 3, 0];
    case 'boolean':
      return [true, false];
    case 'array':
      return [['1300年'], ['1300年', '1400年'], ['1300年', '1400年', '1500年', '1600年'], []];
    case 'nullable-string':
      return [sample, null];
    case 'string':
      return [sample, ''];
    default:
      return [sample];
  }
}

/** 値の組み合わせ（上限つきの直積）。 */
function combinations(lists: readonly (readonly unknown[])[], limit: number): unknown[][] {
  let acc: unknown[][] = [[]];
  for (const list of lists) {
    const next: unknown[][] = [];
    for (const prefix of acc) {
      for (const v of list) {
        next.push([...prefix, v]);
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    acc = next;
  }
  return acc;
}

interface Evaluated {
  readonly evaluation: Evaluation;
  readonly text: string | null;
  readonly pattern: readonly PatternPart[] | null;
  readonly samples: readonly string[];
}

/** 関数を目印の引数で呼び、札入りの文・型・見本を作る。 */
export function evaluateFunction(fn: unknown, params: readonly CatalogParam[]): Evaluated {
  if (typeof fn !== 'function') return { evaluation: 'failed', text: null, pattern: null, samples: [] };
  const call = (args: readonly unknown[]): string | null => {
    try {
      const out: unknown = (fn as (...a: unknown[]) => unknown)(...args);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  };
  const shapes = params.map((p) => shapeOf(p.type));
  const samples = new Set<string>();
  // 見本の値（1 通り目は札の見本）
  const sampleArgs = params.map((p, i) => {
    const shape = shapes[i] ?? 'unknown';
    if (typeof shape === 'object') return shape.oneOf[0];
    if (shape === 'number') return 3;
    if (shape === 'boolean') return true;
    if (shape === 'array') return ['1300年', '1400年'];
    return paramLabel(p.name).sample;
  });
  const first = call(sampleArgs);
  if (first !== null) samples.add(first);
  // 目印で呼ぶ
  const marked = call(params.map((_, i) => markerArg(shapes[i] ?? 'unknown', i)));
  let pattern: PatternPart[] | null = null;
  let complete = false;
  if (marked !== null) {
    pattern = [];
    const used = new Set<number>();
    let last = 0;
    for (const m of marked.matchAll(MARK_RE)) {
      const at = m.index ?? 0;
      if (at > last) pattern.push(marked.slice(last, at));
      const i = Number(m[1]);
      used.add(i);
      pattern.push({ param: i, label: params[i]?.label ?? String(i) });
      last = at + m[0].length;
    }
    if (last < marked.length) pattern.push(marked.slice(last));
    // 真偽値の引数は文に現れないので数えない
    const needed = params.filter((_, i) => shapes[i] !== 'boolean' && typeof shapes[i] !== 'object').length;
    complete = used.size === needed;
  }
  // 引数で文を選ぶかもしれないので、値の組み合わせでも呼ぶ
  if (
    !complete ||
    shapes.some((s) => typeof s === 'object' || s === 'boolean' || s === 'number' || s === 'array' || s === 'nullable-string')
  ) {
    const lists = params.map((p, i) => variantsFor(shapes[i] ?? 'unknown', paramLabel(p.name).sample));
    for (const args of combinations(lists, 24)) {
      const out = call(args);
      if (out !== null) samples.add(out);
    }
  }
  const text =
    pattern === null
      ? null
      : pattern.map((part) => (typeof part === 'string' ? part : `〔${part.label}〕`)).join('');
  if (pattern !== null && complete) return { evaluation: 'markers', text, pattern, samples: [...samples] };
  if (samples.size > 0 || pattern !== null) {
    return { evaluation: 'variants', text, pattern, samples: [...samples] };
  }
  return { evaluation: 'failed', text: null, pattern: null, samples: [] };
}

function paramsOf(node: ts.SignatureDeclaration, sf: ts.SourceFile): CatalogParam[] {
  return node.parameters.map((p) => {
    const name = p.name.getText(sf);
    const type = p.type === undefined ? 'unknown' : p.type.getText(sf);
    return { name, type, label: paramLabel(name).label };
  });
}

// ---------------------------------------------------------------------------
// 表の中の見出し語を拾う
// ---------------------------------------------------------------------------

interface RawEntry {
  readonly file: string;
  readonly table: string;
  readonly exported: boolean;
  readonly key: string | null;
  readonly line: number;
  /** 実行時の値を取る道（表の名前のあとのキーの並び。計算されたキーは位置で引く）。 */
  readonly path: readonly (string | { readonly index: number })[];
  readonly node: ts.Expression | ts.FunctionDeclaration;
  readonly params: readonly CatalogParam[];
  readonly isFunction: boolean;
  readonly fragments: readonly string[];
}

function propertyKey(name: ts.PropertyName, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return null;
  return name.getText(sf);
}

function collectTableEntries(file: SourceFile): RawEntry[] {
  const sf = parse(file);
  const out: RawEntry[] = [];
  const pushValue = (
    table: string,
    exported: boolean,
    keyPath: readonly string[],
    path: readonly (string | { readonly index: number })[],
    expr: ts.Expression,
    lineNode: ts.Node,
  ): void => {
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) {
      e.properties.forEach((prop, index) => {
        if (ts.isPropertyAssignment(prop)) {
          const key = propertyKey(prop.name, sf);
          const shown = key ?? prop.name.getText(sf);
          pushValue(
            table,
            exported,
            [...keyPath, shown],
            [...path, key === null ? { index } : key],
            prop.initializer,
            prop,
          );
        } else if (ts.isMethodDeclaration(prop)) {
          const key = propertyKey(prop.name, sf) ?? prop.name.getText(sf);
          out.push({
            file: file.path,
            table,
            exported,
            key: [...keyPath, key].join('.'),
            line: lineOf(sf, prop),
            path: [...path, key],
            node: prop as unknown as ts.Expression,
            params: paramsOf(prop, sf),
            isFunction: true,
            fragments: japaneseFragments(prop, sf),
          });
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const key = prop.name.text;
          out.push({
            file: file.path,
            table,
            exported,
            key: [...keyPath, key].join('.'),
            line: lineOf(sf, prop),
            path: [...path, key],
            node: prop.name,
            params: [],
            isFunction: false,
            fragments: [],
          });
        }
      });
      return;
    }
    if (ts.isArrayLiteralExpression(e)) {
      // 並び（案内の手順など）は 1 つずつ見出し語にする（キーは番号）
      e.elements.forEach((el, index) => {
        if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return;
        pushValue(table, exported, [...keyPath, String(index)], [...path, String(index)], el, el);
      });
      return;
    }
    const isFn = ts.isArrowFunction(e) || ts.isFunctionExpression(e);
    out.push({
      file: file.path,
      table,
      exported,
      key: keyPath.length === 0 ? null : keyPath.join('.'),
      line: lineOf(sf, lineNode),
      path,
      node: e,
      params: isFn ? paramsOf(e, sf) : [],
      isFunction: isFn,
      fragments: isFn || !(ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? japaneseFragments(e, sf) : [],
    });
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      const exported = hasExport(st);
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
        const init = unwrap(d.initializer);
        // 公開していない宣言は、日本語を持つものだけ（内部の数や正規表現は目録に要らない）
        if (!exported && japaneseFragments(init, sf).length === 0) continue;
        pushValue(d.name.text, exported, [], [], d.initializer, d);
      }
    } else if (ts.isFunctionDeclaration(st) && st.name !== undefined) {
      const exported = hasExport(st);
      const fragments = japaneseFragments(st, sf);
      if (!exported && fragments.length === 0) continue;
      out.push({
        file: file.path,
        table: st.name.text,
        exported,
        key: null,
        line: lineOf(sf, st),
        path: [],
        node: st,
        params: paramsOf(st, sf),
        isFunction: true,
        fragments,
      });
    }
  }
  return out;
}

function runtimeValue(mod: Readonly<Record<string, unknown>>, raw: RawEntry): unknown {
  let cur: unknown = mod[raw.table];
  for (const step of raw.path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof step === 'string') {
      cur = (cur as Record<string, unknown>)[step];
    } else {
      const keys = Object.keys(cur);
      const k = keys[step.index];
      cur = k === undefined ? undefined : (cur as Record<string, unknown>)[k];
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// 参照（import と再公開をたどる）
// ---------------------------------------------------------------------------

interface ModuleInfo {
  readonly sf: ts.SourceFile;
  /** 局所の名前 → 読み込み元（`import { a as b } from './x'`）。型だけの読み込みは除く。 */
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  /** 公開名 → 局所の名前か、別のファイルからの再公開。 */
  readonly exports: Map<string, { readonly local: string } | { readonly from: string; readonly name: string }>;
  readonly starExports: readonly string[];
  /** このファイルで宣言した局所の名前。 */
  readonly locals: Set<string>;
}

function resolveSpecifier(from: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/').replace(/\.(m?js)$/, '');
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(c)) return c;
  }
  return null;
}

function moduleInfo(file: SourceFile, known: ReadonlySet<string>): ModuleInfo {
  const sf = parse(file);
  const imports = new Map<string, { from: string; name: string }>();
  const exports = new Map<string, { local: string } | { from: string; name: string }>();
  const starExports: string[] = [];
  const locals = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause !== undefined && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.importClause.isTypeOnly) continue;
      const from = resolveSpecifier(file.path, st.moduleSpecifier.text, known);
      if (from === null) continue;
      const nb = st.importClause.namedBindings;
      if (nb !== undefined && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
        }
      }
    } else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const from =
        st.moduleSpecifier !== undefined && ts.isStringLiteral(st.moduleSpecifier)
          ? resolveSpecifier(file.path, st.moduleSpecifier.text, known)
          : null;
      if (st.exportClause === undefined) {
        if (from !== null) starExports.push(from);
        continue;
      }
      if (!ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const name = (el.propertyName ?? el.name).text;
        if (st.moduleSpecifier !== undefined) {
          if (from !== null) exports.set(el.name.text, { from, name });
        } else {
          exports.set(el.name.text, { local: name });
        }
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        locals.add(d.name.text);
        if (hasExport(st)) exports.set(d.name.text, { local: d.name.text });
      }
    } else if (ts.isFunctionDeclaration(st) && st.name !== undefined) {
      locals.add(st.name.text);
      if (hasExport(st)) exports.set(st.name.text, { local: st.name.text });
    }
  }
  return { sf, imports, exports, starExports, locals };
}

/** 公開名を、宣言した元（ファイルと名前）までたどる。 */
function resolveExport(
  infos: ReadonlyMap<string, ModuleInfo>,
  file: string,
  name: string,
  depth = 0,
): { file: string; name: string } | null {
  if (depth > 20) return null;
  const info = infos.get(file);
  if (info === undefined) return null;
  const ex = info.exports.get(name);
  if (ex !== undefined) {
    if ('local' in ex) {
      const imp = info.imports.get(ex.local);
      if (imp !== undefined) return resolveExport(infos, imp.from, imp.name, depth + 1);
      return { file, name: ex.local };
    }
    return resolveExport(infos, ex.from, ex.name, depth + 1);
  }
  for (const star of info.starExports) {
    const r = resolveExport(infos, star, name, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

interface UseRecord {
  readonly file: string;
  readonly line: number;
  /** 表の名前のあとのキーの並び（`X.a.b` なら ['a','b']）。まるごと使ったなら null。 */
  readonly keys: readonly string[] | null;
}

/** あるファイルの中で、局所の名前 `local` が使われている所。 */
function usesOf(info: ModuleInfo, file: string, local: string): UseRecord[] {
  const out: UseRecord[] = [];
  const { sf } = info;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === local) {
      const p = n.parent;
      const skip =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        ts.isImportSpecifier(p) ||
        ts.isExportSpecifier(p) ||
        ts.isTypeQueryNode(p) ||
        ts.isQualifiedName(p) ||
        (ts.isVariableDeclaration(p) && p.name === n) ||
        (ts.isFunctionDeclaration(p) && p.name === n) ||
        ts.isImportClause(p) ||
        (ts.isMethodDeclaration(p) && p.name === n) ||
        (ts.isParameter(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.name === n && p.propertyName !== undefined);
      if (!skip) {
        const keys: string[] = [];
        let cur: ts.Node = n;
        while (ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) {
          keys.push(cur.parent.name.text);
          cur = cur.parent;
        }
        out.push({ file, line: lineOf(sf, n), keys: keys.length === 0 ? null : keys });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// 画面（参照元のディレクトリから）
// ---------------------------------------------------------------------------

const UI_DIR_SCREEN: Readonly<Record<string, string>> = {
  shell: '枠（アプリバー・メニュー・道具・オプションバー・状態行）',
  timeline: '時刻レール',
  time: '時刻レール',
  property: '素性欄・詳細・削除の確認',
  map: '地図の上の操作',
  'file-ops': 'ファイル（開く・保存・修復・以前の保存）',
  conflict: '重なりの解決',
  discovery: '地物一覧・検索・診断',
  settings: '設定',
  add: '描く道具',
  knife: '分ける道具',
  drill: '穴あけの道具',
  merge: '結合の道具',
  reparent: '所属を変える道具',
  'ring-edit': '輪郭の道具',
  survey: '測量',
  'help-tools': 'ヘルプ・ツール（バージョン・ショートカット・診断）',
  coloring: '自動配色',
};

const DOMAIN_DIR_SCREEN: Readonly<Record<string, string>> = {
  'context-menu': '右クリックのメニュー',
  persistence: 'ファイル（開く・保存・修復・以前の保存）',
  knife: '分ける道具',
  drill: '穴あけの道具',
  merge: '結合の道具',
  affiliation: '所属を変える道具',
  deletion: '素性欄・詳細・削除の確認',
  basemap: '背景地図',
  consistency: '重なりの解決',
  coloring: '自動配色',
  promotion: '所属を変える道具',
  survey: '測量',
};

/** 参照元のファイル 1 本が属する画面（中核の処理側のファイルは null＝そこからは決めない）。 */
export function screenOfFile(path: string): string | null {
  if (path === 'src/ui/App.tsx') return 'アプリ全体（App.tsx）';
  const ui = /^src\/ui\/([^/]+)\//.exec(path);
  if (ui !== null) return UI_DIR_SCREEN[ui[1] ?? ''] ?? `画面側 ${ui[1] ?? ''}`;
  if (/^src\/ui\/[^/]+$/.test(path)) return 'アプリ全体（ui 直下）';
  if (path.startsWith('src/shell/main/')) return 'OS のダイアログ・保存の断り（本体側）';
  if (path.startsWith('src/shell/')) return 'ファイルの読み書きの断り（本体側）';
  if (path.startsWith('src/render/')) return '地図に描く文字';
  return null;
}

function inferredScreen(path: string): string | null {
  const d = /^src\/domain\/([^/]+)\//.exec(path);
  if (d === null) return null;
  return DOMAIN_DIR_SCREEN[d[1] ?? ''] ?? `中核 ${d[1] ?? ''}`;
}

// ---------------------------------------------------------------------------
// 目録を組む
// ---------------------------------------------------------------------------

export async function buildCatalog(input: CatalogInput): Promise<Catalog> {
  const known = new Set(input.files.map((f) => f.path));
  const tableFiles = input.files.filter(
    (f) => f.path.startsWith('src/') && isUiTextTableFile(f.path) && !isTestFile(f.path),
  );
  const infos = new Map<string, ModuleInfo>();
  for (const f of input.files) infos.set(f.path, moduleInfo(f, known));

  // 1. 表の見出し語と、実行時の値
  const loadErrors: { file: string; error: string }[] = [];
  const raws: RawEntry[] = [];
  const modules = new Map<string, Readonly<Record<string, unknown>>>();
  for (const f of tableFiles) {
    raws.push(...collectTableEntries(f));
    try {
      modules.set(f.path, await input.loadModule(f.path));
    } catch (error) {
      loadErrors.push({ file: f.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 2. 参照: どのファイルのどの局所名が、どの表の宣言を指しているか
  const usesByTable = new Map<string, UseRecord[]>(); // `${file}#${table}`
  const tablePaths = new Set(tableFiles.map((t) => t.path));
  const addUses = (target: { file: string; name: string }, uses: readonly UseRecord[]): void => {
    const k = `${target.file}#${target.name}`;
    const list = usesByTable.get(k) ?? [];
    list.push(...uses);
    usesByTable.set(k, list);
  };
  for (const [path, info] of infos) {
    for (const [local, imp] of info.imports) {
      const target = resolveExport(infos, imp.from, imp.name);
      if (target === null || !tablePaths.has(target.file)) continue;
      addUses(target, usesOf(info, path, local));
    }
    // 表のファイルの中で自分の宣言を使っている所（関数が別の見出し語を引くなど）
    if (tablePaths.has(path)) {
      for (const local of info.locals) addUses({ file: path, name: local }, usesOf(info, path, local));
    }
  }

  // 3. 見出し語ごとに組む
  // 表をまるごと使った所: キーが無い、またはキーの並びがどの見出し語にも届かない（`X.sub[kind]` など）
  const entryKeys = new Map<string, string[][]>();
  for (const raw of raws) {
    if (raw.key === null) continue;
    const k = `${raw.file}#${raw.table}`;
    const list = entryKeys.get(k) ?? [];
    list.push(raw.key.split('.'));
    entryKeys.set(k, list);
  }
  const tableWhole = new Set<string>();
  for (const [k, uses] of usesByTable) {
    const keys = entryKeys.get(k);
    if (keys === undefined) continue;
    const reaches = (u: UseRecord): boolean =>
      u.keys !== null && keys.some((parts) => parts.every((p, i) => u.keys?.[i] === p));
    if (uses.some((u) => !isTestFile(u.file) && !reaches(u))) tableWhole.add(k);
  }
  const partial: Omit<CatalogEntry, 'sameTextGroup'>[] = [];
  for (const raw of raws) {
    const tableKey = `${raw.file}#${raw.table}`;
    const mod = modules.get(raw.file);
    const value = raw.exported && mod !== undefined ? runtimeValue(mod, raw) : undefined;
    let kind: EntryKind = 'other';
    let ev: Evaluated;
    const node = raw.node;
    if (!raw.isFunction && (ts.isStringLiteral(node as ts.Node) || ts.isNoSubstitutionTemplateLiteral(node as ts.Node))) {
      kind = 'text';
      const text = (node as ts.StringLiteral).text;
      ev = { evaluation: 'literal', text, pattern: [text], samples: [] };
    } else if (typeof value === 'string') {
      kind = 'text';
      ev = { evaluation: 'literal', text: value, pattern: [value], samples: [] };
    } else if (raw.isFunction) {
      kind = 'function';
      ev = evaluateFunction(value, raw.params);
    } else {
      ev = { evaluation: 'failed', text: null, pattern: null, samples: [] };
    }
    const uses = usesByTable.get(tableKey) ?? [];
    const keyParts = raw.key === null ? [] : raw.key.split('.');
    const mine = uses.filter((u) =>
      raw.key === null
        ? true
        : u.keys !== null && keyParts.every((k, i) => u.keys?.[i] === k),
    );
    // 表の中の関数が自分自身の定義の中で自分を指すことは無いので、そのまま数える
    const refs = mine.filter((u) => !isTestFile(u.file)).map((u) => ({ file: u.file, line: u.line }));
    const testRefs = mine.filter((u) => isTestFile(u.file)).map((u) => ({ file: u.file, line: u.line }));
    const screenNames = new Map<string, boolean>();
    for (const r of refs) {
      const s = screenOfFile(r.file);
      if (s !== null) screenNames.set(s, false);
    }
    if (screenNames.size === 0) {
      for (const r of refs) {
        const s = inferredScreen(r.file);
        if (s !== null) screenNames.set(s, true);
      }
      const own = screenOfFile(raw.file) ?? inferredScreen(raw.file);
      if (screenNames.size === 0 && own !== null) screenNames.set(own, screenOfFile(raw.file) === null);
    }
    partial.push({
      id: `${raw.file}#${raw.table}${raw.key === null ? '' : `.${raw.key}`}`,
      file: raw.file,
      layer: layerOf(raw.file),
      table: raw.table,
      exported: raw.exported,
      key: raw.key,
      line: raw.line,
      kind,
      evaluation: ev.evaluation,
      text: ev.text,
      pattern: ev.pattern,
      params: raw.params,
      samples: ev.samples,
      fragments: raw.fragments,
      refs,
      testRefs,
      tableUsedWhole: raw.key !== null && tableWhole.has(tableKey),
      screens: [...screenNames].map(([name, inferred]) => ({ name, inferred })),
    });
  }

  // 4. 同じ文のまとめ
  const byText = new Map<string, number[]>();
  partial.forEach((e, i) => {
    if (e.text === null || e.text === '') return;
    const list = byText.get(e.text) ?? [];
    list.push(i);
    byText.set(e.text, list);
  });
  const groupOf = new Map<number, number>();
  let groups = 0;
  for (const list of byText.values()) {
    if (list.length < 2) continue;
    groups += 1;
    for (const i of list) groupOf.set(i, groups);
  }
  const entries: CatalogEntry[] = partial.map((e, i) => ({ ...e, sameTextGroup: groupOf.get(i) ?? null }));

  const count = <K extends string>(f: (e: CatalogEntry) => K): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const e of entries) out[f(e)] = (out[f(e)] ?? 0) + 1;
    return out;
  };
  const unrefAll = entries.filter((e) => e.refs.length === 0);
  return {
    generatedAt: input.generatedAt ?? null,
    commit: input.commit ?? null,
    summary: {
      tableFiles: tableFiles.length,
      tables: new Set(entries.map((e) => `${e.file}#${e.table}`)).size,
      entries: entries.length,
      byLayer: count((e) => e.layer),
      byEvaluation: count((e) => e.evaluation),
      sameTextGroups: groups,
      unreferenced: unrefAll.filter((e) => !e.tableUsedWhole).length,
      unreferencedButTableUsedWhole: unrefAll.filter((e) => e.tableUsedWhole).length,
    },
    entries,
    loadErrors,
  };
}

// ---------------------------------------------------------------------------
// 人が読む形（Markdown）
// ---------------------------------------------------------------------------

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
}

function shownText(e: CatalogEntry): string {
  if (e.text !== null) return e.text;
  if (e.fragments.length > 0) return `（呼べない関数。中の文: ${e.fragments.join(' ／ ')}）`;
  return '（文字列ではない）';
}

function sampleCell(e: CatalogEntry): string {
  const s = e.samples.filter((x) => x !== e.text);
  if (s.length === 0) return '';
  return s.slice(0, 4).join(' ／ ') + (s.length > 4 ? ` ／ ほか ${s.length - 4} 通り` : '');
}

export function renderCatalogMarkdown(catalog: Catalog): string {
  const lines: string[] = [];
  const s = catalog.summary;
  lines.push('# 画面の文言の目録');
  lines.push('');
  lines.push(
    `作成: ${catalog.generatedAt ?? '（日時なし）'} ・ コミット: ${catalog.commit ?? '（不明）'} ・ ` +
      `表のファイル ${s.tableFiles} 本・表 ${s.tables} 個・見出し語 ${s.entries} 件` +
      `（同じ文のまとまり ${s.sameTextGroups}・参照 0 件の要確認 ${s.unreferenced}・種類で引く表の見出し語 ${s.unreferencedButTableUsedWhole}）`,
  );
  lines.push('');
  lines.push('札〔…〕は埋め込みの位置。「見本」は見本の値（南ケナ州・1200年・3 件 …）で呼んだ結果。画面に「推定」と書いたものは、参照元からは引けず表の置き場から推した画面。');
  lines.push('');
  if (catalog.loadErrors.length > 0) {
    lines.push('## 読み込めなかった表');
    lines.push('');
    for (const le of catalog.loadErrors) lines.push(`- ${le.file}: ${le.error}`);
    lines.push('');
  }

  // 1. 画面ごと → 参照元の部品ごと
  lines.push('## 1. 画面ごと・部品ごと');
  lines.push('');
  const byScreen = new Map<string, Map<string, CatalogEntry[]>>();
  for (const e of catalog.entries) {
    for (const sc of e.screens) {
      const screen = sc.inferred ? `${sc.name}（推定）` : sc.name;
      const comps = byScreen.get(screen) ?? new Map<string, CatalogEntry[]>();
      const files = new Set(
        e.refs.map((r) => r.file).filter((f) => (screenOfFile(f) ?? inferredScreen(f)) === sc.name),
      );
      if (files.size === 0) files.add(`${e.file}（表のみ）`);
      for (const f of files) {
        const list = comps.get(f) ?? [];
        list.push(e);
        comps.set(f, list);
      }
      byScreen.set(screen, comps);
    }
  }
  for (const screen of [...byScreen.keys()].sort((a, b) => a.localeCompare(b, 'ja'))) {
    lines.push(`### ${screen}`);
    lines.push('');
    const comps = byScreen.get(screen)!;
    for (const comp of [...comps.keys()].sort()) {
      lines.push(`#### ${comp}`);
      lines.push('');
      lines.push('| 識別子 | 文 | 見本 |');
      lines.push('| --- | --- | --- |');
      for (const e of comps.get(comp)!) {
        lines.push(`| \`${cell(e.table + (e.key === null ? '' : `.${e.key}`))}\` | ${cell(shownText(e))} | ${cell(sampleCell(e))} |`);
      }
      lines.push('');
    }
  }

  // 2. 同じ文のまとめ
  lines.push('## 2. 同じ文のまとめ（1 回の判断で全部に効かせる）');
  lines.push('');
  const groups = new Map<number, CatalogEntry[]>();
  for (const e of catalog.entries) {
    if (e.sameTextGroup === null) continue;
    const list = groups.get(e.sameTextGroup) ?? [];
    list.push(e);
    groups.set(e.sameTextGroup, list);
  }
  lines.push('| 文 | 件数 | 見出し語 |');
  lines.push('| --- | ---: | --- |');
  for (const list of [...groups.values()].sort((a, b) => b.length - a.length)) {
    lines.push(`| ${cell(list[0]!.text ?? '')} | ${list.length} | ${cell(list.map((e) => `\`${e.id}\``).join(' '))} |`);
  }
  lines.push('');

  // 3. 参照 0 件
  lines.push('## 3. 実装からの参照が 0 件の見出し語（要確認。削除候補ではない）');
  lines.push('');
  lines.push('| 識別子 | 文 | 検査からの参照 |');
  lines.push('| --- | --- | ---: |');
  for (const e of catalog.entries.filter((x) => x.refs.length === 0 && !x.tableUsedWhole)) {
    lines.push(`| \`${cell(e.id)}\` | ${cell(shownText(e))} | ${e.testRefs.length} |`);
  }
  lines.push('');
  lines.push('## 4. 表がまるごと使われていて、見出し語の名前では引かれていないもの（種類で引く表）');
  lines.push('');
  lines.push('| 識別子 | 文 |');
  lines.push('| --- | --- |');
  for (const e of catalog.entries.filter((x) => x.refs.length === 0 && x.tableUsedWhole)) {
    lines.push(`| \`${cell(e.id)}\` | ${cell(shownText(e))} |`);
  }
  lines.push('');

  // 5. 呼べなかった関数
  lines.push('## 5. 呼べなかった関数（札入りの文を作れなかった）');
  lines.push('');
  for (const e of catalog.entries.filter((x) => x.kind === 'function' && x.evaluation === 'failed')) {
    lines.push(`- \`${e.id}\`（${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')}）${e.fragments.length > 0 ? ` 中の文: ${e.fragments.join(' ／ ')}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}
