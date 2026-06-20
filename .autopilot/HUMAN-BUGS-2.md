# 人間テスト 第2ラウンドのバグ（最優先・専用パスで修正）

ユーザーが安定ビルドを手動テストして報告（2026-06-21）。各々 Codex(gpt-5.5)局所レビュー込みで根本修正・**バグごとに commit**・**挙動/ビジュアル E2E で回帰ロック**（behavioral-e2e-standard）。

## 共通根の仮説（クラスタ）
- **座標変換/ヒットテスト クラスタ**: HB-6(カーソル中心ズーム不成立)・HB-7(頂点追加がカーソル位置でなく中心)・HB-15(頂点が一切選択できない=クリック位置ズレ)。screen↔world(`src/render/vtransform.ts`)・カメラ(U17)・ヒットテストの座標写像が疑わしい。**最優先で根本から**。
- **カリング/クリップ**: HB-14(拡大で地物が消える)。`feature-layer.ts` は「U10 で絞った候補集合」を受け取る前提＝候補集合/ビューポートクリップ/period-aware wrap(QUALITY 389a469)あたり。**v1/2/3 全てで再発した古典＝最重要**。
- **死にコマンド**: HB-8/HB-9（ハンドラ未登録で常時 disabled、HB-4 と同クラス）。

## 確定状況（第2ラウンド finalize, 2026-06-21）

全体検証3点 + E2E 全緑（skip 0・デグレなし）で確定:

- `npm run typecheck` = 緑（node/web/e2e 3 プロジェクト）
- `npm run lint` = 0
- `npm run test` = 204 files / 2098 tests passed（skip 0）
- `npm run test:e2e` = 43 passed（skip 0）。`screenshots/app-shell.png` / `with-feature.png` 再生成確認。

座標クラスタ(HB-6/7/14/15)は単一の screen↔world 真実源 `src/render/vtransform.ts`（`worldToScreen`/`screenToWorld` は厳密な逆写像）+ キャンバス箱オフセット補正 `src/ui/add/host-ports.ts` `screenToWorld`（`clientX - box.left`）で根本修正。再発防止のプロパティ/メタモルフィックテスト（`src/render/vtransform.test.ts`: screen→world→screen=恒等, cursor invariant）あり。

## バグ一覧

- **HB-5** [解決]: いろんな所にスクロールバーが出る。CSS overflow/レイアウト。→ shell.css の各コンテナ overflow:hidden / 内部スクロール化、ビジュアル回帰。対応コミット `ea78e6a`。追加E2E: `e2e/ux-cluster.spec.ts`（document/timeline 非オーバーフロー + `shell-no-scrollbars` ビジュアル）。
- **HB-6** [解決]: 追加/表示モードでホイールズームの**中心がカーソルにならない**（中心固定）。→ cursor-anchored zoom（`vtransform.ts` `zoomAtCursor`/`zoomStepAtCursor`、`PointerDispatcher`→ライブカメラ結線）。対応コミット: 根本修正 `a4edd8d`（vtransform 追加）/ 結線 `4ad603c`（HB-1 pan/zoom 結線）。追加E2E: `e2e/coord-cluster.spec.ts`（既知オフセンタ・カーソルでホイール→その世界点が画面上ほぼ不動 ≤2px、中心固定なら赤）。プロパティ: `vtransform.test.ts`。
- **HB-7** [解決]: 追加モードで**頂点の追加位置がカーソルにならない（全体中心になる?）**。→ click(screen)→world 写像を箱オフセット補正込みで修正（`host-ports.ts` `screenToWorld`）。対応コミット `a4edd8d`（host-ports/App.tsx 結線）。追加E2E: `e2e/coord-cluster.spec.ts`（4つの相異なるオフセンタ・クリックで非退化な面が確定＝中心へ collapse しない）+ `e2e/view-mode.spec.ts`（実クリックで面追加→commit）。
- **HB-8** [解決]: 「ツール」の設定・検索がグレーアウト。→ ToolsSettings/ToolsSearch にハンドラ登録（HB-4 同様）。対応コミット `d1bb17f`。追加E2E: `e2e/help-tools.spec.ts`（メニュー活性＋実クリック起動）。
- **HB-9** [解決]: 「ヘルプ」のバージョン・ショートカット・診断がグレーアウト。→ HelpAbout/HelpShortcuts/HelpDiagnostics ハンドラ登録。対応コミット `d1bb17f`。追加E2E: `e2e/help-tools.spec.ts`。
- **HB-10** [解決]: やり直しのデフォを **Ctrl+Y** に。→ `default-keymap.ts`/`menu.ts` に Ctrl+Y redo を追加（Ctrl+Shift+Z も併存）。対応コミット `ea78e6a`。追加E2E: `e2e/ux-cluster.spec.ts`（編集メニューが Ctrl+Y 表示・実 redo・別名 Ctrl+Shift+Z も redo）。
- **HB-11** [解決]: 時間バー下の数列=**年目盛ラベル**。→ 「単位:年」キャプション明示・ラベル付き目盛（`Timeline.tsx`）。対応コミット `ea78e6a`。追加E2E: `e2e/ux-cluster.spec.ts`（単位:年 + ラベル目盛）+ `timeline-readable` ビジュアル。
- **HB-12** [解決]: 「イベント追加」=**時刻ブックマーク**。→ 「時刻ブックマーク」見出し＋説明で明確化（`EventMarkers.tsx`、消さない）。対応コミット `ea78e6a`。追加E2E: `e2e/ux-cluster.spec.ts`（説明文の存在）。※永続要否は DECISIONS.md に確認事項として記録（下記）。
- **HB-13** [解決]: 時間バー操作ボタンに**ラベルが無く小さい**。→ `StepControls.tsx`/`PlaybackControls.tsx` に可視ラベル/aria-label/最小サイズ。対応コミット `ea78e6a`。追加E2E: `e2e/ux-cluster.spec.ts`（ラベル可視＋サイズ）+ `timeline-readable` ビジュアル。
- **HB-14** [解決]: **拡大すると地物が消える**（v1/2/3 でも再発した典型）。→ 連続スカラー経度の地物に対し描画の wrap turn を地物自身の経度スパン基準で列挙する `wrapTurnsForLonSpan` を新設し、view-clip(候補集合)と「保持⇒描画」を一致させた（`vtransform.ts`/`feature-layer.ts`/`canvas2d-renderer.ts`）。対応コミット `a4edd8d`。追加E2E: `e2e/zoom-cull.spec.ts`（ズームイン各段で可視地物数が不当に 0 にならない）+ プロパティ `feature-cull.property.test.ts`。**Codex 精査済み**。
- **HB-15** [部分解決/ライブ結線が残課題]: 編集モードで**あらゆる頂点が選択できない**。→ 同根の screen→world 写像（HB-7 と同一の箱補正済み `screenToWorld`）は修正済みで、ヒットテスト/選択ロジック自体は存在する（`edit-session-adapter.ts`/`live-lookup.ts`）。**ただし合成ルート `src/ui/App.tsx` の地図ポインタ・ディスパッチャは現状 `EMPTY_HIT_TESTER` / `NOOP_SELECTION_PORT`（`src/ui/map/ports.ts`）で結線されておらず、地図上の実クリックでの頂点/地物選択導線がライブ UI に通っていない**（選択は add/commit 経路の再解決のみ）。座標写像の正しさは `e2e/coord-cluster.spec.ts`（HB-7）と `vtransform.test.ts` でロック済み。「既知頂点を実クリック→選択」E2E はディスパッチャに実 HitTester/SelectionPort を結線するまで成立しないため**意図的に未記述（偽陽性ロック回避）**。残作業: App.tsx で `EMPTY_HIT_TESTER`/`NOOP_SELECTION_PORT` を実装に差し替え、編集モードのクリック選択を結線 → 上記 E2E を追加。

> 検証: 各修正に behavioral E2E（実 click/drag/wheel で結果アサート）＋必要に応じ toHaveScreenshot。デグレ厳禁（毎回フルスイート＋E2E緑）。commit はローカルのみ（push なし）。座標クラスタ(HB-6/7/14/15)は単一の screen↔world 真実源で直し、再発防止のプロパティ/メタモルフィックテスト（screen→world→screen=恒等等）も足した。
> finalize 時点の正直な残課題: **HB-15 のライブ・クリック選択導線が未結線**（root math は緑・UI 導線が NOOP ポートのまま）。
