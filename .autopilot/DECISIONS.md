# time-map-app-4 Autopilot — 決定と不明点リスト

> ユーザー就寝中の自律判断を記録。起床後のレビュー用。

## 確定した運用上の決定

- D1: Codex CLI 未導入かつ認証不可のため、クロスモデルレビューは今夜は不可。レビューは **Claude 複数エージェントの多視点収束**（correctness / 要件適合 / 統合 / build-health のレンズ）で代替。Codex導入後に差し替え可能。
- D2: 計画変更により、-4専用スレッドではなく**現セッション(!WORKSPACE)から-4を絶対パスで駆動**。
- D3: 設計完了後、**承認を待たず実装へ移行**（ユーザーによる事前承認）。
- D4: 並列書込み競合の回避と無人運転の堅牢性のため、ユニットは **依存順(波/逐次)で実装し、各ラウンドごとに git commit**。
- D5: 5時間制限への耐性 = 全成果物をディスク+git+workflowジャーナルに永続化し、**STATE.md/units.json駆動の状態機械**として再起動のたびに続きから再開。commitは**ローカルのみ(push禁止)**、新規リポジトリのため既定ブランチへ直接コミット。
- D6: 技術選定がゼロベースの結果 React18 + Zustand + 自前Canvas2D に着地（v3はSvelte5+XState）。要件からの正当化に基づく妥当な再選定として記録（クリーンルーム選定が機能した証左）。
- D7: 無人運転の安全規律として、検証は**非対話・GUI非起動**（typecheck/lint/test/build）で行う。Electronウィンドウの目視や dev サーバ起動の確認はブロック/ハングを避けるため後回し（後でPlaywright/人手）。
- D8: **U01で技術方針の全依存を一括インストール**し、後続ユニットの並列実行時の `npm install` 競合を避ける。
- D9: 各ユニットの完了ゲートは「実装 → 多視点レビュー(最大2巡の修正収束) → typecheck/lint/test 緑」。緑にできない検証(要ネットワーク/要GUI 等)は blocker として記録し、依存しないユニットを先に進める。

- D10: Workflowの `args` がこの環境で未配達と判明（空で到達）。対策として実装は**args非依存の自己駆動エンジン**化（エンジン内の Select エージェントが units.json+git から ready を判定）。

## pre-flight

- node v24.13.1 / npm 11.8.0 を確認。git 利用可、ローカル identity 設定済み(Claude Autopilot)。

## 要件の抜け漏れ・自律判断（起床後に確認してほしい）

- D11(2026-06-20): U04/U05/U12/U09 を done 判定。判断根拠 = buildUnit の acceptanceMet=true + 確定時点の静的ツリーでフルスイート連続2回緑(15 files/201 tests)。buildUnit の status は needs-attention だったが、その openFindings はいずれも「報告時点での未確定/フレーキー/epsilon band-aid」に関するプロセス指摘であり、確定ツリーでは(a)スクラッチ `_stress.test.ts` 消失 (b)フルスイート安定緑 を実測で確認したため、受け入れ基準充足 + 検証緑 のゲートを満たすと判断し done とした。要起床後レビュー: 兄弟エージェント(PID 9748)の並行編集痕跡と epsilon/seed override の再混入有無を git diff で点検すること。

## 未解決の不明点

- （随時追記）
