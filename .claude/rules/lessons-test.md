---
paths:
  - "e2e/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "vitest.config.ts"
  - "playwright.config.ts"
  - "src/ui/e2e/**"
  - "src/ui/map/mount/observation.ts"
---

# テストの書き方の教訓

番号は変えない。コードや文書が「開発ガイド §5.N」として参照している。

### 5.39 テスト fixture は実体クラスをインスタンス化する
- 正しい道: 複合的なドメイン構造の fixture は実物のファクトリ関数で作る（`createVertex` などの生成関数、`src/domain/deletion/fixtures.ts`、`src/domain/editing/fixtures.ts`、`*.arbitraries.ts`）。ドメインの値はクラスでなく、ファクトリが返すプレーンな値である。
- 誤った道の兆候: リテラルオブジェクトをキャストして型を満たしている。未参照プロパティの欠落が現状のテスト経路では沈黙通過し、後で別経路が参照したとき沈黙して失敗する。構造的型付けやキャストは欠落を検出しない。
- 確かめ方: `src/test-support/test-lesson-rules.test.ts` の「既存の件数を超えない（§5.39）」が、検査と見本の組み立ての中の `{...} as ドメイン型` を数える。既存の分は `scripts/test-lesson-rules.mjs` の `VIOLATION_LIMITS.domainLiteralCasts` を上限にし、増えると赤。減らしたらその数も下げる。壊れた入力をわざと渡す検査は、直前の行に `// キャストの例外: 理由` を書く。手本は `src/domain/ring-hierarchy.test.ts`、`src/domain/anchor-series.arbitraries.ts`。

### 5.49 レイアウトを持たないテスト環境で寸法を測ると、その検査は永久に緑になる
- 正しい道: 寸法は二段で守る。(1) 寸法の真実源である CSS の宣言そのものを読む契約テスト、(2) 実際にレイアウトする E2E での実寸比較。測る対象は「守りたいものが動かないこと」で選ぶ（「帯が動かない」でなく「帯の中身が変わっても地図セルが動かない」）。
- 誤った道の兆候: jsdom の単体テストで `getBoundingClientRect()`／`offsetWidth` を比べている（常に 0 で必ず一致する）。全幅 × 固定高の帯どうしを比べている（中身に関わらず一致する）。わざと壊しても赤くならない寸法の assertion。
- 確かめ方: `src/ui/shell/shell-layout.test.ts`（`--shell-optionbar-h: 40px`／`flex: 0 0 240px`／`flex-wrap: nowrap`／`overflow: hidden` を読む）、`src/ui/property/property-layout.test.ts`、`src/ui/add/add-input-layout.test.tsx`（入力層の `inset` の契約）、E2E は `e2e/option-bar.spec.ts`・`e2e/inc5-shell.spec.ts`。寸法の assertion を書いたらわざと壊して赤を確かめる。

### 5.52 作業ディレクトリのドライブ文字の大小で、テストの実行環境（jsdom / node）が静かに外れる
- 正しい道: `vitest.config.ts` の `test.dir` がドライブ文字を大文字に揃える。vitest は `environmentMatchGlobs` の glob のドライブ文字を必ず大文字にするが、集めたファイルのパスは cwd の綴りのまま持つので、起点を揃えると小文字の cwd でも当たる。環境割り当てを持つ設定（`environmentMatchGlobs`・`poolMatchGlobs`・`include`）は、効いている観測値を先に押さえてから中身を疑う。
- 誤った道の兆候: `document is not defined` が大量に出る（`.test.tsx` が node で走る。76 本中 62 本が失敗した）。締めくくりの行が `environment 0ms`（効いていれば数百 ms）。`--environment jsdom` で 1 本だけ通して済ませる（症状を隠すだけで全件には効かない）。`root` を大文字にする（読み込み済みの vitest 本体が別物として読まれ、全部の検査が「Vitest failed to find the current suite」で落ちる）。
- 確かめ方: `src/test-support/vitest-environment.test.tsx` が、`.test.tsx` で `document` が無いと原因を書いて赤くなる。小文字の cwd の再現は `spawnSync('npx vitest run', { cwd: 'e:\\…', shell: true })`（シェルの `cd` は大文字へ直るので再現にならない）。`src/test-support/vitest-include.test.ts` は include の取りこぼしを見る。

### 5.54 E2E で入力欄のフォーカスを外すために、選択を変える場所を押さない
- 正しい道: 大域ショートカット（Ctrl+Z / Ctrl+K 等）を送る前は、押しても何も起きない場所（状態行の表示やパネルの見出し）を押してフォーカスを外す。送る直前と直後に `app-active-feature` を読んで同じであることを確かめる。
- 誤った道の兆候: フォーカス外しに地図を押している（地図クリックは選び直しで、錨が意図と別の地物に作られ、テストは緑のまま別のことを検査する）。
- 確かめ方: `e2e/anchor-edit-time.spec.ts` の `blurForShortcut`（`statusbar-result` を押す）と、その前後の `app-active-feature` の比較。この形はこの spec にしか無く、共通ヘルパではない。

### 5.57 ファイルを書き換える道具の既定の改行で、生テキストを読む契約テストが落ちる
- 正しい道: テストがソースや CSS を生テキストとして読むときは `src/test-support/read-source-text.ts` の `readSourceText` を通す（改行を LF に揃える唯一の入口）。スクリプトでファイルを書き戻すときは元の改行を読み取って同じもので書く（バイナリの読み書きが確実）。
- 誤った道の兆候: Python の `open(path, 'w')` のようにプラットフォーム既定の改行で書き戻す。新しい検査が `readFileSync` で読み、改行をまたぐ正規表現で照合している。「CSS の規則が見つからない」「直書き走査が急に 0 件になる」（実装より先に改行を疑う。CR の有無は shell の `grep` でなくバイト列を数える）。
- 確かめ方: `.gitattributes`（`* text=auto eol=lf`）がリポジトリ内を LF に固定する。作業ツリーの実態は `git ls-files --eol` で見る（`src` はいまも CRLF と LF が混在）。ESLint の `no-restricted-syntax`（条件は `scripts/test-lesson-rules.mjs` の `rawTextReadRestrictedSyntax`）が、テストと E2E で文字コードを渡す `readFileSync`／`readFile` と、読んだものの `toString()` を赤くする。バイト列のままの読み込みは通す。ソースや CSS でないものを読むなら `// eslint-disable-next-line no-restricted-syntax -- 理由` を書く。

### 5.59 一覧を仮想スクロールにすると、「行の DOM 数」を数えていた検査が静かに嘘になる
- 正しい道: 件数の真実源を画面の 1 か所に決め（一覧の件数表示 `unified-list-count`）、数える口を共通ヘルパ 1 本へ寄せる（`e2e/helpers.ts` の `listedFeatureCount`）。写しがあれば全部寄せる（§5.44）。
- 誤った道の兆候: `page.locator('[data-testid^="feature-list-item-"]').count()` で件数を見ている（例外を投げず小さい数を返し、「地物が 3 つ」が「窓に 3 行入っていた」で緑になる）。描かれた図形の数を DOM で数える検査（canvas 化で同じ壊れ方をする）。「画面に出ている数」と「データの数」が一致しなくなる変更全般。
- 確かめ方: `e2e/inc4-ledger.spec.ts`（5,000 件で `listedFeatureCount` が 5000、DOM の行は 20 個以下）。写しの `featureListCount` は 17 本残るが、確認した本体は `listedFeatureCount` への委譲である。仮想化を入れたら、わざと件数を 1 件増減して件数の検査が赤くなるかを見る。

### 5.60 大規模データの検査を「1 つのスナップショットに全部詰める」形で作ると、fixture の作り方を測ってしまう
- 正しい道: 規模の検査の合成データは、実データの構造（1 件あたり何を持つか）を数えてから、その場で組む。実データの形は 1 履歴＝自分と自分の頂点だけのスナップショット。
- 誤った道の兆候: 件数だけ真似て 1 本の錨に全部詰める（5,000 件を 1 本に詰めて 5,000 本の履歴から指すと、`featuresAt` が履歴数 × 地物数＝2,500 万回の走査になり、E2E が 10 分でも終わらなかった）。「検査が終わらない」を「アプリが遅い」と読む（まず fixture の形を疑う）。
- 確かめ方: `src/ui/e2e/synthetic-project.ts`（1 件ごとに頂点 4 つと錨 1 本を作る）と `e2e/inc4-ledger.spec.ts` の「5,000 行の合成データでも…」。載せて件数に出るまでを `withinLoadLimit` が上限（`scripts/test-lesson-rules.mjs` の `SYNTHETIC_LOAD_LIMIT_MS`）で打ち切り、原因を書いて赤くなる。

### 5.62 `toBeVisible()` は、先祖のスクロール範囲の外にある要素も「見えている」と判定する
- 正しい道: 「画面に出ている」「読める」「押せる」は矩形の交差で見る。要素と器の両方の `getBoundingClientRect()` を取り、`min(bottom) - max(top) > 0` を数える。器と交差している行を数える小さな関数を spec に 1 つ置いて全部そこを通し、窓は 2 つ以上（既定・最小）で回す。
- 誤った道の兆候: 表示の保証を `toBeVisible()` だけで固定している（行が器の下 23px から始まって 1 行も読めないのに緑だった）。`toBeInViewport()` で代用する（窓との交差しか見ないので、窓の中で器の外という状態を通す）。
- 確かめ方: `e2e/inc4-ledger.spec.ts` の `rowsInsidePanel`、`e2e/inc6-rail.spec.ts` の交差の検査。「1 行も見えない」をわざと作って赤を確かめる。`toBeVisible()` の使い方を制限する lint は無い。

### 5.63 同じコミットで撮った基準画像が、そのコミットの最終コードで撮られているとは限らない
- 正しい道: 基準画像は変更単位の最後に、全件ゲート（build → typecheck → lint → test → e2e）を通したコードで撮り直す。撮り直したら進捗報告の「何が写っているか」も実物に合わせる。
- 誤った道の兆候: 直しの途中で基準画像を撮っている、「画像を撮る → さらに直す」の順で進めている（消したはずの行「◀ 前へ（まとまりなし）」が写った画像が入り、現物と違う姿を正しい姿として固定した）。
- 確かめ方: 画像を含むコミットで、画像の撮影時刻と最後のソース変更の時刻を比べ、撮影が先なら撮り直す。自動の検査は無い。基準画像は `e2e/sidebar-property.spec.ts-snapshots/` と `e2e/ux-cluster.spec.ts-snapshots/` の計 4 枚。
- 検査: 未整備。手で確かめる。

### 5.64 画面の言葉を直書きした検査は、言い換えのたびに置き去りになる
- 正しい道: 検査も実装と同じ文言表を import して参照する（例: `DISPLAY_CONTROL_STRINGS`）。言い換えは 1 か所で済み、検査は「その言葉が何であれ、そのボタンを押す」という意図だけを固定する。「この日本語が出る」こと自体を固定する回帰ロックだけは直書きでよく、そうと分かるコメントを添える。
- 誤った道の兆候: `getByRole('button', { name: '階層深度を上げる' })` のような直書き（実装と E2E は表を通していたのに単体だけ古い言葉で落ちた）。言い換えのあと旧語を実装だけで探して終える。もっと悪い形は「テストは通るのに画面が違う」。
- 確かめ方: 言い換えたら旧語を `src/` と `e2e/` の両方へ grep する。`src/ui/map/GlobalDepthControl.test.tsx` が表を参照する形の見本、`e2e/inc8c-survey.spec.ts` が例外の考え方の見本。`src/test-support/test-lesson-rules.test.ts` の「既存の件数を超えない（§5.64）」が、要素を探す言葉（`getByRole` の `name`、`getByText` など、`locator` の文字列、`hasText`）の日本語の直書きを数える。既存の分は `scripts/test-lesson-rules.mjs` の `VIOLATION_LIMITS.textQueryLiterals` を上限にし、増えると赤。減らしたらその数も下げる。「この日本語が出ること」の固定は、直前の行に `// 文言の固定: 理由` を書く。`toHaveText`／`toContainText` は表示の確かめなので数えない。`ui-text-rule.mjs` の規則は実装側だけが対象。

### 5.65 見た目のベースラインの置き場を組み立て直すときは、既定の書式から「消す部分」だけを消す
- 正しい道: `snapshotPathTemplate` は既定の書式を丸ごと写し、要らない差し込み（`{-projectName}`）だけを削る。現在の値は `{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}`。`projects` を足すときはベースラインの命名を既定のままにしない。
- 誤った道の兆候: 書式をゼロから書く、先頭の `{snapshotDir}/` を落とす（`{testFileDir}` は testDir からの相対で直下の spec では空文字なので、ドライブの直下に `*-snapshots/` が生えた）。「A snapshot doesn't exist at …, writing actual」で落ちている（リポジトリの中は何も変わらない）。「新しいベースラインが増えた」を成功と読む（`sidebar-empty-win32.png` が `sidebar-empty-main-win32.png` を探す形になり、追認すると古いほうが死ぬ）。検査の入力を名前の規則で引き当てる仕組み全般が同じ型で、引き当て失敗が「無いので作る」に吸収される。
- 確かめ方: `src/test-support/test-lesson-rules.test.ts` の §5.65 が、`snapshotPathTemplate` の値、`e2e/` の下のベースラインの顔ぶれ、リポジトリ直下・親・ドライブ直下に `*.spec.ts-snapshots` が無いことを見る。あるべき値は `scripts/test-lesson-rules.mjs` の `SNAPSHOT_PATH_TEMPLATE`・`SNAPSHOT_FILES`。ベースラインを足すときはそこにも足す。

### 5.79 観測フックのグローバルを「誰かの mount/unmount で丸ごと差し替える」なら、他の部品は登録簿を経由させる
- 正しい道: `window.__E2E__` の書き手は 1 つ（`src/ui/map/mount/observation.ts`）に保ち、他の部品は登録簿（`publish` / `read`。`src/ui/e2e/rail-observation.ts`、操作の口は `src/ui/e2e/harness.ts`）へ置く。部品が載っていなくても口は生やして既定値を返す（`ABSENT_LANE_STATS`）。
- 誤った道の兆候: 部品が `window.__E2E__` へ直接プロパティを足す。地図が載り直すと黙って消え、テストからは「口が無い」と「値が 0」が区別できない。
- 確かめ方: 観測を足した部品と差し替える部品の両方が載った状態で口を呼ぶ。`e2e/inc6-rail.spec.ts`（`getAnchorLaneStats` を読む検査）。

### 5.80 テストの対象は明示の一覧で決まる ―― ファイルを新しいディレクトリへ移すと、検査が黙って走らなくなる
- 正しい道: 明示列挙の設定（`vitest.config.ts` の `include`）があるときは、ファイルを移す変更で一覧も更新し、新しいディレクトリだけを名指しして走らせ件数が 0 でないことを見る。同じ穴: Playwright の `testMatch`、lint の対象、`tsconfig.*.json` の `include`。
- 誤った道の兆候: 新しい置き場へ移して型検査も lint も `npm run test` も緑（件数は増減するので減ったことに気づけない）。単体で名指しすると `No test files found` が出る。
- 確かめ方: `src/test-support/vitest-include.test.ts`（`src` の全テストがどれかの `include` に当たるかを見る）。`npx vitest run <新しいディレクトリ>`。E2E の `main` は `testIgnore` 方式なので新しい置き場も走るが、`explore` / `tour` の `testMatch` と tsconfig は未検査。

### 5.83 検査の「余裕」は、名指しできるものを名指ししてから残す
- 正しい道: 覆ってよい部品を数ではなく顔ぶれ（集合）で書く。「いま開いている板」（何点覆ってもよい）と「常設の部品」（数える）を分ける。上限の数は後退の見張りとして残してよいが、いま何が起きているかを言い当てる検査を並べる。
- 誤った道の兆候: 「25 点中 21 点届けばよい」のような数の余裕（実際は 1 点も覆われていないので、隅を覆う部品が 4 つ増えるまで緑）。「だいたい 100ms 以内」「おおむね同じ幅」も同型。
- 確かめ方: `e2e/inc5-shell.spec.ts` の `expectMapReachable`（`covered` で名指し）と `e2e/helpers.ts` の `MAP_CELL_PARTS`。

### 5.88 確定を「1 コマ遅らせる」に変えたら、結果を「いま見えるか」で読む手順を全部探す
- 正しい道: 確定のタイミングの変更は「結果がいつ出るか」の既定の反転（5.67 と同型）と考え、その確定を押す spec を探索も含めて全部挙げる。結果は `waitFor({ state: 'visible' })` を時間切れつきで待ち、出ない場合（断られた・競合で止まった）も先へ進めるよう時間切れは失敗にしない。
- 誤った道の兆候: 押した直後に `isVisible()` を 1 回読む手順が残っている（板を素通りし、遅れて出た覆い `knife-backdrop` が次の道具のボタンを塞いで 30 秒で落ちる）。全件ゲートで探索を省く（落ちたまま気づかない）。
- 確かめ方: 確定を押す spec を `grep` して押した直後の読み方を見る。`npm run e2e:explore`（`playwright.config.ts` の `explore`）を省かない。修正の実例は `e2e/__bughunt__/explore-r1.spec.ts:362`、`explore-r2.spec.ts`。
- 検査: 未整備。手で確かめる。

### 5.100 探索の手順は、前提が成り立ったことを確かめてから結果を読む ―― 握りつぶした入力は「受け付けた」に化ける
- 正しい道: 値を入れる前にその欄が押せる（`toBeEnabled()` / `isEnabled()`）ことを確かめ、入れたあとは読み返す（`inputValue()`）。前提が崩れていたら別の所見として名指しで記録し（`settings-inputs-disabled`）、その先の判定は出さない。鍵（読むだけ）・局面・板の有無のような前提は、手順の中で自分で整える（`leaveViewMode` で開けてから設定を開く。`returnToViewMode` を通る共通の開き方を流用しない）。
- 誤った道の兆候: `fill(...).catch(() => undefined)` のあとに保存を押し、「板が閉じた」を「受け付けた」と読む。探索 `explore2-r4` は鍵を閉じたまま設定を開いていたので欄が無効で、最小 8 > 最大 2 を「受け付けた」、[0.5, 4] を「狭めた」と記録し、その後の倍率 5.6〜31 を上限違反と数えた（B88 として 4 週間残った）。所見の文に、読み返した値が入っていない。
- 確かめ方: 探索の所見を不具合として登録する前に、同じ操作を前提の確認つきの E2E で 1 本書いて再現する（`e2e/inc8e-zoom-limit.spec.ts` の B88）。探索の `fill` を `grep` して、直前に有効の確認か直後に読み返しがあるかを見る。
- 検査: 未整備。手で確かめる。
