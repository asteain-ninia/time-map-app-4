# 10 — テストが固定している UI の約束事

調査日: 2026-09-03 / 対象コミット: `0956160`（master・作業ツリーは clean）
調べた範囲: `e2e/**`（52 ファイル）, `e2e/helpers.ts`, `e2e/__visual__`, `e2e/*-snapshots`, `src/ui/**/*.test.tsx`（69 ファイル）, `vitest.config.ts`, `playwright.config.ts`, `tsconfig.e2e.json`, `eslint.config.js`。
ソースは一切変更していない。数値は実際にコマンドを走らせた実測値（`npx playwright test --list` / `npx vitest list` / 実走 3 回）。

この文書は「UI を作り直したとき、テストのどこが何を掴んでいて壊れるか」を、次工程が機械的に使える生データとして並べたもの。

---

## 0. 先に結論（4 点）

- E2E は **52 ファイル / 130 テスト**、コンポーネントテスト（jsdom）は **68 ファイル / 794 テスト**。E2E はほぼ全部が `data-testid` 経由で、見た目（CSS クラス名・DOM の入れ子）に直接ぶら下がっているのは 12 箇所しかない。
- ただし **「面を 1 つ描いて保存する」という同じ手順が 28 ファイルに直書き**されており（共有ヘルパー `commitOneFace` を使っているのは 14 ファイルだけ）、追加ツールの導線を変えると 28 ファイルを個別に直すことになる。ここが再設計の最大の地雷。
- **いまの基準線は全緑**: 2026-09-03 に全 130 件を通しで実走して 130 passed / 0 failed（10 分 36 秒）。うち 8 分半は探索用スペック 16 件が食っており、回帰の本体 103 件は **2 分**で回る。
- 画像で比較する視覚回帰は **4 枚だけ**（`sidebar-empty` / `sidebar-property-populated` / `shell-no-scrollbars` / `timeline-readable`）。再設計すれば必ず落ちるが、`--update-snapshots` で作り直すだけなので障害にはならない。

---

## 1. テストの構成と規模（実測）

### 1.1 E2E（Playwright for Electron）

`playwright.config.ts` の設定は以下（根拠: `playwright.config.ts:26-49`）。

| 設定 | 値 | 意味 |
|---|---|---|
| `testDir` | `./e2e` | サブディレクトリ（`__bughunt__` / `__visual__`）も既定の `testMatch` に入る＝**普通に `npx playwright test` すると探索用スペックまで全部走る** |
| `timeout` | 60,000 ms | 1 テストあたりの上限 |
| `expect.timeout` | 15,000 ms | 個々の `expect` のポーリング上限 |
| `workers` | 1 | Electron を 1 プロセスずつ起動するため直列固定 |
| `fullyParallel` | false | 同上 |
| `retries` | 1 | バッチ最初のコールドスタート揺れを吸収するため |
| `reporter` | `list` | |
| `use.trace` | `retain-on-failure` | 失敗時だけトレースを残す |
| ブラウザ project | **無し** | `playwright install` 不要。Electron を直接起動する |

テスト本数（`npx playwright test --list` 実測 = `Total: 130 tests in 52 files`）:

| 置き場所 | ファイル | テスト | 性質 |
|---|---|---|---|
| `e2e/*.spec.ts`（直下） | 36 | 103 | 要件・バグ回帰の本体 |
| `e2e/__bughunt__/*.spec.ts` | 13 | 16 | 探索用。1 ファイル＝巨大な 1 テスト（`explore-t2-r1` だけ 4 件）。18KB〜56KB |
| `e2e/__visual__/*.spec.ts` | 3 | 11 | 目視用スクショを大量に撮る駆動スペック（`driver-a` は 74KB / 8 件） |

### 1.2 コンポーネントテスト（Vitest + jsdom）

`vitest.config.ts` は `environmentMatchGlobs` で `src/**/*.test.tsx` だけ jsdom、それ以外は node（根拠: `vitest.config.ts:19-25`）。`pool: 'forks'` / `isolate: true` / `cache: false` で 1 ファイル 1 プロセスに固定されている。

`npx vitest list` 実測:

| 区分 | ファイル | テスト |
|---|---|---|
| Vitest 全体 | 336 | 4,428 |
| うち `.test.tsx`（jsdom = UI 操作テスト） | 68 | 794 |

（`src/ui/merge/merge-benchmark.test.tsx` は環境変数 `DERLE_TMAP_DIR` 未設定だと丸ごと skip されるので、この 68 に入っていない。根拠: 同ファイル冒頭の CI SAFETY 注記。）

### 1.3 型検査・lint も e2e を見ている

`npm run typecheck` は `tsconfig.e2e.json` を含む 3 構成を回す（`package.json:"typecheck"`）。`tsconfig.e2e.json` の `include` は `e2e/**/*.ts` と `playwright.config.ts`。`eslint.config.js:147` に `e2e/**/*.ts` 専用ブロックがある。つまり **spec を消したり書き換えたりすると型検査と lint も同時に見る必要がある**。

---

## 2. 実行方法・所要時間・注意点（実測）

### 2.1 コマンド

| したいこと | コマンド | 備考 |
|---|---|---|
| E2E 全部 | `npm run test:e2e` | `electron-vite build` してから `playwright test`。**ビルドを含む** |
| ビルド済みで E2E だけ | `npx playwright test` | `out/` が最新であることが前提 |
| 1 ファイルだけ | `npx playwright test e2e/launch.spec.ts` | |
| 探索スペックを外す | `npx playwright test e2e/*.spec.ts` 相当の指定、または `--grep-invert` | 設定ファイルに除外は書かれていないので毎回手で外す |
| 視覚回帰の基準画像を作り直す | `npx playwright test <spec> --update-snapshots` | 後述 §5 |
| コンポーネントテスト | `npm run test`（= `vitest run`） | |

### 2.2 実測した所要時間（この PC・2026-09-03）

| 対象 | 件数 | 実測 |
|---|---|---|
| `e2e/launch.spec.ts` | 3 | 3.6 秒（プロセス全体 6 秒） |
| `e2e/sidebar-property.spec.ts` + `e2e/ux-cluster.spec.ts` | 15 | 20.5 秒（同 23 秒） |
| 1 テストあたりの典型 | — | 0.7〜2.0 秒（毎テストで Electron を起動し直しても 1 秒未満で AppShell が立つ） |
| `e2e/__bughunt__/explore3-r1.spec.ts` | 1 | **1 分 6 秒**（深い入れ子・大量地物の性能探索を 1 テストでやるため。最長は `explore3-r3` / `explore3-r4` の各 1 分 30 秒） |

**全 130 件を通しで走らせた実測（2026-09-03、`npx playwright test`、ビルド済み `out/` を使用）: 130 passed / 0 failed、10 分 36 秒（プロセス全体 641 秒）。**

その 10.6 分の内訳（各テストの報告時間を足し上げたもの。合計 630 秒）:

| 群 | テスト数 | 所要 | 全体に占める割合 |
|---|---|---|---|
| `e2e/*.spec.ts`（直下・回帰の本体） | 103 | **127 秒** | 20% |
| `e2e/__bughunt__/`（探索） | 16 | **448 秒** | **71%** |
| `e2e/__visual__/`（目視用） | 11 | 55 秒 | 9% |

遅い順トップ 4 はすべて `__bughunt__`: `explore3-r3` 90 秒 / `explore3-r4` 90 秒 / `explore3-r2` 72 秒 / `explore3-r1` 66 秒。

つまり **回帰ゲートとして本当に必要な 103 件は 2 分ちょっとで回る。** 残り 8 分半は探索スペックが食っている（→ §7 推奨 G）。

### 2.3 注意点

- **ヘッドレスで動く。** 主プロセスが `E2E_TEST=1` を見てウィンドウを `offscreen: true` で作る（`src/shell/main/index.ts:52, 192`）。ディスプレイ不要。
- **userData は毎回一時ディレクトリ。** `e2e/helpers.ts:29` が `mkdtempSync(join(tmpdir(), 'tmap-e2e-userdata-'))` を作り、プロセス終了時に消す。利用者の実データや設定を汚さない。複数エージェントが同時に起動しても衝突しない。
- **`ELECTRON_RUN_AS_NODE` を子プロセス環境から削除している**（`e2e/helpers.ts:50-60`）。空文字でも Electron は「セット済み」と扱い `--remote-debugging-port` が壊れるため、キーごと消すのが唯一の正解、と注記されている。
- **AppShell のマウント待ちに 45 秒の明示予算**（`e2e/helpers.ts:85-88`）。コールドスタートの揺れを 60 秒のテスト上限内に収めるための設定。
- **キーボードのアクセラレータは検証できない。** `e2e/app-menu.spec.ts:15-22` に実測知見として明記: Playwright の `keyboard.press` は CDP 合成イベントなので、オフスクリーン／非フォーカスのウィンドウでは **ネイティブアクセラレータ経路が発火しない**。だから「Ctrl+R でリロードしないこと」は修正の有無に関わらず緑になる。決定的な検証はメインプロセス側の `Menu.getApplicationMenu()` を読むほう。
- **ネイティブのファイルダイアログは一切使わない。** `e2e/` 全体を grep しても `gimoza` / `loadProject` / `window.api` の参照はゼロ。**E2E がデータを用意する唯一の手段は「UI で描くこと」**（`e2e/helpers.ts:116-152` の `commitOneFace`、`e2e/fixtures/real-shapes.ts` の輪郭をピクセルに写して 1 頂点ずつクリック）。→ §7 の推奨 D に直結する。
- 記録用スクショ（`screenshots/` 配下）は `.gitignore` 済み（`.gitignore` の「e2e 実行毎に再生成される記録スクショ」節）。真の基準画像は `e2e/*-snapshots/` のみ。

---

## 3. E2E が掴んでいる約束事（全一覧）

testid の総数は **358**。内訳:

| 区分 | 個数 |
|---|---|
| E2E（`e2e/**`）が参照 | 196 |
| `.test.tsx` だけが参照 | 129 |
| E2E と `.test.tsx` の両方が参照 | 133 |
| **どのテストからも参照されない**（＝消しても誰も困らない） | 33 |
| ソース側に静的な定義が無い（テンプレート文字列で動的生成） | 113（うち E2E が使うもの 50） |

### 3.1 動的に組み立てられる testid の生成規則

再設計でここを変えると、機械的な置換では追えない。規則そのものが契約になっている。

| 規則 | 生成元 | 実例（E2E が使っている値） |
|---|---|---|
| `tool-${toolId}` | `src/ui/shell/Toolbar.tsx:75` | `tool-add.area` / `tool-add.line` / `tool-add.point` / `tool-edit.knife` / `tool-edit.merge` / `tool-edit.move` / `tool-edit.ring` / `tool-edit.select` / `tool-edit.vertex` |
| `menu-${menu.key}` / `menu-items-${menu.key}` / `menu-accel-${commandId}` | `src/ui/shell/MenuBar.tsx:82, 88, 115` | `menu-file` / `menu-edit` / `menu-view` / `menu-tools` / `menu-help`、`menu-items-file` ほか、`menu-accel-file.save` / `menu-accel-edit.redo` |
| `sidebar-tab-${key}` / `sidebar-panel-${key}` | `src/ui/shell/Sidebar.tsx:83, 99` | `sidebar-tab-list` / `sidebar-tab-properties` / `sidebar-panel-list` / `sidebar-panel-properties` |
| `${listTestid}` + `-caption` / `-empty` / `-filter` / `-count` / `-no-match` | `src/ui/shell/SidebarContent.tsx:449-479`（`listTestid="unified-list"` は 654 行） | `unified-list` / `unified-list-empty`（E2E 17 ファイル） |
| `feature-list-item-${featureId}` / `event-list-item-${anchorId}` | `src/ui/shell/SidebarContent.tsx:576, 601` | `.test.tsx` のみ（固定 ID を使うため） |
| ヘルプ系モーダルの `${props.testid}` + `-root` / `-backdrop` / `-close` | `src/ui/help-tools/HelpToolsController.tsx:227-252` | `about-panel` / `search-panel` / `shortcuts-panel` / `diagnostics-panel` と各 `-close` |
| `shortcuts-panel-key-${commandId}` ／ 別名は `-${chord}` 付き | 同 `:530-536` | `shortcuts-panel-key-file.save` / `shortcuts-panel-key-edit.redo` / `shortcuts-panel-key-edit.redo-Ctrl+Shift+Z` |
| `display-filter-kind-${point\|line\|area}` / `display-filter-emphasize-${…}` | `src/ui/discovery/DisplayFilterPanel.tsx:98, 120`（行 36-38 が値の定義） | `display-filter-kind-area` / `display-filter-emphasize-area` |
| `knife-choose-${i}` / `knife-preview-${i}` | `src/ui/knife/InheritorModal.tsx:195, 165` | `knife-choose-0..2` |
| `conflict-row-${id}` / `conflict-row-select-${id}` / `policy-${conflictId}-${featureId}` | `src/ui/conflict/ConflictResolutionModal.tsx:251, 257, 366` | `.test.tsx` のみ |
| `anchor-row-${anchorId}` / `anchor-interval-${anchorId}` ほか | `src/ui/property/AnchorList.tsx:90, 168, 202, 213` | `.test.tsx` のみ |
| `${testId}` + `-year` / `-month` / `-day` / `-confirm` / `-clear` … | `src/ui/timeline/YearMonthDayInput.tsx:153-255` | `anchor-interval-start-a1-year` など（`.test.tsx`） |
| `panel-${id}` / `panel-header-${id}` | `src/ui/shell/DraggablePanel.tsx:35, 48` | `.test.tsx` のみ |
| `settings-error-${field}` / `settings-palette-remove-${i}` | `src/ui/settings/SettingsDialog.tsx:155, 452` | |
| `repair-row-${i}` / `repair-option-${i}-${optionId}` | `src/ui/file-ops/RepairDialog.tsx:130, 150` | |
| `survey-${start\|end}` + `-dms` / `-decimal`、`survey-format-${value}` | `src/ui/survey/SurveyControls.tsx:166, 173, 198` | `survey-start-dms` / `survey-end-decimal` / `survey-format-both` ほか |
| `detail-panel-${featureId}` / `conflict-preview-${id}` / `timebar-bar-${anchorId}` | `DetailPanel.tsx:58` / `MinimapPreview.tsx:76` / `AnchorTimeBar.tsx:167` | |

### 3.2 testid → 使っている spec（E2E が参照する 196 個の全一覧）

見方: 「定義元」が `(動的生成)` のものは §3.1 の規則で作られる。spec 名は `.spec.ts` を省略し、`bh:` = `e2e/__bughunt__/`、`vis:` = `e2e/__visual__/`、`helpers` = `e2e/helpers.ts`。

#### シェル(枠組み) (7 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `app-shell` | shell/AppShell.tsx | 32 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, app-menu, close-guard, context-menu, detail-document, display-filter, flows, fr52-merge-options, hb3-12-existence-period, helpers, knife-nway, knife-preview-north, launch, regression, shortcut-suspend, ux-cluster, view-niceties |
| `map-input-layer` | App.tsx<br>shell/MapContainer.tsx | 32 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, add-knife-camera, app-menu, coord-cluster, display-filter, edit-select, flows, fr52-merge-options, human-bugs-3, launch, longitude-shift, map-pan-zoom, regression, resize-coord, survey, view-niceties, zoom-cull |
| `map-canvas-mount` | shell/MapContainer.tsx | 3 | vis:driver-a, regression, screenshot |
| `map-area` | shell/MapContainer.tsx | 1 | launch |
| `sidebar` | shell/Sidebar.tsx | 1 | sidebar-property |
| `statusbar` | shell/StatusBar.tsx | 1 | view-niceties |
| `statusbar-cursor-coords` | shell/CursorCoordinateStatus.tsx | 1 | view-niceties |

#### メニューバー (12 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `menu-file` | (動的生成) | 11 | bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, flows, shortcut-labels |
| `menu-items-file` | (動的生成) | 10 | bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, flows |
| `menu-view` | (動的生成) | 3 | app-menu, view-mode, view-niceties |
| `menu-tools` | (動的生成) | 2 | app-menu, shortcut-suspend |
| `menubar` | shell/MenuBar.tsx | 2 | launch, shortcut-labels |
| `menu-accel-edit.redo` | (動的生成) | 1 | ux-cluster |
| `menu-accel-file.save` | (動的生成) | 1 | shortcut-labels |
| `menu-edit` | (動的生成) | 1 | ux-cluster |
| `menu-help` | (動的生成) | 1 | ux-cluster |
| `menu-items-help` | (動的生成) | 1 | ux-cluster |
| `menu-items-tools` | (動的生成) | 1 | shortcut-suspend |
| `menu-items-view` | (動的生成) | 1 | view-mode |

#### ツールバー (13 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `mode-view` | shell/Toolbar.tsx | 36 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, hb3-12-existence-period, helpers, human-bugs-3, knife-nway, knife-preview-north, regression, resize-coord, shortcut-suspend, survey, view-mode, zoom-cull |
| `mode-edit` | shell/Toolbar.tsx | 35 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, detail-document, display-filter, edit-drag-preview, edit-handles, edit-select, flows, fr52-merge-options, fr80-multi-vertex-drag, hb3-12-existence-period, human-bugs-3, knife-nway, knife-preview-north, regression, resize-coord, ux-cluster, view-mode, view-niceties |
| `mode-add` | shell/Toolbar.tsx | 33 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, flows, fr52-merge-options, fr80-multi-vertex-drag, helpers, human-bugs-3, knife-nway, knife-preview-north, regression, shortcut-suspend, view-mode |
| `tool-add.area` | (動的生成) | 32 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, helpers, human-bugs-3, knife-nway, knife-preview-north, real-shapes, regression, shortcut-suspend, view-mode |
| `tool-edit.knife` | (動的生成) | 10 | bh:explore-r1, bh:explore-r2, bh:explore2-r2, vis:driver-a, context-menu, human-bugs-3, knife-nway, knife-preview-north, regression, survey |
| `tool-edit.merge` | (動的生成) | 4 | bh:explore-r1, display-filter, fr52-merge-options, human-bugs-3 |
| `tool-add.line` | (動的生成) | 2 | add-knife-camera, regression |
| `tool-add.point` | (動的生成) | 2 | human-bugs-3, view-mode |
| `tool-edit.select` | (動的生成) | 2 | bh:explore-r2, vis:v2-undo-style |
| `tool-edit.move` | (動的生成) | 1 | bh:explore-r2 |
| `tool-edit.ring` | (動的生成) | 1 | vis:driver-a |
| `tool-edit.vertex` | (動的生成) | 1 | vis:v2-undo-style |
| `toolbar` | shell/Toolbar.tsx | 1 | launch |

#### サイドバー:一覧 (8 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `unified-list-empty` | (動的生成) | 17 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:visual-b, fr52-merge-options, hb3-12-existence-period, knife-nway, shortcut-suspend |
| `list-mode-current` | shell/SidebarContent.tsx | 6 | vis:driver-a, fr52-merge-options, hb3-12-existence-period, knife-nway, shortcut-suspend, sidebar-property |
| `sidebar-tab-list` | (動的生成) | 6 | vis:driver-a, display-filter, fr52-merge-options, hb3-12-existence-period, knife-nway, shortcut-suspend |
| `sidebar-panel-properties` | (動的生成) | 5 | vis:v2-undo-style, vis:visual-b, context-menu, hb3-12-existence-period, sidebar-property |
| `sidebar-tab-properties` | (動的生成) | 4 | vis:v2-undo-style, vis:visual-b, context-menu, hb3-12-existence-period |
| `list-mode-history` | shell/SidebarContent.tsx | 1 | sidebar-property |
| `sidebar-panel-list` | (動的生成) | 1 | sidebar-property |
| `unified-list` | (動的生成) | 1 | sidebar-property |

#### サイドバー:プロパティ (20 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `basic-info` | property/BasicInfoForm.tsx | 3 | context-menu, human-bugs-3, sidebar-property |
| `anchor-mode-list` | property/AnchorSection.tsx | 2 | bh:explore2-r3, human-bugs-3 |
| `anchor-mode-timebar` | property/AnchorSection.tsx | 2 | bh:explore2-r3, hb3-12-existence-period |
| `open-detail-button` | property/PropertyPanel.tsx | 2 | detail-document, human-bugs-3 |
| `timebar-edge-min` | property/AnchorTimeBar.tsx | 2 | bh:explore2-r3, hb3-12-existence-period |
| `anchor-list` | property/AnchorList.tsx | 1 | bh:explore-r2 |
| `anchor-section` | property/AnchorSection.tsx | 1 | bh:explore2-r3 |
| `area-row` | property/BasicInfoForm.tsx | 1 | vis:visual-b |
| `area-value` | property/BasicInfoForm.tsx | 1 | vis:visual-b |
| `detail-doc-empty` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `detail-doc-message` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `detail-doc-mode-edit` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `detail-doc-save` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `detail-doc-textarea` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `detail-document-section` | property/DetailDocumentSection.tsx | 1 | detail-document |
| `markdown-view` | property/MarkdownView.tsx | 1 | detail-document |
| `property-panel` | property/PropertyPanel.tsx | 1 | sidebar-property |
| `save-button` | property/BasicInfoForm.tsx | 1 | human-bugs-3 |
| `save-message` | property/BasicInfoForm.tsx | 1 | human-bugs-3 |
| `timebar-edge-max` | property/AnchorTimeBar.tsx | 1 | bh:explore2-r3 |

#### タイムライン (7 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `timeline-current` | timeline/Timeline.tsx | 15 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, hb3-12-existence-period, regression |
| `timeline-playback` | timeline/PlaybackControls.tsx | 4 | bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `timeline` | timeline/Timeline.tsx | 1 | ux-cluster |
| `timeline-markers` | (動的生成) | 1 | ux-cluster |
| `timeline-markers-hint` | (動的生成) | 1 | ux-cluster |
| `timeline-step` | timeline/StepControls.tsx | 1 | bh:explore3-r3 |
| `timeline-ticks` | timeline/Timeline.tsx | 1 | ux-cluster |

#### 地図ウィジェット (6 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `global-depth-readout` | map/GlobalDepthControl.tsx | 3 | vis:driver-a, depth-control, display-filter |
| `longitude-shift` | map/LongitudeShiftControl.tsx | 3 | bh:explore2-r3, edit-select, longitude-shift |
| `center-lon-readout` | map/LongitudeShiftControl.tsx | 2 | bh:explore2-r3, longitude-shift |
| `center-lon-absolute-input` | map/LongitudeShiftControl.tsx | 1 | longitude-shift |
| `global-depth-slider` | map/GlobalDepthControl.tsx | 1 | depth-control |
| `grid-toggle` | map/GridToggleControl.tsx | 1 | grid-toggle |

#### ツール:追加 (14 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `add-input-layer` | add/AddToolController.tsx | 34 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, add-knife-camera, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, helpers, human-bugs-3, knife-nway, knife-preview-north, real-shapes, regression, shortcut-suspend, view-mode |
| `add-complete` | add/AddToolController.tsx | 33 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, helpers, human-bugs-3, knife-nway, knife-preview-north, real-shapes, regression, shortcut-suspend, view-mode |
| `add-save` | add/AddPropertyForm.tsx | 33 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, helpers, human-bugs-3, knife-nway, knife-preview-north, real-shapes, regression, shortcut-suspend, view-mode |
| `add-vertex-count` | add/AddToolController.tsx | 19 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, aggregate-select, depth-control, knife-preview-north, regression, shortcut-suspend |
| `add-parent` | add/AddPropertyForm.tsx | 14 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, aggregate-select, depth-control, display-filter |
| `add-rejected` | add/AddToolController.tsx | 12 | bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `add-name` | add/AddPropertyForm.tsx | 8 | bh:explore-t2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a |
| `add-cancel` | add/AddToolController.tsx | 7 | bh:explore-t2-r1, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, regression, shortcut-suspend |
| `add-rejected-dismiss` | add/AddToolController.tsx | 7 | bh:explore-t2-r1, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `add-property-form` | add/AddPropertyForm.tsx | 6 | bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `add-tool` | add/AddToolController.tsx | 2 | regression, ux-cluster |
| `add-grid-snap` | add/AddToolController.tsx | 1 | bh:explore2-r3 |
| `add-is-line` | add/AddToolController.tsx | 1 | bh:explore2-r3 |
| `add-undo` | add/AddToolController.tsx | 1 | bh:explore2-r3 |

#### ツール:分割(ナイフ) (17 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `knife-confirm-cut` | knife/KnifeToolController.tsx | 13 | bh:explore-r1, bh:explore-r2, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, knife-nway, knife-preview-north, regression |
| `knife-choose-0` | (動的生成) | 12 | bh:explore-r1, bh:explore-r2, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, knife-nway, regression |
| `knife-confirm-inheritor` | knife/InheritorModal.tsx | 12 | bh:explore-r1, bh:explore-r2, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, knife-nway, regression |
| `knife-inheritor-modal-root` | knife/InheritorModal.tsx | 10 | bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, knife-nway, knife-preview-north |
| `knife-input-layer` | knife/KnifeToolController.tsx | 9 | bh:explore-r1, bh:explore-r2, bh:explore-r4, bh:explore2-r2, bh:explore3-r1, vis:driver-a, knife-nway, knife-preview-north, regression |
| `knife-tool` | knife/KnifeToolController.tsx | 9 | bh:explore-r4, bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, regression |
| `knife-cut-count` | knife/KnifeToolController.tsx | 6 | bh:explore-r1, bh:explore-r2, bh:explore-r4, knife-nway, knife-preview-north, regression |
| `knife-rejected` | knife/KnifeToolController.tsx | 5 | bh:explore-r1, bh:explore-r2, bh:explore-r4, knife-nway, knife-preview-north |
| `knife-choose-1` | (動的生成) | 3 | bh:explore2-r2, bh:explore3-r1, knife-nway |
| `knife-conflict-paused` | knife/KnifeToolController.tsx | 3 | bh:explore-r1, bh:explore-r2, regression |
| `knife-props` | knife/KnifeToolController.tsx | 3 | bh:explore-r4, vis:driver-a, knife-nway |
| `knife-inheritor-dialog` | knife/InheritorModal.tsx | 2 | bh:explore2-r2, knife-preview-north |
| `knife-message` | knife/KnifeToolController.tsx | 2 | bh:explore2-r2, bh:explore3-r1 |
| `knife-choose-2` | (動的生成) | 1 | knife-nway |
| `knife-preview` | knife/InheritorModal.tsx | 1 | knife-preview-north |
| `knife-rejected-dismiss` | knife/KnifeToolController.tsx | 1 | bh:explore-r4 |
| `knife-smaller-box` | knife/InheritorModal.tsx | 1 | knife-preview-north |

#### ツール:結合 (11 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `merge-confirm` | merge/MergeToolController.tsx | 6 | bh:explore-t2-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, fr52-merge-options, human-bugs-3 |
| `merge-options-confirm` | merge/MergeOptionsDialog.tsx | 6 | bh:explore-t2-r1, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, fr52-merge-options |
| `merge-options-dialog` | merge/MergeOptionsDialog.tsx | 6 | bh:explore-t2-r1, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, fr52-merge-options |
| `merge-target-count` | merge/MergeToolController.tsx | 6 | bh:explore-t2-r1, bh:explore3-r3, bh:explore3-r4, display-filter, fr52-merge-options, human-bugs-3 |
| `merge-message` | merge/MergeToolController.tsx | 4 | bh:explore-t2-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `merge-parent-create` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |
| `merge-parent-existing` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |
| `merge-parent-none` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |
| `merge-property-inherit` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |
| `merge-property-new` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |
| `merge-property-new-name` | merge/MergeOptionsDialog.tsx | 1 | fr52-merge-options |

#### ツール:掘削 (3 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `drill-confirm` | drill/DrillToolController.tsx | 1 | vis:driver-a |
| `drill-props` | drill/DrillToolController.tsx | 1 | vis:driver-a |
| `drill-tool` | drill/DrillToolController.tsx | 1 | vis:driver-a |

#### ツール:環編集 (5 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `ring-edit-cancel` | ring-edit/RingEditToolController.tsx | 1 | vis:driver-a |
| `ring-edit-confirm` | ring-edit/RingEditToolController.tsx | 1 | vis:driver-a |
| `ring-edit-gridsnap` | ring-edit/RingEditToolController.tsx | 1 | vis:driver-a |
| `ring-edit-submode` | ring-edit/RingEditToolController.tsx | 1 | vis:driver-a |
| `ring-edit-tool` | ring-edit/RingEditToolController.tsx | 1 | vis:driver-a |

#### ツール:所属変更 (5 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `reparent-confirm` | reparent/ReparentToolController.tsx | 3 | bh:explore-t2-r1, bh:explore3-r3, bh:explore3-r4 |
| `reparent-parent` | reparent/ReparentToolController.tsx | 3 | bh:explore-t2-r1, bh:explore3-r3, bh:explore3-r4 |
| `reparent-target` | reparent/ReparentToolController.tsx | 3 | bh:explore-t2-r1, bh:explore3-r3, bh:explore3-r4 |
| `reparent-message` | reparent/ReparentToolController.tsx | 2 | bh:explore-t2-r1, bh:explore3-r3 |
| `reparent-cancel` | reparent/ReparentToolController.tsx | 1 | bh:explore-t2-r1 |

#### ツール:計測 (13 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `survey-input-layer` | survey/SurveyToolController.tsx | 2 | survey, view-niceties |
| `survey-toggle` | survey/SurveyControls.tsx | 2 | survey, view-niceties |
| `survey-clear` | survey/SurveyControls.tsx | 1 | survey |
| `survey-end-decimal` | (動的生成) | 1 | survey |
| `survey-end-dms` | (動的生成) | 1 | survey |
| `survey-eq-distance` | survey/SurveyControls.tsx | 1 | survey |
| `survey-format-both` | (動的生成) | 1 | survey |
| `survey-format-dms` | (動的生成) | 1 | survey |
| `survey-gc-distance` | survey/SurveyControls.tsx | 1 | survey |
| `survey-guide` | survey/SurveyControls.tsx | 1 | survey |
| `survey-line-count` | survey/SurveyControls.tsx | 1 | survey |
| `survey-start-decimal` | (動的生成) | 1 | survey |
| `survey-start-dms` | (動的生成) | 1 | survey |

#### ダイアログ:設定 (8 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `settings-cancel` | settings/SettingsDialog.tsx | 5 | bh:explore-r3, bh:explore2-r1, bh:explore2-r4, help-tools, shortcut-suspend |
| `settings-tab-project` | settings/SettingsDialog.tsx | 4 | bh:explore-r3, bh:explore2-r1, bh:explore2-r4, help-tools |
| `settings-dialog` | settings/SettingsDialog.tsx | 3 | bh:explore-r3, help-tools, shortcut-suspend |
| `settings-save` | settings/SettingsDialog.tsx | 3 | bh:explore-r3, bh:explore2-r1, bh:explore2-r4 |
| `settings-modal-root` | settings/SettingsDialog.tsx | 2 | bh:explore2-r1, bh:explore2-r4 |
| `settings-tab-app` | settings/SettingsDialog.tsx | 2 | bh:explore2-r4, help-tools |
| `settings-app` | settings/SettingsDialog.tsx | 1 | help-tools |
| `settings-errors` | settings/SettingsDialog.tsx | 1 | bh:explore-r3 |

#### ダイアログ:競合解決 (5 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `conflict-cancel` | conflict/ConflictResolutionModal.tsx | 15 | bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b |
| `conflict-modal-root` | conflict/ConflictResolutionModal.tsx | 15 | bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b |
| `conflict-apply` | conflict/ConflictResolutionModal.tsx | 2 | bh:explore2-r1, bh:explore2-r4 |
| `conflict-remaining` | conflict/ConflictResolutionModal.tsx | 2 | bh:explore2-r1, bh:explore2-r4 |
| `conflict-guide-reshow` | conflict/ConflictResolutionModal.tsx | 1 | bh:explore2-r4 |

#### ダイアログ:未保存/修復 (4 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `unsaved-cancel` | file-ops/UnsavedWarningDialog.tsx | 1 | close-guard |
| `unsaved-dialog` | file-ops/UnsavedWarningDialog.tsx | 1 | close-guard |
| `unsaved-discard` | file-ops/UnsavedWarningDialog.tsx | 1 | close-guard |
| `unsaved-modal-root` | file-ops/UnsavedWarningDialog.tsx | 1 | close-guard |

#### パネル:ヘルプ/検索/診断 (22 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `diagnostics-feature-count` | help-tools/HelpToolsController.tsx | 12 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, help-tools |
| `diagnostics-panel` | (動的生成) | 12 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, help-tools |
| `diagnostics-panel-close` | (動的生成) | 12 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, help-tools |
| `diagnostics-unsaved` | help-tools/HelpToolsController.tsx | 11 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, help-tools |
| `diagnostics-current-time` | help-tools/HelpToolsController.tsx | 5 | bh:explore-r3, bh:explore-t2-r1, bh:explore2-r4, bh:explore3-r3, bh:explore3-r4 |
| `search-panel-input` | help-tools/HelpToolsController.tsx | 4 | bh:explore-r3, bh:explore2-r2, app-menu, help-tools |
| `search-panel-close` | (動的生成) | 3 | bh:explore-r3, bh:explore2-r2, help-tools |
| `search-panel-results` | help-tools/HelpToolsController.tsx | 3 | bh:explore-r3, bh:explore2-r2, help-tools |
| `search-panel-run` | help-tools/HelpToolsController.tsx | 3 | bh:explore-r3, bh:explore2-r2, help-tools |
| `search-panel` | (動的生成) | 2 | bh:explore-r3, help-tools |
| `search-panel-error` | help-tools/HelpToolsController.tsx | 2 | bh:explore-r3, bh:explore2-r2 |
| `search-panel-hit` | help-tools/HelpToolsController.tsx | 2 | bh:explore-r3, bh:explore2-r2 |
| `search-panel-no-results` | help-tools/HelpToolsController.tsx | 2 | bh:explore-r3, bh:explore2-r2 |
| `shortcuts-panel` | (動的生成) | 2 | help-tools, ux-cluster |
| `about-panel` | (動的生成) | 1 | help-tools |
| `about-panel-close` | (動的生成) | 1 | help-tools |
| `about-panel-version` | help-tools/HelpToolsController.tsx | 1 | help-tools |
| `shortcuts-panel-close` | (動的生成) | 1 | help-tools |
| `shortcuts-panel-key-edit.redo` | (動的生成) | 1 | ux-cluster |
| `shortcuts-panel-key-edit.redo-Ctrl+Shift+Z` | (動的生成) | 1 | ux-cluster |
| `shortcuts-panel-key-file.save` | (動的生成) | 1 | help-tools |
| `shortcuts-panel-row` | help-tools/HelpToolsController.tsx | 1 | help-tools |

#### 表示フィルタ (8 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `display-filter` | discovery/DisplayFilterPanel.tsx | 2 | vis:driver-a, display-filter |
| `display-filter-kind-area` | (動的生成) | 2 | vis:driver-a, display-filter |
| `display-filter-show-all` | discovery/DisplayFilterPanel.tsx | 2 | vis:driver-a, display-filter |
| `display-filter-clear-emphasis` | discovery/DisplayFilterPanel.tsx | 1 | display-filter |
| `display-filter-depth` | discovery/DisplayFilterPanel.tsx | 1 | display-filter |
| `display-filter-depth-toggle` | discovery/DisplayFilterPanel.tsx | 1 | display-filter |
| `display-filter-emphasize-area` | (動的生成) | 1 | display-filter |
| `display-filter-opacity` | discovery/DisplayFilterPanel.tsx | 1 | display-filter |

#### 右クリックメニュー (1 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `context-menu` | map/MapContextMenu.tsx<br>shell/ContextMenu.tsx | 6 | bh:explore2-r3, vis:driver-a, vis:visual-b, context-menu, display-filter, survey |

#### 隠し観測マーカー (7 個)

| data-testid | 定義元 | 使う spec 数 | 使っている spec |
|---|---|---|---|
| `app-active-feature` | App.tsx | 37 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, coord-cluster, depth-control, detail-document, display-filter, edit-drag-preview, edit-handles, edit-select, fr80-multi-vertex-drag, hb3-12-existence-period, helpers, human-bugs-3, knife-nway, knife-preview-north, real-shapes, regression, resize-coord, shortcut-suspend, ux-cluster, view-mode |
| `app-can-undo` | App.tsx | 13 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r4, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, context-menu, fr80-multi-vertex-drag, ux-cluster |
| `app-can-redo` | App.tsx | 11 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r4, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, ux-cluster |
| `app-active-vertex` | App.tsx | 7 | bh:explore2-r3, vis:driver-a, vis:visual-b, aggregate-select, context-menu, edit-handles, edit-select |
| `app-active-tool` | App.tsx | 4 | bh:explore-r1, bh:explore-r2, bh:explore-r4, view-mode |
| `app-active-vertex-owner` | App.tsx | 4 | bh:explore2-r3, context-menu, edit-handles, edit-select |
| `app-mode` | App.tsx | 2 | bh:explore-r2, view-mode |

---

## 4. testid 以外に掴んでいるもの

### 4.1 文言（見える文字・アクセシブル名）

E2E が文字列で要素を探しているのは **28 通りだけ**。ほとんどがタイムラインと地図ウィジェットのボタンで、`aria-label`（＝ボタンの読み上げ名）に依存している。裏を返すと **ボタンを作り直しても `aria-label` を同じ文字列に保てば、これらはそのまま通る**。

| 掴み方 | 文字列 | spec 数 | 使っている spec |
|---|---|---|---|
| role + アクセシブル名 | `button:1年次へ進む` | 7 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore2-r1, regression, ux-cluster |
| role + アクセシブル名 | `button:1年前へ戻る` | 7 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore2-r1, regression, ux-cluster |
| role + アクセシブル名 | `button:再生` | 4 | bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| role + アクセシブル名 | `combobox:再生速度` | 4 | bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| role + アクセシブル名 | `button:階層深度を上げる` | 3 | vis:driver-a, depth-control, display-filter |
| role + アクセシブル名 | `button:次へ進む` | 3 | bh:explore-t2-r1, bh:explore2-r4, bh:explore3-r4 |
| role + アクセシブル名 | `button:前へ戻る` | 3 | bh:explore-t2-r1, bh:explore2-r4, bh:explore3-r4 |
| role + アクセシブル名 | `button:0度中心` | 2 | bh:explore2-r3, longitude-shift |
| role + アクセシブル名 | `button:180度中心` | 2 | bh:explore2-r3, longitude-shift |
| role + アクセシブル名 | `button:ジャンプ` | 2 | vis:driver-a, hb3-12-existence-period |
| role + アクセシブル名 | `button:右へシフト` | 2 | bh:explore2-r3, longitude-shift |
| role + アクセシブル名 | `button:左へシフト` | 2 | bh:explore2-r3, longitude-shift |
| ラベル（label / aria-label） | `最小ズーム倍率` | 2 | bh:explore-r3, bh:explore2-r1 |
| ラベル（label / aria-label） | `最大ズーム倍率` | 2 | bh:explore-r3, bh:explore2-r1 |
| ラベル（label / aria-label） | `直接ジャンプ 年` | 2 | vis:driver-a, hb3-12-existence-period |
| ラベル（label / aria-label） | `名前` | 2 | human-bugs-3, sidebar-property |
| 表示テキスト | `300年6月15日` | 1 | hb3-12-existence-period |
| role + アクセシブル名 | `button:この時刻をブックマーク` | 1 | ux-cluster |
| role + アクセシブル名 | `button:階層深度を下げる` | 1 | vis:driver-a |
| role + アクセシブル名 | `button:再生` | 1 | ux-cluster |
| role + アクセシブル名 | `button:削除を確定` | 1 | human-bugs-3 |
| role + アクセシブル名 | `button:指定経度へ移動` | 1 | longitude-shift |
| role + アクセシブル名 | `button:次へ進む$` | 1 | bh:explore2-r2 |
| role + アクセシブル名 | `button:前へ戻る$` | 1 | bh:explore2-r2 |
| role + アクセシブル名 | `button:地物を削除` | 1 | human-bugs-3 |
| role + アクセシブル名 | `combobox:ステップ単位` | 1 | bh:explore2-r4 |
| role + アクセシブル名 | `slider:経度シフト` | 1 | bh:explore2-r3 |
| role + アクセシブル名 | `slider:時間軸スライダー` | 1 | bh:explore2-r2 |

補足: `ux-cluster.spec.ts:228-245` は「1年次へ進む」ボタンについて **文字が見えていること**（`toContainText('次へ')`）と **当たり判定の下限**（高さ 30px 以上・幅 60px 以上）まで固定している。HB-13「ボタンが小さすぎる」の再発防止。再設計でアイコンだけのボタンにするとこのテストは落ちる（＝仕様として「文字を出す」が固定されている）。

コンポーネントテスト側の文言依存も軽い。`getByLabelText` で掴んでいるのは設定ダイアログの項目名（`赤道長 (km)` 8 回、`描画更新頻度 (FPS)` 3 回、`共有頂点スナップ距離 (px)`、`タイムライン最小年/最大年`、`グリッド不透明度`、`プロジェクト名`、`全頂点マーカー表示上限`）と経度シフト（`経度シフト` 3 回、`指定経度へ移動`、`左へシフト`/`右へシフト`）、削除確認（`削除を確定`/`削除をキャンセル`）ぐらい。

### 4.2 CSS クラス・XPath への直接依存（＝作り直しで確実に壊れる箇所）

E2E が `getByTestId` 以外の CSS / XPath セレクタで要素を掴んでいる箇所の全一覧。うち **見た目のクラス名に直接ぶら下がっているのは上から 10 行**（`.conflict-row__features` 〜 `.tooltip__bubble`）と `details.anchor-interval > summary`、`xpath=ancestor::*[contains(@class,"tooltip")]` の計 12 箇所。**再設計の前にここを testid へ置き換えておくと、あとが楽になる。** 残り（`[data-command=` / `[data-item-kind=` / `[role=` / `option` / `strong` / `input[aria-label*=`）は意味に基づく指定なので、クラス名を変えても壊れない。

| セレクタ | spec 数 | 使っている spec |
|---|---|---|
| `.conflict-row__features` | 1 | bh:explore-r2 |
| `.context-menu__item` | 2 | bh:explore2-r3, vis:visual-b |
| `.menubar__item-accel` | 1 | shortcut-labels |
| `.policy-choice__option` | 1 | bh:explore-r2 |
| `.timeline__tick-label` | 1 | ux-cluster |
| `.timeline__ticks-unit` | 1 | ux-cluster |
| `.timeline-markers` | 1 | ux-cluster |
| `.toolbar__modes` | 1 | view-mode |
| `.tooltip` | 1 | view-mode |
| `.tooltip__bubble:not([hidden])` | 1 | vis:driver-a |
| `[data-command=` | 17 | bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:visual-b, flows, help-tools, shortcut-suspend, ux-cluster, view-mode |
| `[data-item-kind=` | 3 | vis:driver-a, context-menu, display-filter |
| `[role=` | 1 | view-mode |
| `button[data-command=` | 2 | app-menu, view-niceties |
| `details.anchor-interval > summary` | 1 | hb3-12-existence-period |
| `input[aria-label*=` | 2 | bh:explore2-r1, bh:explore2-r4 |
| `option` | 6 | bh:explore-t2-r1, bh:explore2-r2, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4 |
| `strong` | 1 | detail-document |
| `xpath=ancestor::*[contains(@class,` | 1 | view-mode |

特に注意が要るのは 2 つ:

- `e2e/view-mode.spec.ts:129-155`（HB-16）は「モード切替ボタンは **tooltip クラスの祖先を持たない**」「ツールボタンは **ちょうど 1 つ持つ**」を XPath の祖先検索で固定している。ツールチップの実装方式を変える（例: `title` 属性やポータルに移す）と、機能的には正しくてもこのテストは落ちる。
- `e2e/shortcut-labels.spec.ts` は `.menubar__item-accel` でアクセラレータ表示を拾う（`menu-accel-*` の testid と併用）。

### 4.3 コマンド ID（`data-command`）— 17 ファイルが依存

メニュー項目とコンテキストメニュー項目は `data-command={commandId}` を持つ（`src/ui/shell/MenuBar.tsx:102`, `src/ui/shell/ContextMenu.tsx:77`, `src/ui/map/MapContextMenu.tsx:280`）。E2E は 17 ファイルでこの属性を使う。名指しされている ID の実例:

`view.zoomIn` / `view.zoomOut` / `view.fitAll` / `view.toggleViewMode` / `tools.settings` / `tools.search` / `help.shortcuts` / `edit.delete`（他は変数越し）。

**コマンド ID は見た目から独立した抽象なので、再設計をまたいで維持しやすい契約**。メニューの形（横並び / ハンバーガー / コマンドパレット）を変えても、同じ `data-command` を出しておけば大半の spec は生き残る。

### 4.4 右クリックメニューの項目種別（`data-item-kind`）

`src/ui/map/MapContextMenu.tsx:259` の `data-item-kind={item.kind}`。E2E が名指しする値: `deleteVertex` / `delete` / `editProperties` / `split` / `changeAffiliation` / `merge` / `hideFeature` / `emphasizeFeature` / `unemphasizeFeature`。使用は `context-menu.spec.ts`, `display-filter.spec.ts`, `vis:driver-a` の 3 ファイル。

### 4.5 その他の属性

| 属性 | spec 数 | 使っている spec |
|---|---|---|
| `aria-pressed` | 39 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore-r4, bh:explore-t2-r1, bh:explore2-r1, bh:explore2-r2, bh:explore2-r3, bh:explore2-r4, bh:explore3-r1, bh:explore3-r2, bh:explore3-r3, bh:explore3-r4, vis:driver-a, vis:v2-undo-style, vis:visual-b, aggregate-select, context-menu, depth-control, display-filter, edit-drag-preview, edit-handles, edit-select, fr52-merge-options, fr80-multi-vertex-drag, grid-toggle, hb3-12-existence-period, helpers.ts, human-bugs-3, knife-nway, knife-preview-north, regression, resize-coord, shortcut-suspend, survey, ux-cluster, view-mode, view-niceties, zoom-cull |
| `data-zoom` | 11 | bh:explore-r1, bh:explore-r2, bh:explore-r3, bh:explore2-r1, vis:driver-a, add-knife-camera, app-menu, coord-cluster, map-pan-zoom, view-niceties, zoom-cull |
| `data-pan-x` | 8 | bh:explore-r1, bh:explore-r2, add-knife-camera, coord-cluster, longitude-shift, map-pan-zoom, survey, view-niceties |
| `data-pan-y` | 7 | bh:explore-r1, bh:explore-r2, add-knife-camera, coord-cluster, map-pan-zoom, survey, view-niceties |
| `data-flow` | 2 | bh:explore-r4, vis:driver-a |
| `aria-selected` | 1 | context-menu |
| `min` | 1 | depth-control |
| `title` | 1 | display-filter |
| `viewBox` | 1 | knife-preview-north |
| `d` | 1 | knife-preview-north |
| `y` | 1 | knife-preview-north |
| `height` | 1 | knife-preview-north |
| `data-platform` | 1 | shortcut-labels |
| `data-visible-feature-count` | 1 | zoom-cull |
| `data-testid` | 1 | bh:explore-r3 |

定義元:

| 属性 | どこで付くか | 何を映しているか |
|---|---|---|
| `aria-pressed` | `src/ui/shell/Toolbar.tsx`（モード/ツールボタン） | 押下状態。**39 ファイル（`helpers.ts` 含む）が依存する最重要の属性**。`e2e/helpers.ts:97-107` の `enterAddMode` もこれで判定している |
| `data-zoom` / `data-pan-x` / `data-pan-y` | `src/ui/App.tsx:630-632`（`publishCameraHooks` が `hookTarget.dataset` に書く。`hookTarget` は `map-input-layer`） | ライブのカメラ（中心経度・中心緯度・ズーム）。地図の pan/zoom を観測する唯一の手段 |
| `data-visible-feature-count` | `src/ui/App.tsx:671-672` | 表示クリップを通過した地物数（HB-14 の拡大で地物が消える再発防止） |
| `data-flow` | 各ツールコントローラのルート（`KnifeToolController.tsx:560` ほか） | ツールの内部フェーズ |
| `data-platform` | `src/ui/shell/MenuBar.tsx:73` | `mac` / `other`。HB-2 のショートカット表記 |
| `aria-selected` | サイドバーのタブ | |


**ここに 1 つ、ソース側にある DOM 構造の約束事がある。** `src/ui/App.tsx:595-598` は

    const inputLayer = el.parentElement?.querySelector('[data-testid="map-input-layer"]');
    const hookTarget: HTMLElement = inputLayer ?? el;

と書いている（`el` は canvas のマウント要素）。つまり **「地図の入力層は canvas マウント要素の兄弟である」という入れ子の形が、観測フックの動作条件になっている**。ここを崩すと `data-zoom` / `data-pan-x` / `data-pan-y` が canvas 側に付いてしまい、11 ファイルの pan/zoom 検証が静かに壊れる（フォールバックがあるので例外は出ない＝気づきにくい）。再設計でシェルの入れ子を変えるときは、この 4 行も一緒に直すこと。

### 4.6 「隠し観測マーカー」と `window.__E2E__`

これは UI ではなく **テスト専用の観測窓**。見た目に一切依存しないので、UI をどう作り直しても壊れない。むしろ再設計中は増やすほうが安全。

**隠し span（`hidden` 属性つき、`src/ui/App.tsx`）**

| testid | 行 | 中身 | E2E 利用 |
|---|---|---|---|
| `app-active-feature` | 3637 | 選択中の地物 ID | **37 ファイル**（最多） |
| `app-active-vertex` / `app-active-vertex-owner` | 3640 / 3643 | 選択中の頂点とその所有地物 | 7 / 4 |
| `app-mode` | 3666 | `view` / `add` / `edit` | 2 |
| `app-active-tool` | 3669 | ツール ID | 4 |
| `app-can-undo` / `app-can-redo` | 3454 / 3457 | 元に戻す・やり直しの可否 | 13 / 11 |

**`window.__E2E__`（`src/ui/App.tsx:711-789` で地図マウント時に生やし、1677 行で撤去）**

`getActiveFeature()` / `getActiveTool()` / `getMode()` / `getPrimitiveCounts()`（最後に描いたフレームの種別ごとの個数: handle・label・shape・point・line・dashedLine・preview）/ `hasLivePreview()` / `getDrawnFeatureCount()` / `getDrawnFeatureFills()` / `getVertexHandlePositions()` / `screenToWorld(x, y)`。

使っている spec は 13 ファイル: `context-menu`, `depth-control`, `display-filter`, `edit-drag-preview`, `edit-handles`, `fr80-multi-vertex-drag`, `grid-toggle`, `human-bugs-3`, `knife-preview-north`, `survey`, `vis:driver-a`, `vis:v2-undo-style`, `vis:visual-b`。

**この 2 つがあるおかげで「実際に描かれた絵」を DOM 経由で検証できている。** Canvas 2D なので DOM には何も出ない。再設計でもこの窓は必ず残すこと。

---

## 5. 視覚回帰テスト（画像比較）

### 5.1 対象は 4 枚だけ

| 基準画像 | 撮る対象 | 寸法 | サイズ | 定義 | 許容差 |
|---|---|---|---|---|---|
| `e2e/sidebar-property.spec.ts-snapshots/sidebar-empty-win32.png` | `sidebar` 要素（空の状態） | 220×490 | 4.6 KB | `e2e/sidebar-property.spec.ts:76` | `maxDiffPixelRatio: 0.02` |
| `e2e/sidebar-property.spec.ts-snapshots/sidebar-property-populated-win32.png` | `sidebar-panel-properties`（面を 1 つ作った後） | 221×454 | 10.6 KB | 同 `:94` | 同 |
| `e2e/ux-cluster.spec.ts-snapshots/shell-no-scrollbars-win32.png` | `app-shell` 全体（起動直後） | **1280×800** | 326 KB | `e2e/ux-cluster.spec.ts:93` | 同 |
| `e2e/ux-cluster.spec.ts-snapshots/timeline-readable-win32.png` | `timeline` パネル | 1280×201 | 14.7 KB | 同 `:255` | 同 |

1280×800 はメインプロセスの既定ウィンドウサイズ（`src/shell/main/index.ts:171-172`）。

### 5.2 置き場所と命名

Playwright の既定テンプレートどおり `<spec と同じディレクトリ>/<spec ファイル名>-snapshots/<名前>-<プラットフォーム>.png`。`playwright.config.ts` に project を定義していないので project 名の区間は空になり、サフィックスは `-win32` だけ。**つまり基準画像は Windows 専用**で、別 OS で走らせると一致する画像が無いので新規作成扱いになる。

### 5.3 更新方法

```
npx playwright test e2e/sidebar-property.spec.ts e2e/ux-cluster.spec.ts --update-snapshots
```

`.autopilot/DECISIONS-HB3.md:58` にも「配置が変われば screenshot が変わるので **視覚回帰ベースライン再生成** を伴う」と過去の運用が記録されている＝再生成は通常運用であって事故ではない。

### 5.4 いま緑かどうか（実測）

2026-09-03 に実際に走らせた結果、**4 枚とも一致して緑**（`sidebar-property.spec.ts` 4 件 + `ux-cluster.spec.ts` 11 件 = 15 passed / 20.5 秒）。差分は出ていない。

### 5.5 これは「見た目の正しさ」を測っていない

4 枚のうち 3 枚は、もともと **「空っぽ／無スタイルで出荷された」退行**（HB-3: サイドバーが空、HB-5: 余計なスクロールバー、HB-11/13: タイムラインが読めない）を二度と起こさないための保険として置かれたもの。同じ spec の中に **画像に頼らない同趣旨のテスト**が必ず併設されている:

- `ux-cluster.spec.ts:50-70` は `scrollHeight - clientHeight <= 1` を数値で検査（画像不要）。
- `ux-cluster.spec.ts:72-85` はタイムラインの `scrollWidth - clientWidth <= 1`。
- `sidebar-property.spec.ts:20-42` はサイドバー内に `property-panel` が入っていることを DOM で検査。

→ **再設計では 4 枚を作り直すだけでよく、「絵が変わったから直す」という作業は発生しない。** 落ちたら見て、意図どおりなら `--update-snapshots`。

### 5.6 記録用スクショ（比較しない）

`page.screenshot({ path })` で撮って捨てるだけの証跡スクショは別枠。`screenshots/`（`.gitignore` 済み）配下に、`screenshot.spec.ts` が `app-shell.png` / `with-feature.png` を、`fr52-merge-options` / `hb3-12-existence-period` / `knife-nway` / `knife-preview-north` / `shortcut-suspend` が各 1〜3 枚を、`__bughunt__` 13 ファイルが `screenshots/__bughunt__/` に多数、`__visual__` 3 ファイルが大量に吐く。**比較には使われていないので、再設計で中身が変わっても赤くならない。**

---

## 6. 領域別「壊れる本数」の見積り

読み方: 「その UI 領域の testid（または属性）に触れているファイル」を数えたもの。**上限見積り**（そのファイルの全テストが落ちるとは限らないが、少なくとも 1 件は落ちる。テスト件数はそのファイルが持つ総数なので最悪ケース）。1 ファイルは複数領域に数え上げられる。

| UI 領域 | 壊れる E2E ファイル | 同・最大テスト件数 | 壊れる `.test.tsx` | 同・最大テスト件数 | 中心となるファイル |
|---|---|---|---|---|---|
| **シェル（枠組み・レイアウト）** | 42 / 52 | 111 / 130 | 5 | 44 | `shell/AppShell.test.tsx`(23), `launch.spec.ts`, `ux-cluster.spec.ts` |
| **ツールバー（モード・ツール選択）** | 42 / 52 | 99 | 3 | 42 | `Toolbar.tsx` の `mode-*`・`tool-*`。`helpers.ts` の `enterAddMode` 経由で全面波及 |
| **ツール: 追加** | 34 | 79 | 4 | 54 | `add-input-layer` / `add-complete` / `add-save`。データ準備の唯一の手段 |
| **App の隠し観測マーカー** | 36 | 83 | 0 | 0 | `app-active-feature` ほか（UI 非依存なので維持すれば無傷） |
| **メニューバー** | 21 | 51 | 4 | 38 | `shell/MenuBar.test.tsx`, `app-menu.spec.ts`, `shortcut-labels.spec.ts`, `flows.spec.ts` |
| **タイムライン** | 16 | 44 | 0 | 0 | `ux-cluster.spec.ts`(HB-11/12/13), `regression.spec.ts`, `hb3-12-existence-period.spec.ts` |
| **サイドバー: 一覧** | 21 | 43 | 3 | 49 | `shell/SidebarContent.test.tsx`(21), `sidebar-property.spec.ts` |
| **パネル: ヘルプ/検索/診断** | 14 | 34 | 1 | 21 | `help-tools.spec.ts`, `help-tools/HelpToolsController.test.tsx`(21) |
| **ツール: 分割（ナイフ）** | 13 | 29 | 4 | 48 | `knife-nway.spec.ts`, `knife-preview-north.spec.ts`, `knife/KnifeToolController.test.tsx`(21) |
| **ダイアログ: 競合解決** | 15 | 26 | 1 | 20 | ほぼ `__bughunt__`/`__visual__`。`conflict/ConflictResolutionModal.test.tsx`(20) |
| **右クリックメニュー** | 6 | 22 | 2 | 11 | `context-menu.spec.ts`, `display-filter.spec.ts` |
| **サイドバー: プロパティ** | 8 | 21 | **8** | **116** | `property/PropertyPanel.test.tsx`(40), `AnchorList`(12), `AnchorSection`(9), `DetailPanels`(8), `StyleSection`(7) ほか |
| **地図ウィジェット（深度/経度/グリッド）** | 7 | 21 | 3 | 21 | `depth-control`, `longitude-shift`, `grid-toggle` |
| **ツール: 結合** | 8 | 20 | 2 | 23 | `fr52-merge-options.spec.ts`, `merge/*.test.tsx` |
| **表示フィルタ** | 2 | 12 | 1 | 12 | `display-filter.spec.ts`(4件), `discovery/DisplayFilterPanel.test.tsx`(12) |
| **ダイアログ: 設定** | 5 | 10 | 2 | **48** | `settings/SettingsDialog.test.tsx`(27), `help-tools/HelpToolsController.test.tsx`(21) |
| **ツール: 計測** | 2 | 8 | 2 | 28 | `survey.spec.ts`(5), `survey/*.test.tsx` |
| **ツール: 環編集** | 1 | 8 | 2 | 26 | E2E は `vis:driver-a` のみ。実質コンポーネントテスト頼み |
| **ツール: 掘削** | 1 | 8 | 1 | 14 | 同上 |
| **ツール: 所属変更** | 3 | 6 | 1 | 16 | E2E は `__bughunt__` のみ |
| **ダイアログ: 未保存/修復** | 1 | 5 | 3 | **68** | `close-guard.spec.ts`(5), `file-ops/FileOpsController.test.tsx`(49) |
| **視覚回帰（画像 4 枚）** | 2 | 4 件が画像比較 | 0 | 0 | `sidebar-property`(2), `ux-cluster`(2) |

読み取れること:

1. **シェルとツールバーを作り直すと、E2E 52 ファイル中 42 ファイルが影響を受ける。** これは「サイドバーやタイムラインのテストも、まず `mode-view` を押して編集モードに入り、`tool-add.area` で面を描く」という共通の入口を全員が通るため。個別の領域を触るより、入口（モード切替とツール選択）を触るほうがはるかに広く波及する。
2. **`.test.tsx` の被害はプロパティパネル（116 件）・未保存/修復（68 件）・設定（48 件）に偏る。** これらは E2E 側が薄い（それぞれ 21 / 5 / 10 件）分をコンポーネントテストで埋めている構造。
3. **環編集・掘削・所属変更の 3 ツールは E2E が探索スペック（`__bughunt__` / `__visual__`）にしか無い。** ここを作り直すと、実際の回帰検知はコンポーネントテスト頼みになる。

---

## 7. 再設計でテストの駆動口を保つための推奨

### 推奨 A — testid の名前は「役割」で維持する（改名しない）

E2E が最も多く掴んでいる 10 個は以下（数字は参照している e2e ファイル数）。

`app-active-feature` 37 / `mode-view` 36 / `mode-edit` 35 / `add-input-layer` 34 / `mode-add` 33 / `add-complete` 33 / `add-save` 33 / `app-shell` 32 / `map-input-layer` 32 / `tool-add.area` 32。

これらはどれも **「画面のどこにあるか」ではなく「何ができるか」** を指している。レイアウトを全面的に変えても、新しい部品に同じ testid を付け直せば 130 件の大半はそのまま通る。**改名はしないこと。** どうしても意味が変わるなら、旧名を新しい部品に残す移行期間を設ける。

逆に、位置を含意する名前（`app-shell-topbar` / `map-overlay` / `sidebar-panel-*`）は再設計で意味を失う可能性が高い。ここは改名して構わないが、`.test.tsx` の該当箇所（`shell/AppShell.test.tsx` の 23 件, `shell/Sidebar.test.tsx` の 5 件）を同時に直す前提で。

### 推奨 B — 先に「面を 1 つ作る」手順をヘルパーへ一本化する（最優先）

現状 `e2e/helpers.ts` には `launchApp` / `enterAddMode` / `commitOneFace` の 3 つしかない。`launchApp` は 52 ファイル全部が使っているが、`enterAddMode` は 7 ファイル、`commitOneFace` は 14 ファイルしか使っていない。**残り 28 ファイルは同じ手順（`mode-view` を押して編集へ → `mode-add` → `tool-add.area` → 4 隅をクリック → `add-complete` → `add-save`）を直書きしている。**

直書きしているファイル（28）:
`bh:explore-r1〜r4`, `bh:explore-t2-r1`, `bh:explore2-r1〜r4`, `bh:explore3-r1〜r4`, `vis:driver-a`, `vis:v2-undo-style`, `vis:visual-b`, `aggregate-select`, `context-menu`, `depth-control`, `display-filter`, `edit-drag-preview`, `edit-handles`, `edit-select`, `fr52-merge-options`, `fr80-multi-vertex-drag`, `knife-preview-north`, `regression`, `view-mode`。

**再設計に着手する前に、この 28 箇所をヘルパー呼び出しに寄せる（ソース側は一切触らない純粋なテスト整理）。** そうすれば追加ツールの導線を作り直したとき、直す場所が 28 箇所から 1 箇所（`helpers.ts`）になる。これは今日からでもできる、いちばん費用対効果の高い準備。

同様に「編集モードに入って地物を選ぶ」「ナイフで切る」「時間を進める」もヘルパー化候補。

### 推奨 C — 隠しマーカーと `window.__E2E__` は仕様として残す

`app-*` の隠し span と `window.__E2E__` は見た目に依存しない観測窓で、**Canvas 描画の正しさを検証する唯一の手段**（§4.6）。UI をどう作り直しても壊れないので、新しい合成ルートでも同じ名前・同じ関数シグネチャで生やすこと。これを落とすと `edit-handles` / `edit-drag-preview` / `display-filter` / `grid-toggle` / `survey` などの「本当に描かれたか」を見るテストが全部書き直しになる。

### 推奨 D — テスト用のデータ投入口を新設することを検討する

現在 E2E は **ネイティブのファイルダイアログを避けるために、すべてのデータを UI で描いて作っている**（§2.3）。この設計のせいで、追加ツールの導線が変わると「追加ツールと無関係なテスト」まで巻き添えで落ちる（§6 の 1.）。

再設計に合わせて、`E2E_TEST=1` のときだけ `window.__E2E__.loadProject(json)` のような投入口を足せば、130 件のうち相当数を「追加導線から切り離す」ことができる。ただしこれはソース変更なので、この文書では **選択肢として提示するだけ**（実装は再設計本体の判断に委ねる）。

### 推奨 E — CSS クラス依存 12 箇所を先に testid へ移す

§4.2 の一覧のうち見た目に直結する 12 箇所。`.toolbar__modes` / `.tooltip` / `.tooltip__bubble` / `.menubar__item-accel` / `.timeline__tick-label` / `.timeline__ticks-unit` / `.timeline-markers` / `.context-menu__item` / `.conflict-row__features` / `.policy-choice__option` / `details.anchor-interval > summary`、および `xpath=ancestor::*[contains(@class,"tooltip")]`。ここはスタイルを書き換えた瞬間に落ちる。testid に置き換えるのはテスト側だけの作業ではなく src 側に testid を足す必要があるので、再設計の第 1 コミットに含めるのが自然。

### 推奨 F — 視覚回帰は「捨てて作り直す」前提でよい

§5.5 のとおり、4 枚はどれも同趣旨の非画像テストと併設されている。再設計では `--update-snapshots` で作り直すだけ。**むしろ再設計中は 4 枚を一時的に無効化しておき、レイアウトが固まってから最後に一度だけ生成し直すのが実務的。**

### 推奨 G — `__bughunt__` / `__visual__` の 27 件は別扱いにする

- 中身は探索用（1 ファイル＝巨大な 1 テスト、最長 1 分 30 秒）で、要件を固定する目的で書かれていない。**全 130 件の実行時間 10.6 分のうち 7.5 分（71%）をこの 16 件が占める。**
- それでいて `mode-*` / `tool-*` / `add-*` / `menu-*` をびっしり使うので、**再設計のたびに真っ先に落ちて、しかも直すのが最も面倒**（`explore3-r3` は 52KB、`driver-a` は 74KB）。
- 一方で、実行するとバグ候補を `BUGHUNT_SUMMARY:` として標準出力に吐く（今回の実走でも「merge が地物数を減らさない」「時間の進む/戻るが往復で元に戻らない」等を報告している）。**探索の価値はまだあるが、回帰ゲートとしての価値は低い。**

推奨: `playwright.config.ts` に `testIgnore: ['**/__bughunt__/**', '**/__visual__/**']` 相当を入れて既定の回帰ゲートから外し、探索したいときだけ明示的に走らせる運用へ分離する。**再設計中に直す対象が 52 ファイル → 36 ファイル、1 回の実行が 10.6 分 → 2 分に減る。**

### 推奨 H — 文言はアクセシブル名だけ揃える

§4.1 の 28 通り。ボタンの見た目を変えても `aria-label` を同じにすれば通る。ただし `ux-cluster.spec.ts` の HB-13（文字が見えている・32×64 以上）は **UI 仕様そのもの**なので、アイコンのみのツールバーにする設計はこのテストと正面衝突する。設計判断として先に決めること。

---

## 8. 付録

### 8.1 どのテストからも参照されない testid（33 個）

再設計で持ち越す必要がない＝そのまま消してよい候補。


| data-testid | 定義元 |
|---|---|
| `add-conflict-paused` | add/AddToolController.tsx |
| `add-controls` | add/AddToolController.tsx |
| `add-form-cancel` | add/AddPropertyForm.tsx |
| `add-message` | add/AddToolController.tsx |
| `anchor-edit-badge` | property/AnchorList.tsx |
| `anchor-list-empty` | property/AnchorList.tsx |
| `anchor-timebar-empty` | property/AnchorTimeBar.tsx |
| `conflict-apply-status` | conflict/ConflictResolutionModal.tsx |
| `conflict-rows` | conflict/ConflictResolutionModal.tsx |
| `delete-feature` | property/DeleteFeatureButton.tsx |
| `detail-panels` | property/DetailPanels.tsx |
| `diagnostics-empty-log` | help-tools/HelpToolsController.tsx |
| `drill-controls` | drill/DrillToolController.tsx |
| `drill-rejected` | drill/DrillToolController.tsx |
| `drill-rejected-dismiss` | drill/DrillToolController.tsx |
| `file-ops-dropzone` | file-ops/FileOpsController.tsx |
| `global-depth` | map/GlobalDepthControl.tsx |
| `grid-toggle-control` | map/GridToggleControl.tsx |
| `knife-controls` | knife/KnifeToolController.tsx |
| `knife-smaller-hint` | knife/InheritorModal.tsx |
| `knife-undo` | knife/KnifeToolController.tsx |
| `longitude-shift-hint` | map/LongitudeShiftControl.tsx |
| `merge-clear` | merge/MergeToolController.tsx |
| `merge-controls` | merge/MergeToolController.tsx |
| `merge-options-backdrop` | merge/MergeOptionsDialog.tsx |
| `merge-options-modal-root` | merge/MergeOptionsDialog.tsx |
| `merge-options-parent` | merge/MergeOptionsDialog.tsx |
| `merge-options-property` | merge/MergeOptionsDialog.tsx |
| `repair-dialog` | file-ops/RepairDialog.tsx |
| `reparent-controls` | reparent/ReparentToolController.tsx |
| `ring-edit-controls` | ring-edit/RingEditToolController.tsx |
| `sidebar-list-panel` | shell/SidebarContent.tsx |
| `survey-controls` | survey/SurveyControls.tsx |

### 8.2 `.test.tsx` だけが使う testid（129 個）

E2E からは見えないが、コンポーネントテストが掴んでいるもの。これを変えると `.test.tsx` 側だけが落ちる。動的生成（`anchor-interval-start-a1-year` のようにテスト内の固定 ID から組み立てるもの）が多い。


| data-testid | 定義元 | 使っている .test.tsx |
|---|---|---|
| `anchor-interval-delete-a2` | (動的生成) | property/PropertyPanel.test.tsx |
| `anchor-interval-end-a1-clear` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-end-a1-confirm` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-end-a1-open` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a1-specify` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a1-year` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-end-a2-clear` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a2-confirm` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a2-open` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a2-specify` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-end-a2-year` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-message-a1` | (動的生成) | property/PropertyPanel.test.tsx |
| `anchor-interval-start-a1-confirm` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-start-a1-day` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-start-a1-day-toggle` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-start-a1-error` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-start-a1-month` | (動的生成) | property/AnchorList.test.tsx |
| `anchor-interval-start-a1-month-toggle` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-interval-start-a1-year` | (動的生成) | property/AnchorList.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-row-a1` | (動的生成) | property/AnchorSection.test.tsx, property/PropertyPanel.test.tsx |
| `anchor-row-a2` | (動的生成) | property/PropertyPanel.test.tsx |
| `anchor-timebar` | property/AnchorTimeBar.tsx | property/AnchorSection.test.tsx, property/PropertyPanel.test.tsx |
| `app-shell-overlay` | shell/AppShell.tsx | shell/AppShell.test.tsx |
| `app-shell-topbar` | shell/AppShell.tsx | shell/AppShell.test.tsx |
| `auto-color-notice` | property/StyleSection.tsx | property/StyleSection.test.tsx |
| `conflict-backdrop` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-dialog` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-guide` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-paused-banner` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-rejection` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-retry` | conflict/ConflictResolutionModal.tsx | conflict/ConflictResolutionModal.test.tsx |
| `conflict-row-c1` | (動的生成) | conflict/ConflictResolutionModal.test.tsx |
| `conflict-row-c2` | (動的生成) | conflict/ConflictResolutionModal.test.tsx |
| `conflict-row-c9` | (動的生成) | conflict/ConflictResolutionModal.test.tsx |
| `depth-focus` | map/GlobalDepthControl.tsx | map/GlobalDepthControl.test.tsx |
| `depth-focus-apply` | map/GlobalDepthControl.tsx | map/GlobalDepthControl.test.tsx |
| `depth-focus-clear` | map/GlobalDepthControl.tsx | map/GlobalDepthControl.test.tsx |
| `depth-focus-depth` | map/GlobalDepthControl.tsx | map/GlobalDepthControl.test.tsx |
| `depth-focus-emphasize` | map/GlobalDepthControl.tsx | map/GlobalDepthControl.test.tsx |
| `detail-doc-mode-view` | property/DetailDocumentSection.tsx | property/DetailDocumentSection.test.tsx |
| `dialog` | (動的生成) | a11y/focus-trap.test.tsx |
| `display-filter-emphasize-line` | (動的生成) | discovery/DisplayFilterPanel.test.tsx |
| `display-filter-emphasize-point` | (動的生成) | discovery/DisplayFilterPanel.test.tsx |
| `drill-cancel` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-conflict-paused` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-guide` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-input-layer` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-message` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-undo` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `drill-vertex-count` | drill/DrillToolController.tsx | drill/DrillToolController.test.tsx |
| `error-boundary-fallback` | discovery/ErrorBoundary.tsx | discovery/ErrorBoundary.test.tsx, discovery/error-wiring.test.tsx |
| `event-list-item-anchor:f-a@1000` | (動的生成) | shell/SidebarContent.test.tsx |
| `event-list-item-anchor:f-a@1100` | (動的生成) | shell/SidebarContent.test.tsx |
| `event-list-item-anchor:f-toku@1000` | (動的生成) | shell/SidebarContent.test.tsx |
| `feature-list-item-f-a` | (動的生成) | shell/SidebarContent.test.tsx |
| `feature-list-item-f-b` | (動的生成) | shell/SidebarContent.test.tsx |
| `feature-list-item-f-oda` | (動的生成) | shell/SidebarContent.test.tsx |
| `feature-list-item-f-rome` | (動的生成) | shell/SidebarContent.test.tsx |
| `feature-list-item-f-toku` | (動的生成) | shell/SidebarContent.test.tsx |
| `first` | (動的生成) | a11y/focus-trap.test.tsx |
| `harness-confirm` | (動的生成) | settings/SettingsDialog.test.tsx |
| `knife-backdrop` | knife/InheritorModal.tsx | knife/KnifeToolController.test.tsx |
| `knife-cancel` | knife/KnifeToolController.tsx | knife/KnifeToolController.test.tsx |
| `knife-guide` | knife/KnifeToolController.tsx | knife-target-emphasis.test.tsx, knife/KnifeToolController.test.tsx |
| `knife-modal-cancel` | knife/InheritorModal.tsx | knife/KnifeToolController.test.tsx |
| `knife-preview-0` | (動的生成) | knife/InheritorModal.preview-geometry.test.tsx |
| `last` | (動的生成) | a11y/focus-trap.test.tsx |
| `ls` | (動的生成) | shell/Sidebar.test.tsx |
| `map-overlay` | shell/MapContainer.tsx | shell/AppShell.test.tsx |
| `map-widget` | (動的生成) | shell/AppShell.test.tsx |
| `menu-items-edit` | (動的生成) | shell/AppShell.test.tsx |
| `merge-cancel` | merge/MergeToolController.tsx | merge/MergeToolController.test.tsx |
| `merge-guide` | merge/MergeToolController.tsx | merge/MergeToolController.test.tsx |
| `merge-input-layer` | merge/MergeToolController.tsx | merge/MergeOptionsDialog.test.tsx, merge/MergeToolController.test.tsx |
| `merge-options-cancel` | merge/MergeOptionsDialog.tsx | merge/MergeOptionsDialog.test.tsx, merge/MergeToolController.test.tsx |
| `merge-parent-create-name` | merge/MergeOptionsDialog.tsx | merge/MergeOptionsDialog.test.tsx |
| `merge-parent-existing-pick` | merge/MergeOptionsDialog.tsx | merge/MergeOptionsDialog.test.tsx |
| `merge-property-inherit-pick` | merge/MergeOptionsDialog.tsx | merge/MergeOptionsDialog.test.tsx |
| `merge-tool` | merge/MergeToolController.tsx | merge/MergeToolController.test.tsx |
| `mid` | (動的生成) | a11y/focus-trap.test.tsx |
| `ok` | (動的生成) | discovery/ErrorBoundary.test.tsx |
| `ov-content` | (動的生成) | shell/AppShell.test.tsx |
| `panel-header-p1` | (動的生成) | shell/DraggablePanel.test.tsx |
| `panel-header-p2` | (動的生成) | shell/DraggablePanel.test.tsx |
| `panel-p1` | (動的生成) | shell/DraggablePanel.test.tsx |
| `panel-p2` | (動的生成) | shell/DraggablePanel.test.tsx |
| `panel-p3` | (動的生成) | shell/DraggablePanel.test.tsx |
| `panel-p4` | (動的生成) | shell/DraggablePanel.test.tsx |
| `pr` | (動的生成) | shell/Sidebar.test.tsx |
| `property-guidance` | property/PropertyPanel.tsx | property/PropertyPanel.test.tsx, selection-display-heal.test.tsx, shell/SidebarContent.test.tsx |
| `repair-abort` | file-ops/RepairDialog.tsx | file-ops/FileOpsController.test.tsx, file-ops/RepairDialog.test.tsx |
| `repair-apply` | file-ops/RepairDialog.tsx | file-ops/FileOpsController.test.tsx, file-ops/RepairDialog.test.tsx |
| `repair-list` | file-ops/RepairDialog.tsx | file-ops/RepairDialog.test.tsx |
| `repair-modal-root` | file-ops/RepairDialog.tsx | file-ops/FileOpsController.test.tsx, file-ops/RepairDialog.test.tsx |
| `repair-unresolved` | file-ops/RepairDialog.tsx | file-ops/FileOpsController.test.tsx, file-ops/RepairDialog.test.tsx |
| `reparent-clear` | reparent/ReparentToolController.tsx | reparent/ReparentToolController.test.tsx |
| `reparent-confirm-none` | reparent/ReparentToolController.tsx | reparent/ReparentToolController.test.tsx |
| `reparent-guide` | reparent/ReparentToolController.tsx | reparent/ReparentToolController.test.tsx |
| `reparent-input-layer` | reparent/ReparentToolController.tsx | reparent/ReparentToolController.test.tsx |
| `reparent-tool` | reparent/ReparentToolController.tsx | reparent/ReparentToolController.test.tsx |
| `ring-edit-guide` | ring-edit/RingEditToolController.tsx | ring-edit/RingEditToolController.test.tsx, ring-edit/ring-edit-reachability.test.tsx |
| `ring-edit-input-layer` | ring-edit/RingEditToolController.tsx | ring-edit/RingEditToolController.test.tsx, ring-edit/ring-edit-reachability.test.tsx |
| `ring-edit-message` | ring-edit/RingEditToolController.tsx | ring-edit/RingEditToolController.test.tsx, ring-edit/ring-edit-reachability.test.tsx |
| `ring-edit-undo` | ring-edit/RingEditToolController.tsx | ring-edit/RingEditToolController.test.tsx |
| `ring-edit-vertex-count` | ring-edit/RingEditToolController.tsx | ring-edit/RingEditToolController.test.tsx, ring-edit/ring-edit-reachability.test.tsx |
| `settings-backdrop` | settings/SettingsDialog.tsx | settings/SettingsDialog.test.tsx |
| `settings-basemap-replace` | file-ops/basemap-replace.ts<br>settings/SettingsDialog.tsx | help-tools/HelpToolsController.test.tsx, settings/SettingsDialog.test.tsx |
| `settings-custom-palette` | settings/SettingsDialog.tsx | settings/SettingsDialog.test.tsx |
| `settings-grid-visible` | settings/SettingsDialog.tsx | settings/SettingsDialog.test.tsx |
| `settings-palette-add` | settings/SettingsDialog.tsx | settings/SettingsDialog.test.tsx |
| `settings-project` | settings/SettingsDialog.tsx | settings/SettingsDialog.test.tsx |
| `sibling-overlay` | (動的生成) | knife/KnifeToolController.test.tsx |
| `style-section` | property/StyleSection.tsx | property/PropertyPanel.test.tsx |
| `survey-format-decimal` | (動的生成) | survey/SurveyControls.test.tsx |
| `survey-readout` | survey/SurveyControls.tsx | survey/SurveyControls.test.tsx |
| `timebar-axis` | property/AnchorTimeBar.tsx | property/AnchorSection.test.tsx |
| `timebar-bar-a1` | (動的生成) | property/AnchorSection.test.tsx |
| `timebar-bar-a2` | (動的生成) | property/AnchorSection.test.tsx |
| `timebar-bar-thin` | (動的生成) | property/AnchorSection.test.tsx |
| `timebar-bar-wide` | (動的生成) | property/AnchorSection.test.tsx |
| `tl` | (動的生成) | shell/AppShell.test.tsx |
| `toolbar-tools` | shell/Toolbar.tsx | shell/AppShell.test.tsx |
| `top-widget` | (動的生成) | shell/AppShell.test.tsx |
| `unified-list-count` | (動的生成) | shell/SidebarContent.test.tsx |
| `unified-list-filter` | (動的生成) | shell/SidebarContent.test.tsx |
| `unified-list-no-match` | (動的生成) | shell/SidebarContent.test.tsx |
| `unsaved-body` | file-ops/UnsavedWarningDialog.tsx | file-ops/UnsavedWarningDialog.test.tsx |
| `unsaved-save` | file-ops/UnsavedWarningDialog.tsx | file-ops/FileOpsController.test.tsx, file-ops/UnsavedWarningDialog.test.tsx |
| `view-only-notice` | property/BasicInfoForm.tsx | property/PropertyPanel.test.tsx |

### 8.3 E2E ファイル一覧（テスト件数つき）

`npx playwright test --list` 実測。

| ファイル | 件数 | 主題 |
|---|---|---|
| `ux-cluster.spec.ts` | 11 | HB-5 スクロールバー / HB-10 Ctrl+Y / HB-11〜13 タイムライン可読性（**視覚回帰 2 枚**） |
| `__visual__/driver-a.spec.ts` | 8 | 目視用スクショの大量撮影（環編集・掘削・表示フィルタ・ナイフを一通り駆動） |
| `regression.spec.ts` | 7 | 追加→分割→時間→元に戻す の主要回帰 |
| `human-bugs-3.spec.ts` | 7 | 人間テストで出たバグ群 |
| `survey.spec.ts` | 5 | FR-14/15/16 測量モード |
| `help-tools.spec.ts` | 5 | 検索・バージョン情報・ショートカット一覧・診断・設定 |
| `close-guard.spec.ts` | 5 | FR-107 未保存確認（× / Alt+F4 経路） |
| `sidebar-property.spec.ts` | 4 | HB-3 サイドバー結線（**視覚回帰 2 枚**） |
| `longitude-shift.spec.ts` | 4 | FR-12 経度シフト |
| `display-filter.spec.ts` | 4 | FR-113 表示フィルタ・強調 |
| `app-menu.spec.ts` | 4 | Electron 既定メニュー無効化 |
| `__bughunt__/explore-t2-r1.spec.ts` | 4 | 探索 |
| `view-niceties.spec.ts` | 3 | 全体表示・ステータスバー座標 |
| `view-mode.spec.ts` | 3 | HB-4 表示専用解除 / HB-16 ツールチップ |
| `launch.spec.ts` | 3 | 起動・IPC・コンソール無エラー |
| `hb3-12-existence-period.spec.ts` | 3 | 存在期間 |
| `flows.spec.ts` | 3 | ファイルメニュー到達性 |
| `edit-handles.spec.ts` | 3 | 頂点ハンドルの描画 |
| `context-menu.spec.ts` | 3 | FR-96 右クリックメニュー |
| `shortcut-suspend.spec.ts` | 2 | モーダル中のショートカット停止 |
| `shortcut-labels.spec.ts` | 2 | HB-2 アクセラレータ表記 |
| `screenshot.spec.ts` | 2 | 記録スクショ生成（比較なし） |
| `map-pan-zoom.spec.ts` | 2 | 地図の pan / zoom |
| `edit-select.spec.ts` | 2 | 選択 |
| `coord-cluster.spec.ts` | 2 | 座標系 |
| `add-knife-camera.spec.ts` | 2 | 追加・ナイフとカメラ |
| `__visual__/v2-undo-style.spec.ts` | 2 | 目視用 |
| `zoom-cull.spec.ts` / `resize-coord.spec.ts` / `real-shapes.spec.ts` / `knife-preview-north.spec.ts` / `knife-nway.spec.ts` / `grid-toggle.spec.ts` / `fr80-multi-vertex-drag.spec.ts` / `fr52-merge-options.spec.ts` / `edit-drag-preview.spec.ts` / `detail-document.spec.ts` / `depth-control.spec.ts` / `aggregate-select.spec.ts` / `__visual__/visual-b.spec.ts` | 各 1 | — |
| `__bughunt__/explore-r1〜r4`, `explore2-r1〜r4`, `explore3-r1〜r4` | 各 1 | 探索（1 件が巨大） |

### 8.4 `.test.tsx` の件数が多い順（上位 20）

| ファイル | 件数 |
|---|---|
| `src/ui/map/live-hit-test.test.tsx` | 51 |
| `src/ui/consistency-binding.test.tsx` | 50 |
| `src/ui/file-ops/FileOpsController.test.tsx` | 49 |
| `src/ui/property/PropertyPanel.test.tsx` | 40 |
| `src/ui/settings/SettingsDialog.test.tsx` | 27 |
| `src/ui/vertex-delete.test.tsx` | 25 |
| `src/ui/shell/AppShell.test.tsx` | 23 |
| `src/ui/shell/SidebarContent.test.tsx` | 21 |
| `src/ui/knife/KnifeToolController.test.tsx` | 21 |
| `src/ui/help-tools/HelpToolsController.test.tsx` | 21 |
| `src/ui/conflict/ConflictResolutionModal.test.tsx` | 20 |
| `src/ui/survey/SurveyToolController.test.tsx` | 17 |
| `src/ui/ring-edit/RingEditToolController.test.tsx` | 16 |
| `src/ui/reparent/ReparentToolController.test.tsx` | 16 |
| `src/ui/add/AddToolController.test.tsx` | 16 |
| `src/ui/knife-target-emphasis.test.tsx` | 15 |
| `src/ui/live-lookup.test.tsx` | 14 |
| `src/ui/drill/DrillToolController.test.tsx` | 14 |
| `src/ui/context-menu-launch.test.tsx` | 14 |
| `src/ui/shell/useShortcuts.test.tsx` / `src/ui/property/AnchorList.test.tsx` / `src/ui/merge/MergeToolController.test.tsx` / `src/ui/discovery/DisplayFilterPanel.test.tsx` / `src/ui/add/useAddTool.test.tsx` | 各 12 |

### 8.5 `shell/AppShell.test.tsx` が固定しているレイアウト契約（23 件）

再設計で真っ先にぶつかるので個別に挙げる（根拠: `src/ui/shell/AppShell.test.tsx` の各 `it`）。

| 固定している内容 | 行 |
|---|---|
| `menubar` / `toolbar` / `map-area` / `map-canvas-mount` / `map-input-layer` / `sidebar` / `statusbar` / タイムラインスロット が全部存在する | 25 |
| `mapOverlay` スロットは **`map-area` の中**（全画面オーバーレイの中ではない）。経度シフトがタイムラインの「1年次へ進む」ボタンを覆ってしまった事故の再発防止 | 37 |
| `topBar` スロットは地図の上に重ねず、行として上に積む | 60 |
| `topBar` を渡さなければその行は潰れる | 77 |
| サイドバーは **2 セクション**（一覧 / プロパティ）— HB6 で統合済み | 82 |
| メニューは **5 つ** | 88 |
| 追加モードと編集モードは排他（両方 on にならない） | 97 |
| モードごとにツール一覧が入れ替わる／モードを切ると選択中のツールは捨てる | 110, 121 |
| 表示専用でモードトグルとツールが無効化され、戻すと再有効化 | 133 |
| 編集系メニュー項目は表示専用で無効、表示系は有効のまま | 146, 166 |
| ツールボタンのホバーで日本語のツールチップが出る | 180 |
| モードボタンに日本語ラベルが載る／ツールチップの包みが無い／それでもクリックで動く（HB-16） | 188, 196, 208 |
| ツールボタンはツールチップを保持（HB-16 の取りすぎ防止） | 222 |
| Ctrl+Z が元に戻すに繋がる／表示専用では無効／未登録キーで例外を出さない | 230, 241, 252 |
| `suspended` でショートカットが止まる／既定では動く | 261, 272 |
| 空のオーバーレイは地図の入力層を覆わない（`pointer-events: none`） | 285 |

---

## 9. 確かめられなかったこと

- 過去ログ（`.autopilot/DECISIONS.md` D53 は「10 failed / 75 passed」、D35 は「54 passed」）と今回の 130 passed は **spec の集合そのものが違う**ので、増減の意味を厳密には比較できない。今回わかったのは「2026-09-03 時点で 130 件すべて緑」という事実だけ。
- **他 OS（mac / linux）での挙動**。基準画像は `-win32` しか無いので、別 OS では視覚回帰が新規作成扱いになるはず、というのはコード上の推論であって実測していない。
- **`retries: 1` がどれだけ効いているか**。今回の実走ではコールドスタート起因の再試行が発生したかを個別に追っていない。
- **`.test.tsx` 794 件のうち、実際にどれだけが「UI の形」に依存しているか**の精密な切り分け。本文 §6 の件数は「その領域の testid に触れているファイルの総件数」＝上限であり、1 件単位の依存関係までは追っていない。
