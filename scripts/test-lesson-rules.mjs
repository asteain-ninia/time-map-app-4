// テストの書き方の教訓を止める検査の、設定値と対象の一覧のただ 1 つの置き場
// （開発ガイド §1.6。`scripts/ui-text-rule.mjs` と同じ作り）。
//
// ESLint（`eslint.config.js`）、単体の走査（`src/test-support/test-lesson-rules.test.ts`）、
// E2E（`e2e/inc4-ledger.spec.ts`）がここを読む。

// ---- §5.40 直接利用する依存は直接依存として宣言する ----

/**
 * `devDependencies` を読み込んでよいファイル。ここに無いファイル（アプリの本体）は
 * `dependencies` だけを読み込める。
 */
export const DEV_DEPENDENCY_FILES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test-d.ts',
  '**/*.config.ts',
  '**/*.config.js',
  '**/scripts/**',
  '**/e2e/**',
  '**/src/test-support/**',
  '**/src/test-setup.ts',
  '**/src/test-setup-dom.ts',
  '**/fixtures.ts',
  '**/fixtures-*.ts',
  '**/arbitraries.ts',
  '**/*-arbitraries.ts',
  '**/*.arbitraries.ts',
];

/**
 * package.json に載らなくてよい読み込み先。`electron` は開発依存に置くのが作法で、本体側
 * （`src/shell/**`）が実行時に読むのはアプリに同梱された本物なので、依存の宣言の検査から外す。
 */
export const CORE_MODULES = ['electron'];

// ---- §5.57 テストはソースや CSS を生のまま読まない ----

/** 生テキストの読み込みを禁じるファイル（テストと、テストの道具）。 */
export const RAW_TEXT_READ_FILES = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/test-support/**/*.ts',
  'e2e/**/*.ts',
];

/** 改行を揃える入口そのものは読んでよい。 */
export const RAW_TEXT_READ_EXEMPT_FILES = ['src/test-support/read-source-text.ts'];

/**
 * ESLint の no-restricted-syntax に渡す条件。文字コードを渡す読み込みと、読んだものの文字列化を
 * 拾う。バイト列のまま読む `readFileSync(path)`（ZIP の中身や、バイトの一致の比較）は通す。
 * 例外は直前の行の `// eslint-disable-next-line no-restricted-syntax -- 理由`。
 */
export function rawTextReadRestrictedSyntax() {
  const message =
    'テストは生テキストを readFileSync で読まず、src/test-support/read-source-text.ts の readSourceText を通す（改行を揃える唯一の入口。開発ガイド §5.57）。テストの出力など、ソースや CSS でないものを読むなら理由を添えて eslint-disable-next-line する';
  const read = '/^(readFileSync|readFile)$/';
  return [
    { selector: `CallExpression[callee.name=${read}][arguments.length>=2]`, message },
    { selector: `CallExpression[callee.property.name=${read}][arguments.length>=2]`, message },
    {
      selector: `CallExpression[callee.property.name='toString'][callee.object.callee.name=${read}]`,
      message,
    },
  ];
}

// ---- §5.64 と §5.39 の走査 ----

/** 走査の対象（リポジトリ直下からの相対パス）。 */
export const SCAN_TEST_FILE_PATTERN = /\.test\.tsx?$|^e2e\/.*\.ts$/;
/** §5.39 では、検査が使う見本の組み立ても対象に足す。 */
export const SCAN_FIXTURE_FILE_PATTERN = /(^|\/)fixtures[^/]*\.ts$|(^|[/.-])arbitraries\.ts$/;

/** §5.64: 画面の言葉を当てて要素を探す呼び出しの、探し方の部分。 */
export const TEXT_QUERY_NAME_PATTERN =
  /^(?:get|getAll|find|findAll|query|queryAll)By(Role|Text|LabelText|Label|PlaceholderText|Placeholder|Title|AltText|DisplayValue)$/;

/**
 * §5.64 の例外の注記。直前の行に `// 文言の固定: 理由` と書く。「この日本語が出ること」自体を
 * 固定する回帰の検査だけに使う。
 */
export const TEXT_LOCK_NOTE = '文言の固定:';

/**
 * §5.39 の例外の注記。直前の行に `// キャストの例外: 理由` と書く。型を満たさない入力を
 * わざと渡す検査（読み込みの境界が壊れた入力を断るか、など）だけに使う。
 */
export const CAST_NOTE = 'キャストの例外:';

/**
 * 既存の違反の件数。増えたら赤。減らしたら赤にして、ここの数も下げさせる（下げ忘れると、
 * その分だけまた増やせてしまう）。
 */
export const VIOLATION_LIMITS = {
  /** §5.64 テストの中で、要素を探す言葉に日本語を直書きしている所。 */
  textQueryLiterals: 219,
  /** §5.39 オブジェクトリテラルをドメイン型へキャストしている所。 */
  domainLiteralCasts: 39,
};

// ---- §5.65 見た目のベースラインの置き場 ----

/** `playwright.config.ts` の `snapshotPathTemplate` のあるべき値。 */
export const SNAPSHOT_PATH_TEMPLATE =
  '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}';

/** `e2e/` の下にあるべきベースラインの全部。足すときはここにも足す。 */
export const SNAPSHOT_FILES = {
  'sidebar-property.spec.ts-snapshots': [
    'sidebar-empty-win32.png',
    'sidebar-property-populated-win32.png',
  ],
  'ux-cluster.spec.ts-snapshots': ['shell-no-scrollbars-win32.png', 'timeline-readable-win32.png'],
};

// ---- §5.60 大規模データの E2E ----

/**
 * 5,000 件の合成データを載せて一覧の件数に出るまでの上限（ミリ秒）。実測は単独で 0.3 秒弱、
 * 全件の E2E と単体を同時に回しても 0.4 秒弱。崩れた形（1 本の錨に全部詰める）は 10 分でも
 * 終わらないので、その間の十分に余裕のある値にする。
 */
export const SYNTHETIC_LOAD_LIMIT_MS = 30_000;
