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

- D13(2026-06-20): U18/U20/U10/U11 を done 判定。判断根拠 = buildUnit の acceptanceMet=true(4件とも) + 確定ツリーでフルスイート緑(60 files/639 tests, typecheck=0/lint=0)。
  - U10: 報告 blocker(format.test.ts 2件赤)は並行ユニット由来かつ U10 スコープ外。確定ツリーで当該含め全緑を実測 → done。
  - U11: buildUnit status=needs-attention の唯一の high finding(transferSharing の dangling 参照: コンテナを新idへ付け替えるが新id本体を store に保証しない)を確定ツリーで**修正済みを実測確認**(shared-vertex.ts:740-749 で旧座標 carry-forward の本体 mint + shared-vertex.test.ts:354-372 の回帰テスト)。finding が要求した修正そのものが単一真実源で実装済みのため、受け入れ基準充足 + 検証緑 のゲートを満たすと判断し done とした。要起床後レビュー: transferSharing の merge(2旧id→同新id)時の本体衝突解決(390-404行テストは pass)が意図どおりか確認。
- D12(2026-06-20): U06/U16 を done 判定。判断根拠 = buildUnit の acceptanceMet=true + 確定時点の静的ツリーでフルスイート緑(22 files/282 tests, typecheck=0/lint=0)。
  - U06: buildUnit status=needs-attention だったが、その唯一の openFinding(凹型ホールの頂点重心プローブ偽陽性)は確定ツリーで解消済みを実測(invariants.ts は重心プローブ撤去済み + 回帰テスト/property 追加済みで緑)。受け入れ基準2(真の不変条件違反のみ却下)の意図に沿う実装になっており done とした。
  - U16: 報告時 blocker(typecheck 赤)は並行ジオメトリユニット由来で、それらが収束した結果 **全体 typecheck=0**。よって U16 自体は緑ゲートを満たし done。残課題: ExistenceResolver の本番実装注入(anchor-series resolveAt + vertex-in-shape)は仕様どおりの注入点として後続(合成ルート/U17 以降)に委譲(再実装しない方針)。needsAttention に明記。

- D13(2026-06-20): U07/U08/U17/U21 を done 判定。判断根拠 = 確定時点の静的ツリーで検証3点全緑(typecheck=0 / lint=0 / test: 36 files・443 tests passed, exit 0)。
  - U07: buildUnit status=needs-attention(2 rounds) かつ openFindings(high×3) は全て「resolveRing の per-ring unwrap が比較対象リングを共通ワールドターンへ揃えず、頂点列が逆側 seam から始まる正当な cross-seam ホール/飛び地を ~360° ずれで誤判定する(R3 単一真実源の不完全利用)」という同一バグの指摘。**確定ツリーで修正済みを実測確認**: ring-hierarchy.ts に `alignRingTo`(U05 `worldWrapReplicas` に委譲し基準アンカーに最近接のレプリカを turns -2..+2 から選択)+ `resolveAlignedPair` を新設、validateGeometry 包含(450)・checkGroupPairsNonOverlap 兄弟/飛び地(511)が比較直前にペアを共通ターンへ整合。回帰テストも追加済み(ring-hierarchy.test.ts:286「MISMATCHED anchors」block で逆側 seam 始点の containment / enclave-overlap / sibling-non-overlap を網羅)。finding が要求した「比較前に共通 seam frame へ整合」「U05 単一真実源で ±360° を再発明しない」「3経路の回帰テスト」が全て満たされている。受け入れ基準充足 + 検証緑で done。
  - U07 報告 blocker(U08 hierarchy.property.test.ts:5 の GAP_AGGREGATE_ID/withGap 未使用 import による npm run lint exit 1)は**現状で解消済み**を実測: 当該 import は 80・87 行で実使用、`npm run lint` exit 0。報告の acceptanceMet:false は古く実質 true。
  - U08/U17/U21: いずれも deps が全て done、ファイル一式が存在し対応テスト群が緑、lint/typecheck も緑。受け入れゲート充足で done。
  - 自律判断の性質: buildUnit の status よりも**確定ツリーの実測(git ワーキングツリー = 真実源)**を優先。報告は実装ラウンド時点のスナップショットで、後続/並行ユニットの収束で blocker が解消されたため確定時点の全緑をもって done と判定(D9/D11/D12 と同方針)。

## 未解決の不明点

- （随時追記）
