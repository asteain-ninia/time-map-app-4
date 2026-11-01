---
paths:
  - "src/domain/persistence/**"
  - "src/shell/**"
  - "src/domain/geo/**"
  - "src/ui/state/**"
  - "src/ui/settings/**"
  - "src/ui/file-ops/**"
---

# 保存・読み込み・本体プロセスの教訓

番号は変えない。コードや文書が「開発ガイド §5.N」として参照している。

文言の表の規則は `lessons-ui.md` の §5.99 を見る（中核と本体プロセスの表も対象。`○○-messages.ts` と `○○-strings.ts` は何も読み込まない）。

### 5.22 確定まで共有データを破壊的に更新しない
- 正しい道: 検証用の仮データで成功を確認してから共有キャッシュ/共有データへ反映し、失敗時は追加した要素をすべてロールバックする。永続化は一時ファイルに書いてから置き換え、バックアップは新しい写しが確定してから古いものを消す。
- 誤った道の兆候: 確認ダイアログの前に中身を変えている（やめても元に戻らない）。先に古いものを消してから新しいものを作っている。永続化の失敗でキャッシュが汚れる。
- 確かめ方: `src/shell/io/atomic.test.ts`、`src/shell/io/backup.test.ts`、`src/domain/basemap/format.test.ts`、`e2e/delete-confirm.spec.ts`（やめたら 1 件も消えない）。

### 5.31 永続化の読み書き・検証・移行・往復テストを同期する
- 正しい道: 読み（deserialize）・書き（serialize）・検証（validation）・往復テストは同じ変更単位で同期する。外部入力は `parseManifest` の境界を通す。移行の枝はまだ無く、版の合わないファイルは警告か拒否にする（`schema.ts`、`boundary.ts`）ので、移行を足すならこれも同じ単位に入れる。
- 誤った道の兆候: 片側だけ変えた「保存はできるが次に開けない」経路。型チェックでも実行時テストでも検出されない。フィールドを optional 化・撤去・固定値化するのに再保存往復テストが無い。
- 確かめ方: `src/domain/persistence/round-trip.test.ts`、`src/domain/persistence/schema.test.ts`、`src/domain/persistence/pre-save.test.ts`、`src/domain/persistence/lint-boundary.test.ts`、`eslint.config.js` の `persistenceBoundary`（`deserialize` の直接 import 禁止）。

### 5.33 層をまたぐ API 契約は両側テストで固定する
- 正しい道: 呼び出し側・公開側・受信側のチャネル名/関数名は、共有型（`src/shell/ipc/contract.ts`）・型付きラッパー・両側の単体テストで固定する。API 名変更時は全層とテストを同じ変更単位で更新し、旧名が残っていないか検索する。
- 誤った道の兆候: チャネル名や関数名を各層に文字列で書いている（文字列の偶然一致）。除外リストをテストに直書きしている（契約 1 か所で宣言する）。
- 確かめ方: `src/shell/preload/preload.test.ts`、`src/shell/ipc/e2e-harness.test.ts`、`src/render/map-renderer.contract.test.ts`、`src/domain/selection/contracts.test.ts`、`src/domain/affiliation/adapter.test.ts`。

### 5.36 プロジェクト設定とアプリ全体設定の境界を先に定義する
- 正しい道: プロジェクト固有設定とアプリ全体設定の境界を先に定義し、保存先と反映先を一貫させる。新規プロジェクト開始時は表示中データに加えて、保存先パス・メタデータ・バックアップ対象・dirty 状態・終了確認ガードも同じ保存文脈として同時に初期化する（`buildNewProjectContext`）。第 3 の区分「セッション限りの見え方」も用意する: `gridVisibleOverride` のようにセッション用の上書きを別に持ち（`null` = 上書きなし）、読むのは「上書きがあればそれ、無ければ設定」。上書きを書く経路は保存も dirty もしないので権限の関門が要らない。
- 誤った道の兆候: 「保存したい既定値」と「いまだけ変えたい見え方」が同じ 1 つの鍵に同居している。グリッドの ON/OFF を押すだけで未保存の印が立つ。これに表示専用の関門を掛けると、起動直後は常に読むだけなので、開いて眺めるだけの人が一度もグリッドを消せない。直し方は関門をゆるめることではなく置き場を分けること。
- 確かめ方: 設定の鍵を 1 つずつ「これを変えたら保存ファイルが変わるべきか」「読むだけの人が変えたいか」の 2 問で分類し、両方 yes なら鍵を 2 つに割る（「見え方かどうか」だけで分類すると取り違える）。`src/ui/shell/view-only-gate.test.tsx`、`src/ui/map/GridToggleControl.test.tsx`、`src/ui/file-ops/save-context.test.ts`、`src/ui/settings/SettingsDialog.test.tsx`。

### 5.43 粗い点列化を入れる前に、粗さに関係なく成り立たせるべき不変条件を洗い出す
- 正しい道: 点列を粗くする変更では、まず「隣接する 2 点のあいだに暗黙に期待されている上限」（距離・角度・経度差）を列挙し、粗くした後もその上限を保つ処理を同じ変更単位に入れる。例: 保存形式は 1 辺で経度 180 度以上を渡る形を表現できない（技術方針 §6.8）ので、書き出す側で中間点を打つ。
- 誤った道の兆候: 間引き・直線の端点だけの採用が「それ自体は正しい改善」として入り、密なサンプリングが偶然満たしていた前提を確かめていない（南緯 90 度を横断する辺は等長サンプリングで何千点にも刻まれて成立していた）。合成した小さな入力だけで往復を確かめている（長い辺が生まれず素通りする）。
- 確かめ方: 保存・読込の往復と整合性チェックを、粗い点列を生む実データへ掛ける。経度 180 度の関門は `src/domain/geo/long-edge.ts` に 1 本化され、`src/domain/editing/slide.test.ts`・`src/domain/add/shape-draft.test.ts`・`src/domain/drill/drill-geometry.test.ts` が通る。書き出し側の分割は `../derle-map-visualizer/gimoza.js`。

### 5.48 実データの正準ファイルをアプリで直接開かない — 検証は一時コピーで行う
- 正しい道: 実データを載せる検証（E2E・手動・調査スクリプトを問わず）は、必ず一時ディレクトリへコピーしてから開く。E2E は `launchAppWithProject` にコピーのパスを渡す。
- 誤った道の兆候: `derle-import/*.gimoza` をそのまま開く手順（アプリは開いたファイルを保存先に昇格するので、保存・自動保存・修復の適用が正準ファイルを上書きする）。正準ファイルの隣に `*.gimoza.bak.*` が新しく出来ている。
- 確かめ方: `e2e/real-data.spec.ts`・`e2e/real-data-anchor.spec.ts` が正準ファイルのサイズと更新時刻の不変を確かめる。`scripts/measure-snap-tolerance.ts` は derle-import の直接指定を例外で断る。`CLAUDE.md` にも同じ規則がある。

### 5.66 オフスクリーンで描いていても、`show()` を呼べばウィンドウは前面に出る
- 正しい道: オフスクリーンにする条件とウィンドウを出す条件を同じ 1 つの述語から導く（`src/shell/main/headless-window.ts` の `isHeadlessRun` と `windowRevealAction`。旗は `E2E_TEST`／`SMOKE_TEST`／`E2E_OFFSCREEN`）。`show: false` のまま放っておけば前面に出ない。
- 誤った道の兆候: 起動モードの旗で「どう描くか」だけ分岐し、`ready-to-show` → `show()` が無条件（OS のフォーカスまで奪う。E2E は 1 テスト＝Electron 1 起動 × ワーカー 6 本で、利用者が PC で他の作業をできなくなった）。「テストが緑だから問題ない」（占有の副作用は成否に現れない）。音・通知・タスクバー表示・最前面固定・スクリーンセーバ抑止のような「テストのときだけ静かにする」設定も同じ型。
- 確かめ方: `src/shell/main/headless-window.test.ts`（表示とオフスクリーンが割れないこと）。占有の実測は、`scripts/measure-foreground.ps1`（`GetForegroundWindow` → `GetWindowThreadProcessId` を読む）をテストと並行して回し、前面が electron に変わった回数を数える（直す前 32 回・記録時間の 4 割、直した後 0 回）。

### 5.82 「この PC の覚え書き」は書類の中に置かない ―― 置き場を分けたら、画面へも映す
- 正しい道: 「今後表示しない」の類はアプリ側の置き場（`userData` の JSON 1 枚。`src/shell/io/app-prefs.ts`）へ書き、画面の設定欄にも映す。映すときは「利用者が変えた印」と「読み込みで既定へ戻った」を `lastSettingsChange` で区別する（`src/ui/shell/FirstRunGuide.tsx`）。
- 誤った道の兆候: 書類（プロジェクトファイル）の設定にだけ書く（起動直後の新規の書類では行き先が無く、押しても次の起動でまた出る）。設定欄は「表示する」なのに出ない。書類を開くたびに覚え書きが元へ戻る。
- 確かめ方: アプリを 2 回起動する E2E（1 回目で押し、閉じ、2 回目で出ない）。`e2e/inc6-rail.spec.ts`（594〜621 行）、`src/shell/io/app-prefs.test.ts`。
