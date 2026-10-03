// 「利用者に見える文字列は文言の表から引く」の規則の、ただ 1 つの定義
// （開発ガイド §5.99 / 案/文言総点検-やり方の提案.md §5）。
//
// ESLint（`eslint.config.js` の no-restricted-syntax）と単体の走査
// （`src/ui/shell/ui-text-tables.test.ts`）の両方がここを読む。片方だけ直して
// 「lint は通るのに単体が赤い」（またはその逆）にならないよう、文字の範囲・表のファイル・
// 除外の一覧はここにしか書かない（開発ガイド §4 単一の真実源）。

/**
 * 日本語とみなす文字の範囲（正規表現の文字クラスの中身。`\u` の綴りのまま持つ）。
 * - U+3000–303F: 和文の句読点・かぎ括弧（、。「」〜 など）
 * - U+3040–30FF: ひらがな・カタカナ（・ を含む）
 * - U+3400–4DBF, U+4E00–9FFF: 漢字
 * - U+FF00–FFEF: 全角の英数・記号（（）：！ など）
 */
export const UI_TEXT_CHAR_CLASS =
  '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef';

/** 直書きを拾う属性（言語を問わず、空でない直書きを拾う）。 */
export const UI_TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

/**
 * 文言の表（ここに日本語を書く）。層ごとに置く: 画面側 `src/ui/**`、中核の処理側
 * `src/domain/**`、Electron の本体側 `src/shell/**`（中核は画面側を読み込めないため）。
 * `○○-strings.ts`／`○○-messages.ts` は、ひとまとまりの文を独立に置く表である。同じ
 * ディレクトリの `strings.ts`／`messages.ts` へ足すと import が輪になる所（表が、読み込む側の
 * module を自身で読み込んでいる）や、元のファイルの中で既に名前の付いた表になっていたものを
 * まるごと移した所に使う。どれも何も読み込まない。
 */
export const UI_TEXT_TABLE_FILES = [
  'src/**/strings.ts',
  'src/**/messages.ts',
  'src/**/*-strings.ts',
  'src/**/*-messages.ts',
];

/**
 * 規則の対象から外すファイル（理由つき）。1 行ずつの例外は、その行の直前に
 * `// eslint-disable-next-line no-restricted-syntax -- 理由` を書く（単体の走査も同じ注記を読む）。
 */
export const UI_TEXT_EXEMPT_FILES = [
  // 検査そのもの（画面の文を一字一句固定する検査は直書きでよい＝開発ガイド §5.64 の例外）
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/**/*.test-d.ts',
  'src/test-support/**',
  'src/test-setup.ts',
  'src/test-setup-dom.ts',
  // 見本データ（検査と E2E が読み込む作り物の地物。画面の文言ではない）
  'src/**/fixtures.ts',
  'src/**/fixtures-*.ts',
  'src/ui/e2e/**',
  // 性能の計測（開発者が読む計測の札と、計測用の作り物のデータ）
  'src/domain/perf/**',
  'src/render/perf/**',
  // 診断ログの表（ログのファイルにだけ書く文。画面には出さない）
  'src/shell/main/close-guard-log.ts',
];

/** 文字列の glob（`**` と `*` だけ）を、`/` 区切りの相対パスに当てる正規表現にする。 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` は 0 個以上のディレクトリ、末尾の `**` は何でも
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** リポジトリ直下からの相対パス（`/` 区切り）が文言の表か。 */
export function isUiTextTableFile(relPath) {
  return UI_TEXT_TABLE_FILES.some((g) => globToRegExp(g).test(relPath));
}

/** リポジトリ直下からの相対パス（`/` 区切り）が規則の対象外か。 */
export function isUiTextExemptFile(relPath) {
  return UI_TEXT_EXEMPT_FILES.some((g) => globToRegExp(g).test(relPath));
}

/** ESLint の no-restricted-syntax に渡す条件（文字列・テンプレートの部分・JSX の本文・属性）。 */
export function uiTextRestrictedSyntax() {
  const ja = `/[${UI_TEXT_CHAR_CLASS}]/u`;
  const attrs = UI_TEXT_ATTRIBUTES.join('|');
  const where =
    '利用者に見える文字列は文言の表（画面側 src/ui/**/strings.ts 等・中核 src/domain/**/messages.ts・本体側 src/shell/**/strings.ts）から引く（開発ガイド §5.99）';
  return [
    { selector: `Literal[value=${ja}]`, message: `日本語の直書き。${where}` },
    { selector: `TemplateElement[value.raw=${ja}]`, message: `テンプレート文字列の日本語の直書き。${where}` },
    { selector: `JSXText[value=${ja}]`, message: `JSX の本文の日本語の直書き。${where}` },
    {
      selector: `JSXAttribute[name.name=/^(${attrs})$/] > Literal[value=/\\S/]`,
      message: `画面に出る属性（${UI_TEXT_ATTRIBUTES.join('・')}）の直書き（言語を問わない）。${where}`,
    },
  ];
}
