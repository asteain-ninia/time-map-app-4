# 落ちた要件 監査 — v1/v2/v3 → v4 (2026-07-02)

ユーザー指示「最優先は gimoza のクォリティ。過去プロジェクト参照を解禁。特に落ちた要件がないか気をつけて」に応える横断監査。**クリーンルーム封印(過去版に言及しない)を本監査に限り解除**して実施。

- 手法: workflow `wgnb7h9i7`（34エージェント / Extract→Merge→Verify）。過去4世代の要件/機能を構造化抽出→統合→v4実コードで敵対的検証（「落ちた=v4に不在」を証明主義で判定）。
- 棚卸し規模: v1=47 / v2=82 / v3-docs=102 / v3-app=118 / v4-req(FR)=119 / v4-impl=84 機能。
- 判定: 27候補 → **DROPPED/PARTIAL 11件（全て LOW severity）** / PRESENT・DESCOPED 16件。

## 総括（ユーザーの懸念への回答）

**中核の必須要件で v4 が「落とした」ものは無い。** SVGベースマップ/無限横スクロール/ズームパン/時間スライダー・錨モデル/点線面CRUD/穴・飛び地/共有頂点/ナイフ分割・結合・所属変更/四色自動配色/undo-redo/保存読込・自動バックアップ/検索/測量距離/ラベル描画/階層・表示制御/設定 等は v4-req・v4-impl 双方に相当物があり継承済み。v4 はクリーンルーム再実装として**忠実**。

落ちていたのは (a) v1 由来の軽量UI演出（常時表示エリア・トースト・クリック近傍フォーム等）と (b) v4 で設計転換により不要化された挙動（レイヤー独立形状・旧JSON互換）で、いずれも LOW。**ただし LOW 群の中に、放置すべきでない spec-vs-impl 欠陥が2件**埋もれていた（下記 A/B）。

## 要対応（spec-vs-impl 欠陥 — 実装候補）✅ レビューライン `wr00cr5e1` で両件 CONFIRMED(real-gap)

- **A. FR-87「既存地物への頂点追加（エッジハンドル）」** ＝ ✅ **実装完了 `6258ba6`**（新ドメイン不要でUI結線・多次元敵対レビュー3/4 SOUND・シーム中点崩れの既存バグも fix-forward 根治・258files 3067緑）。以下は当初の検出記録: **CONFIRMED real-gap / MEDIUM**。FR-87(must)はエッジハンドルでの新頂点追加を要求し FR-88(must)も線/面の頂点追加を要求。ドメインは実装済(`edit-ops.ts:136 addVertexToLine`/`:151 addVertexToLeafRing`、`EDIT_TOOL.EdgeAdd`)だが UI が起動できない: HIT_KIND に Edge が無く(`selection/contracts.ts:28-35`)、live-hit-test はエッジ中点近接を検査せず、`edit-session-adapter.ts:181-202` が Edge を null 返し(`:200`「EdgeAdd is unreachable」)。**エッジハンドルは描画されているのに掴んでも無反応＝見える死んだアフォーダンス**。代替UI経路も grep で皆無。severity=MEDIUM(データ欠損は無く delete+recreate 可だが MUST 未達+死アフォーダンス)。
  - 最小配線案(新ドメイン不要): (1)`contracts.ts` に HIT_KIND.Edge + HitResult{Edge; featureId; ringId?; startVertexId; endVertexId} + `edgeHit()`。(2)`live-hit-test.ts` の vertex パス後・body パス前でエッジ中点への screen 距離判定→`edgeHit()`。(3)`edit-session-adapter.ts` targetFromHit に Edge→EDIT_TOOL.EdgeAdd 枝(confirmRelease は既に EdgeAdd を処理)。(4)`active-feature-handles.ts:120` previewVertexStore に EdgeAdd 枝。
- **B. `vertexMarkerCap`（FR-110）がデッド設定** ＝ ✅ **実装完了 `15ff487`**（当初検出: CONFIRMED real-gap / LOW）。判明: ライブのアクティブ地物頂点表示は `active-feature-handles→buildEditHandlePrimitives` の handle 経路で、`classifyVisual`(FR-79マーカー分類器)は renderer 未結線だった。→ **ライブ handle 経路に cap を結線**(App.tsx から `appSettings.vertexMarkerCap` 供給)。
  - **cap セマンティクス決定**: **閾値方式(wholesale)** — アクティブ地物の頂点ハンドル数 > cap なら handle を一括省略(頂点/エッジ/ドラッグプレビュー輪郭とも)。**cap=0=非表示**、undefined=無制限。スライス(先頭N)ではない。根拠=FR-110「表示上限」＋既存コメント「0==show none」＋v3「上限超過時は常時マーカーを省略」。既定2000ゆえ通常地物は不変・巨大地物(>cap)のみ per-vertex ハンドル省略(perf ガード)＝地物全体の選択/移動は別経路で不変。classifyVisual の cap は FR-79 分類器として温存(将来 wiring 用・注記済)。設定撤去は FR-110 違反ゆえ非推奨。

## DROPPED / PARTIAL 11件（全 LOW）

| key | status | 内容 | 推奨 |
| --- | --- | --- | --- |
| world-info-name-overview | PARTIAL | v1の「地図上に世界名・概要を常時表示（未設定時『無名の世界』）」。名前・説明の**データ**は FR-109 で存在、失われたのは常時表示UIのみ | confirm-descope（任意でウィンドウタイトル/ステータスバーへ表示） |
| notifications-toast | PARTIAL | 成功/情報の一時トースト。v4はエラー専用通知（教訓5.12が自動消滅を否定） | confirm-descope（成功/情報種別を要件で明文化） |
| detail-window-view-mode | PARTIAL | 閲覧モードでマップ直接クリック→詳細。サイドバー一覧経由は成立 | confirm-descope（低優先でFR-99拡張可） |
| forms-near-click-position | DROPPED | クリック位置付近へフォーム/詳細を表示。v4は固定サイドバー+左上固定パネル | confirm-descope（低コストで復元可） |
| logging-leveled | PARTIAL | 5段階の関数トレースログ+ログレベル設定UI。3段階レベルログ(FR-117)は存在 | no-action |
| click-add-vertex-recovery | PARTIAL | 頂点不足図形へクリック頂点追加で復活。FR-88(不足即削除)で不要化。**→派生所見 A** | confirm-descope（本体）／A を別途 implement |
| keyboard-map-nav | PARTIAL | 矢印パン/+-ズーム/0全体表示。Ctrl+=/-ズーム+ドラッグパンは存在 | confirm-descope（「全体表示へ復帰」コマンドは低コスト有用） |
| vertex-marker-display-limit | PARTIAL | **→ B（vertexMarkerCap デッド設定）** | implement-consume or remove-setting |
| file-association-open | DROPPED | OSファイル関連付け起動読込。未パッケージ配布のため未対応 | confirm-descope（配布形態確定後／将来へ明記） |
| load-cancel-feedback | DROPPED | 読込キャンセル通知。v4は「中止は静かに現状維持」を意図設計(受入基準2/3) | confirm-descope |
| sidebar-collapse-tab-autoswitch | PARTIAL | サイドバー折りたたみ+選択時プロパティタブ自動切替 | confirm-descope（低優先UX） |

## PRESENT / DESCOPED 16件（確認済・対応不要）

- PRESENT（v4に相当物あり）: survey-mode / select-all-vertices(FR-79/80/81) / grid-snap(FR-78) / layer-visibility-focus-dimming(FR-113) / about-dialog / event-list-sidebar(FR-111) / conflict-resolution-guide-firsttime。
- DESCOPED（v4で意図的に非採用/再編）: hover-tooltip（クリック即時表示で代替）/ invalid-shape-mode-change-confirm（FR-88自動削除で代替）/ custom-calendar(将来 §7.1)/ event-marker-timeline(FR-66明記・D32・回帰ロック済)/ layer-slider-shape-reuse(FR-42深度ロールアップで等価)/ layer-draw-order-opacity(FR-34/113/102)/ json-legacy-save-load(§7.3)/ version-compat-convert(§7.3マイグレーション非提供)/ click-latlon-readout-status（クリック座標はFR-16で取得可・ステータス枠は未結線＝任意の小改善余地）。

## 次アクション（進捗）

1. ✅ **A（FR-87エッジ頂点追加）実装完了** `6258ba6`（+シーム中点の既存バグ fix-forward）。
2. ✅ **B（vertexMarkerCap）実装完了** `15ff487`（ライブ handle 経路へ結線・閾値方式・上記参照）。
3. ⬜ **confirm-descope 9件を要件定義書 §7 に「非目標」明記**（漏れと区別）＝残タスク。単発の低コスト改善（全体表示復帰コマンド/ステータス座標表示）は余力で。
4. ✅ 第5次バグハント確定12件・第6波確定3件・監査A/B、**全て重大度順に実装ライン(+レビュー/バグハントの3ライン)で根治済**（2026-07-02 セッション）。詳細コミットは DECISIONS D44。

> 単一真実源: 本ファイルが監査の窓口。DECISIONS.md **D43** に要約リンク。workflow 生出力は task `wgnb7h9i7`。
