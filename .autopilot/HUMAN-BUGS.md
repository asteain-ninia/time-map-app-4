# 人間テストで発見されたバグ（最優先・QUALITY完了直後に専用パスで修正）

ユーザーが実機(`npm run dev`)で手動テストして報告。緑のユニット/E2E(オフスクリーン)が取りこぼした実バグ＝合成ルートの結線漏れ/プラットフォーム解決漏れ系。各バグは Codex(gpt-5.5)局所レビュー込みで根本修正し、**バグごとに commit**、最後に実機スクショ/E2Eで回帰防御。

## HB-1: パン/ズームが効かない（最優先） — [解決]
- 症状: 地図をパンできない・ホイールズームできない。
- 初期診断: 入力層(U40 PointerDispatcher/pan)とカメラ(U17 VTransform)は実装済みだが、App.tsx の合成でポインタドラッグのパンとホイールの ViewZoomIn/Out が実ビューポート(カメラ)へ結線されていない疑い。
- 検証: e2e に「パン→カメラ平行移動」「ホイール→ズーム倍率変化」のアサートを追加（現E2Eは press→move→release が crash しないのみで挙動未検証）。
- **[解決]**: ポインタドラッグの pan とホイールの ViewZoomIn/Out を live カメラ(VTransform)へ合成ルートで結線。観測フック `data-pan-x/y` / `data-zoom` を露出。
  - 対応コミット: `4ad603c fix(humanbug:HB-1): wire pan + wheel-zoom to the live camera (+ behavioral E2E)`
  - 追加E2E: `e2e/map-pan-zoom.spec.ts`（実 `mouse.down→move→up` で `data-pan-x/y` 変化 / 実 `mouse.wheel` で `data-zoom` 変化を assert）= 2 passed。

## HB-2: ショートカットラベルが "Mod"（Windowsで未解決） — [解決]
- 症状: メニュー/ヘルプのショートカット表記が "Mod+S" 等。Windows なので "Ctrl" であるべき。
- 初期診断: `src/ui/shell/menu.ts` は `{key:'s', ctrlOrMeta:true}`。ラベル整形(shortcuts.ts 周辺)が `ctrlOrMeta` をプラットフォーム解決せず "Mod" 表示。
- 修正: 整形時に `process.platform`(またはレンダラに渡す OS フラグ)で Win/Linux→"Ctrl"、mac→"Cmd"(⌘) に解決。dispatch 側のキー判定は不変(表示のみ修正)。回帰テスト追加。
- **[解決]**: ラベル整形で `ctrlOrMeta` を OS フラグでプラットフォーム解決（Windows→"Ctrl"）。dispatch のキー判定は不変（表示のみ）。
  - 対応コミット: `fe9b958 fix(humanbug:HB-2): resolve ctrlOrMeta to platform key (Ctrl on Windows) in shortcut labels (+ E2E)`
  - 追加E2E: `e2e/shortcut-labels.spec.ts`（保存アクセラレータが Windows で "Ctrl" を含み "Mod" を含まない / 全ファイル・編集メニューに "Mod" が一切現れない）= 2 passed。

## HB-3: プロパティが画面下部に無スタイル、サイドバー空 — [解決]
- 症状: 右サイドバー(イベント一覧/地物一覧/プロパティ)が空。PropertyPanel の内容が画面下部に素のまま並ぶ。
- 初期診断: サイドバーのタブ↔パネル内容の結線漏れ、または PropertyPanel が AppShell のサイドバースロットでなく別所にマウント。CSS 未適用も伴う。
- 修正: サイドバースロットに各パネル(PropertyPanel/地物一覧/イベント一覧)を結線、レイアウト/CSS を当てる。E2E に「プロパティがサイドバー内に存在」アサート。
- **[解決]**: AppShell のサイドバースロットへ PropertyPanel/地物一覧/イベント一覧の3パネルを結線し、レイアウト/CSS を適用（`SidebarContent` 新設、`SidebarContent.test.tsx`）。
  - 対応コミット: `0f84b3c fix(humanbug:HB-3): mount property/feature/event panels in the sidebar slot + styling (+ E2E + visual)`
  - 追加E2E: `e2e/sidebar-property.spec.ts`（3パネルがサイドバー内にマウント / 選択でPropertyPanelフィールドが可視 / 空サイドバーのchrome描画・populatedパネルのスタイル適用のビジュアル回帰）= 4 passed。

## HB-4: ツールバーが保存類以外グレーアウト（編集系に入れない） — [解決]
- 症状: 追加/編集モード等が常時無効。保存系のみ活性。
- 初期診断: 実装待ちではない(追加フローは実在・E2E通過)。起動時 表示専用(View-only)モードから抜ける導線(ViewToggleViewMode)が効かず、enabled 判定が編集系を無効のまま。
- 修正: 表示専用トグルを機能させ(ツールバー/メニューから)、モード遷移で追加/編集系を活性化。E2E に「表示専用解除→追加モード活性→面追加」フロー追加(現状は controller 直叩きで回避していた死角)。
- **[解決]**: 表示専用トグル(ツールバー/`表示`メニュー `ViewToggleViewMode`)を機能させ、モード遷移で追加/編集系を活性化。
  - 対応コミット: `a4e0732 fix(humanbug:HB-4): make view-mode toggle enable edit tools via the real UI (+ behavioral E2E)`
  - 追加E2E: `e2e/view-mode.spec.ts`（起動時は編集ツール無効→ツールバー表示専用トグルで追加モード活性化→実UI経路で面を1つ追加 / `表示`メニューの表示専用モード切替コマンドが登録・活性でモードを反転）= 2 passed。

> 方針: 「部品は出来ているが合成ルートで未結線/未解決」が共通根。App.tsx 合成ルート＋shell/sidebar 配線＋ラベル整形を中心に。デグレ厳禁(毎回フルスイート＋E2E緑)。

## 検証格上げ（必須）— 人間バグを自動で捕まえる
現E2Eは「press→move→release が落ちない」止まりで挙動を検証していなかった。Playwright は実ドラッグ(`mouse.down/move/up`)・ホイール(`mouse.wheel`)・キー・ビジュアル差分(`toHaveScreenshot`)を模擬できる。各バグ修正に以下を必須で付ける:

1. **観測フック**: `E2E_TEST` 下 or `data-testid` で、カメラのパン量(data-pan-x/y)・ズーム倍率(data-zoom)・現在モード/ツール(app-mode/app-active-tool)・サイドバーの中身・選択 をテストから読める状態にする(既存 `app-active-feature` マーカーと同方式)。
2. **挙動アサートE2E(各バグ1本=回帰ロック)**:
   - HB-1: `mouse.down→move→up` でカメラのパン量が変化 / `mouse.wheel` でズーム倍率が変化。
   - HB-2: ショートカット表記が Windows で "Ctrl"("Mod" でない)。
   - HB-3: PropertyPanel がサイドバー内に存在しフィールドが可視。
   - HB-4: 表示専用解除→追加モード活性→実UI経路で面を1つ追加(controller 直叩きの死角を排除)。
3. **ビジュアル回帰(補助)**: 主要画面を `toHaveScreenshot` で差分比較し「空サイドバー/無スタイル」等の見た目崩れを画像検出(オフスクリーン決定論描画なので安定)。
4. **標準ルール**: 以降、人間が見つけたバグは必ず「それを捕まえる回帰E2E」を1本添える。核心操作(パン/ズーム/追加/編集/ナイフ/タイムライン/保存読込)に behavioral E2E スイートを敷き、オフスクリーンE2Eの死角を縮める。
