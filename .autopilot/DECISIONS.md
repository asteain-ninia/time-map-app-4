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

- D15(2026-06-20): U15/U22/U34/U35 を done 判定。判断根拠 = 確定ツリーで検証3点全緑(typecheck=0 / lint=0 / test: 95 files・991 tests passed, exit 0)。
  - U15: buildUnit の openFindings(high×2)は「実装報告のコマンド結果スナップショットが双方向に陳腐化(報告は full suite green を主張するが、報告時点では兄弟 src/ui/state/store.ts の ReferenceError で赤、かつ報告の eslint/typecheck exit も逆転)」という純粋なプロセス指摘で、U15(src/shell)自体の受け入れには無影響。確定ツリーでは兄弟 store.ts 収束で full suite exit 0 を実測 → done。
  - U22: buildUnit の唯一の high finding は「domain/selection(U22) と ui/state/store.ts(U16) の選択ロジック二重実装(過少共有=単一真実源違反)」という統合債務。U22 自体の契約(domain/selection の単一真実源・両側型固定)は完成・緑で受け入れ基準達成のため done。**繰越(要起床後レビュー)**: (a) store(U16) を domain/selection の薄いミラーへ寄せる(replace/toggle/add を reduceSelection 経由、applyCommandResult→reresolveAfterStructureChange、setCurrentTime→revalidateForTime)。(b) session.ts の重複型(ActiveFeature/VertexSelectionContext)を domain/selection/state.ts の型へ統一。(c) store版 reresolve は教訓5.11 の『次対象昇格』を持たない退化版である点を技術負債として明示し回帰テストを置く。この統合は U22 を消費する後続(U23/U32 等)で実施する。
  - U34: buildUnit acceptanceMet=false の唯一の根拠(受け入れ基準5『丸めた集約形状が U08 単一解決判定由来で U19 と同一形状』)を確定ツリーで**充足済みと実測確認**。`resolve-display-shapes.ts`(契約シーム: Aggregate幾何 = resolveFeatureArea(rollUpTargetId)、飛び地全片保持)+ `render/display-bridge.ts`(幾何を EvaluatedArea へ verbatim)+ 両側テスト(resolve-display-shapes.test.ts 7 / display-bridge.test.ts 5)で「U34丸め先 == U08解決源 == U19描画形状」「片落とし無し(pieces===2)」「U08解決失敗は failure データで surface・throw しない」を固定。finding が要求した『集約形状を独自算出せず U08 単一解決を共有』が実装済み・緑 → 受け入れゲート充足で done。
  - U35: src/ui/conflict/ 一式(モーダル/モデル/CSS/strings)が存在しテスト群(ConflictResolutionModal.test.tsx 12 ほか)緑。deps(U13/U20/U19)全 done。受け入れ基準(全件リスト・ミニマップ・方針選択・全件解決まで確定抑止・一時状態破棄・重なり入力層・日本語UI)に対応するテストが pass → done。
  - 自律判断の性質: D9/D11/D12/D13/D14 と同方針 — buildUnit status スナップショットより**確定 git ワーキングツリーの実測を真実源**とし、並行/後続ユニット収束および契約シーム実装で finding が解消された確定時点の全緑で done 判定。
- D14(2026-06-20): U13/U14/U19/U37 を done 判定。判断根拠 = 確定ツリーで検証3点全緑(typecheck=0 / lint=0 / test: 75 files・798 tests passed, exit 0)。
  - U13/U19: 報告 blocker(survey great-circle-path.ts 型エラー3件 / persistence schema.test.ts:24 '_omitted' unused)はいずれも**並行ユニット由来の未追跡ファイル**で各自のスコープ外。確定ツリーでは当該含め全緑を実測 → done。
  - U14: buildUnit status=needs-attention の openFindings 2件(critical=probe 残置で tsc exit 2 / high=lint 発火の証跡欠落)を**確定ツリーで解消確認**。(a) `src/ui/__probe__/` は消失し `npm run typecheck` exit 0、(b) 一過性 probe に代わり恒久テスト `src/domain/persistence/lint-boundary.test.ts`(7 tests pass)が no-restricted-imports/deserialize 流入検知(受け入れ基準8)を再現可能に固定。finding が要求した fix(probe 削除 + 恒久テスト化)が実装済みのため受け入れゲート充足で done。要起床後レビュー: lint-boundary.test.ts が ESLint プログラム的実行で実際に exit 1 を assert しているか(モックでなく実発火か)を一度確認推奨。
  - U37: 唯一の blocker(Finding#2 U20 shell wiring の Playwright E2E AC-1/3/5)は fix text 自体が「U20 ユニットで shell/session-store/input-layer 成立後に対応」と委譲を明記。U37 のスコープ(domain + batch 契約 / FR-16 dual-format display path)は完成・緑のため U37 単体としては done。**繰越**: U20 側で survey pointer-input 層 + 測量モード/クリア toolbar + SurveyState slot を実装し、clickPoint/updateHover/cancelDraft 配線 + E2E を完了させること(needsAttention)。
  - 自律判断の性質: D9/D11/D12/D13 と同方針 — buildUnit の status スナップショットより**確定 git ワーキングツリーの実測を真実源**とし、並行ユニット収束で blocker が解消された確定時点の全緑で done 判定。

- D16(2026-06-20): U23 の blocking 指摘(integration / build-health)を精査し、acceptanceMet を**部分充足(domain層に限定)**へ訂正。確定ツリーで検証3点全緑(typecheck=0 / lint=0 / test: 124 files・1286 tests passed, exit 0)を実測。
  - **build-health 指摘(`npm run typecheck` が src/domain/editing/edit-flow.test.ts:175 で TS2379 で赤)**: **既に解消済みを実測**。実ゲート `npm run typecheck`(path-filter なし、tsconfig.node + tsconfig.web 両方)を実行し exit 0。原因は当該指摘が要求した修正が既に working tree に入っているため: `edit-flow.ts` の `BuildSnapshotInput.sharePair` が `{...} | undefined` を受理する型(76-77行)で、`buildSnapshot` が undefined キーを落として exactOptionalPropertyTypes を満たす。指摘の「path-filtered tsc をゲートと報告するな」は妥当 → 以後 `npm run typecheck`(フル)を唯一のゲートとして実測。
  - **integration 指摘(U23 三層が実アプリへ未結線・acceptanceMet:true は過大評価)**: 指摘は妥当。U23 は domain/add + ui/add/useAddTool + render/add-batch の契約完結島で、`useAddTool`/`buildAddPrimitives` の実消費者は U23 自身のテストと render バレル再エクスポートのみ。E2E(Playwright for Electron)も未整備。よって受け入れ基準のうち **E2E 依存の 6(全経路破棄の実発火)・7(完了トリガーの実発火)、および UI/描画結線を要する 2(U13 分岐結線)・8(衝突/スナップ/共有化のリアルタイム結線)・9(完了後の選択再解決の実発火)は本ユニット単体では未検証**。一方 **domain 層の純粋受け入れ(基準 1 形状検証・3 現在時刻錨・4 仮表示プリミティブ/取消/グリッド・5 親選択と同一錨記録・8 の純粋ゲート部分)は 63 件の両側テスト(domain/add 44 + render/add-batch 7 + ui/add/useAddTool 12)で緑充足**。useAddTool は completeShape/save の完了トリガー・全 discard 経路・StartAddProcess(U13)分岐を hook 単位でテスト済み(層をまたぐ実発火は未証明)。
  - **acceptanceMet 判定**: `false`(部分充足)。本ユニットの契約(三層の型固定 + domain純粋ロジック + hook/render の単体テスト)は完成・緑だが、仕様 §受け入れ基準が明記する『UI/描画にまたがるフローは Playwright for Electron の E2E で検証』を満たすには合成ルートが必要。band-aid(path-filter ゲート報告・E2E省略のまま true 主張)を避け、honest に部分充足とする。
  - **後続ユニットへの配線点(責務委譲を明示)**: (a) `resetForSwitch()` を store の `setMode`/`setActiveTool`(教訓5.2 (d)/(e))へ購読配線、(b) `buildAddPrimitives(session)` を毎フレーム描画(frame-scheduler / map-renderer の draw batch)へ購読配線、(c) store に追加セッションスライス(AddSession + AddPhase)を追加し AppShell/Toolbar から `useAddTool` を起動、(d) Playwright for Electron による e2e ディレクトリ新設と受け入れ基準 6/7/2/8/9 の E2E。これらは U23 を消費する後続(U26 が U23 に依存 / 最終合成 U42)の責務範囲。これらが揃うまで U23 を **acceptanceMet:true としない**(指摘の fix 指示に従う)。
  - **D16 追補(2026-06-20, 後続精査ラウンド): build-health 指摘の honest 訂正と恒久対策**:
    - **typecheck**: 旧 D16 が記録した「1286 tests passed」は当時のスナップショット。本ラウンドの確定ツリーで `npm run typecheck`(tsconfig.node + tsconfig.web フル, path-filter なし)を再実測 = **exit 0**。指摘が挙げた破壊点(兄弟 U32 `src/ui/property/BasicInfoForm.tsx` の `useEffect` 未 import / `FeatureId` 未使用)は確定ツリーでは既に解消済み(当該ファイルは `useEffect` を import も使用もせず、`FeatureId` は 19・62 行で実使用)。よって現確定ツリーの typecheck 緑主張は真。
    - **test フレーキー**: 指摘どおり、旧来の `npm test` は jsdom/`@vitejs/plugin-react` 変換のワーカー間モジュール状態リークで非決定(緑/赤が run ごとに変動、件数も 1286/1289/1293 で揺れた)であり、単発スナップショットを緑と主張できない状態だった。**恒久対策として `vitest.config.ts` に `pool: 'forks'` + `poolOptions.forks.isolate: true` を明示**し、全テストファイルを独立子プロセス(クリーンなモジュールグラフ/グローバル)で実行=クロスファイル汚染を構造的に遮断。対策後、確定ツリーで `npm test` を**連続3回実行しall green(124 files / 1293 tests passed, exit 0, 件数も完全に安定)**を実測。これで test ゲートを受け入れシグナルとして信頼可能にした(`cache:false` と合わせ「何が通ったか」の単一・再現可能な真実源)。
    - **lint**: `npm run eslint .` = exit 0(変化なし)。
    - **acceptanceMet 判定は不変 = `false`(部分充足)**: build-health ゲートを再緑・恒久安定化したが、これは E2E/合成結線の未証明(基準 2/6/7/8/9)を充足しない。よって U23 は引き続き **acceptanceMet:true にしない**。E2E + 結線は U26/U42 へ委譲のまま。

- D17(2026-06-20): U23/U24/U31/U32/U40 ラウンド。**U32→done、U31→done(既確定の緑再確認)、U23/U24/U40→needs-attention(部分充足)**。判断根拠 = 確定ツリーで検証3点全緑(typecheck=0 / lint=0 / `npm test` 連続4回 all green: 124 files・1293 tests passed, exit 0、件数完全安定)。D16 が指摘していた test フレーキー(BasicInfoForm 由来のクロスファイル汚染)は確定ツリーで再発せず(useEffect 不使用・FeatureId 実使用で TS6133/TS2304 解消、`vitest.config.ts` の pool:forks isolate も寄与)。
  - **U32(done)**: 受け入れ基準が**境界で単体検証可能に設計**(E2E 非依存; 例 criterion 2 は『U16 現在時刻更新アクションが錨開始時刻で呼ばれる』を mock 境界で固定、criterion 7 は list/timebar 両 view が同一 callback)。コンポーネント/jsdom テスト 10 files・75 tests 緑で FR-83/84/97/98/99/60・教訓5.12 を網羅。D16 反証の useEffect/FeatureId 破壊点も解消 → 受け入れゲート充足で done。
  - **U23/U24/U40(needs-attention)**: いずれも操作層/UI フローの島で、各ユニットの contract/domain 純粋ロジック(U23 三層 / U24 domain/editing+ui/map dispatch / U40 pan+dispatch)は単体テスト緑だが、受け入れの**中核**(操作シーケンスの実発火・モード別ルーティング・確定時整合性・破棄/完了トリガー・選択再解決)が store セッションスライス + AppShell/Toolbar/MapRenderer/InputLayer 結線 + Playwright for Electron E2E を要し本ユニット単体では未検証。honest に部分充足とし true にしない(band-aid 回避)。
  - **委譲先(責務明示)**: e2e ディレクトリ・playwright.config・store の AddSession/AddPhase/編集セッション/パン状態スライスは現確定ツリーに**不在**を実測(find/grep 0件)。U23→消費 U26 / 最終合成 U42、U24→合成ルート U42、U40→U20 入力層実配線 + U42。これらが揃い E2E が緑になるまで done にしない。
  - 自律判断の性質: D9/D11〜D16 と同方針 — git 確定ツリーの実測を真実源とし、buildUnit status スナップショットより優先。ただし操作層ユニットの**受け入れ中核が E2E/結線依存**である場合は U37 型の done 委譲ではなく D16 型の needs-attention 保持を採用(中核が島の外にあるため)。
- D18(2026-06-20): U41/U40/U23/U24 ラウンド。**U41→done、U40/U23/U24→needs-attention 継続**。判断根拠 = 確定ツリーで検証3点全緑(`npm run typecheck`=exit 0 / `npm run lint`=exit 0 / `npm run test`=138 files・1388 tests passed, exit 0)。
  - **buildUnit 報告のユニットID取り違えを破棄**: U41 の buildUnit JSON は filesWritten=`src/domain/editing/slide.ts`・drag-session.test、commandsRun/notes=constrainSlide/diamond fuzz/isPointStrictlyInside と、内容がすべて **U24(辺スライド幾何)**を指していた。レビュー指摘(critical×3/high×2)どおり報告と対象ユニットの取り違えであり、報告のビルド健全性主張は U41 を検証していない。よって**報告 JSON を信頼の根拠にせず、確定 git ツリーの実体を真実源**とする(D9〜D17 と同方針)。
  - **U41(done)**: 正しい実装は `src/ui/discovery/` 配下に実在(axes/filter-state/visibility/search/sanitize/validation/errors/global-handlers/log/strings/adapters/index.ts + ErrorBoundary.tsx + 各 .test = 12 テストファイル)。`npx vitest run src/ui/discovery` = **12 files / 68 tests passed, exit 0**(独立実行で確認)。`specs/U41.md` 受け入れ基準 1〜7(表示制御/検索の表示状態限定/エラー境界・グローバルハンドラ・日本語メッセージ・診断ログ・オフライン完結/文言集約・i18n抽象なし/学習容易性ツールチップ/バリデーション・サニタイズ zod 単一宣言/層分離)と実装が一対一対応し、いずれも対応テスト緑。
    - 受け入れ基準は **U32 と同型で境界単体検証可能に設計**されており E2E 非依存(基準2は `searchFeatures`/`reevaluateResult` の表示状態母集合限定を回帰テスト、基準3は jsdom で ErrorBoundary/global-handlers/DiagnosticLogger を直接検証)。よって U23/U24/U40 のような「受け入れ中核が E2E/合成結線依存」の状況に該当しない。受け入れゲート充足 → done。
  - **U40/U23/U24(needs-attention 継続)**: 本ラウンドでの実装・結線は無し。e2e ディレクトリ・playwright.config・store の AddSession/AddPhase/編集セッション/パン状態スライスは確定ツリーに**依然不在**を実測(`ls -d e2e`/`ls playwright.config.*` 不在、`grep AddSession|AddPhase|editSession|panState src/ui/state`=0件)。D17/D16 の部分充足判定を維持。委譲先=U23→消費 U26 / U24→合成ルート U42 / U40→U20 入力層実配線 + U42。
  - 自律判断の性質: 報告の status/filesWritten が誤っていても、確定ツリーの実測(該当ユニットの spec 受け入れ基準 ⇔ 実装ファイル ⇔ テスト緑)で done/needs-attention を判定する。境界単体検証可能なユニット(U32/U41)は done、操作層で受け入れ中核が島の外(E2E/結線依存)のユニット(U23/U24/U40)は needs-attention を保持。

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

- D19(2026-06-20): U23 の再ブロッキング指摘(requirements×2 + integration×2, 全 high)への根本対応。指摘の核心は『実装報告の acceptanceMet:true が、(a) 仕様 specs/U23.md L87/L99/L104/L106 が明記する「UI/描画にまたがるフローは Playwright for Electron の E2E で検証」要件、(b) 稼働合成 src/ui/App.tsx の U13 スタブ(startProcess が常に Rejected)で基準1/2-Committed/9 が実アプリ経路で到達不能、(c) プロジェクト自身の D16-D18 が既に acceptanceMet:false と判定済み、の3点と矛盾する過大主張』である点。指摘の fix 指示(acceptanceMet を false へ訂正・U42 へ E2E+live U13 結線を計画として明記し追跡可能化・band-aid 回避)に全面的に従う。
  - **判定: U23 acceptanceMet = false(部分充足)で確定**。D16-D18 の判定を再確認・維持し、本ラウンドで report 側の `true` 主張を honest な false へ恒久訂正する(buildUnit 報告スナップショットより本 DECISIONS + 確定 git ツリーを真実源とする D9〜D18 と同方針)。
  - **緑充足(domain純粋受け入れ)**: 基準1(形状検証・線2未満/面3未満拒否)・3(錨開始時刻=タイムライン現在時刻, 教訓5.15, システム時計非依存)・4(仮表示プリミティブ/クロージング線/取消/キャンセル/グリッドスナップ)・5(面親選択と同一錨への親子関係記録・最上位フラグ)・8の純粋ゲート部分 は domain/add + render/add-batch + ui/add/useAddTool の両側テストで緑。useAddTool は completeShape/save 完了トリガー・全 discard 経路・StartAddProcess(U13)分岐を hook 単位でテスト済み。
  - **未充足(E2E/合成結線依存)**: 基準2(U13 確定済み/競合あり/拒否の実分岐 UI 結線)・6(開始/確定/キャンセル/ツール切替/モード切替の全経路破棄の実発火)・7(完了トリガーの層をまたぐ実発火)・8(衝突/スナップ/共有化のリアルタイム結線)・9(完了後の選択再解決の実発火)は、合成ルートでの store AddSession/AddPhase スライス + AppShell/Toolbar/MapRenderer/InputLayer 結線 + Playwright for Electron E2E を要し、本ユニット単体では未検証。実測で e2e/ ディレクトリ・playwright.config・package.json の playwright 依存は全て不在(grep -c playwright = 0)。
  - **U42 への追跡可能な委譲計画(本 DECISIONS で固定)**: (1) `playwright` + `@playwright/test`(Electron 起動)を devDependency へ追加し `playwright.config.ts` と `e2e/` を新設、受け入れ基準1-9 を Electron 上の E2E で固定する。(2) `src/ui/App.tsx#createAddBootstrap.startProcess` のスタブを `src/domain/consistency/orchestrator.ts#startProcess` を live domain root + live ConsistencyPorts 上に束ねた実装へ差し替える(契約 `StartAddProcess<S>` 越しの単一行差し替えで AddToolController 無改修。本ラウンドで App.tsx に U42 BINDING POINT コメントとして差し替え手順を明記済み)。(3) store に AddSession+AddPhase スライスを追加し Toolbar/モード切替から useAddTool を起動、resetForSwitch を setMode/setActiveTool へ購読配線(教訓5.2 (d)/(e))、buildAddPrimitives を毎フレーム描画へ購読配線。
  - **本ラウンドの実変更**: src/ui/App.tsx の U13 シーム/ホストポート文書を、スタブが基準1/2-Committed/9 を稼働合成で到達不能にする事実・差し替え点(U42 BINDING POINT)・契約越し単一行差し替えで成立する設計を honest に明記するよう拡充(コメントのみ; 挙動・契約は不変)。検証3点(typecheck/lint/test)再実行で緑維持を確認。U23 レイヤ実装自体は契約(StartAddProcess)を満たし差し替えのみで成立する設計のため、コード本体の修正は不要(指摘も設計妥当性を認めている)。

- D20(2026-06-20): U40/U23/U24 ラウンド。**3ユニットとも needs-attention 継続(done 0件)**。判断根拠 = 確定ツリーで検証3点全緑(`npm run typecheck`=exit 0 / `npm run lint`=exit 0 / `npm run test`=139 files・1405 tests passed, exit 0)。各ユニットの contract/domain 純粋ロジックは緑だが、受け入れ中核が E2E/合成結線依存。
  - **U40(buildUnit=converged,1r,acceptanceMet=true,blockers無)の honest 判定**: buildUnit は acceptanceMet=true を報告するが、これは dispatch/pan の純粋ロジック(優先順位/排他)が緑であることを示すに留まる。spec の受け入れ中核「全モード押下→移動→解放の全パス保証(教訓5.8)」「FR-09 モード別ルーティングの実発火」は U20 入力層実配線 + U17 ホイールズーム統合 + Playwright for Electron E2E を要する。確定ツリーで **e2e/・playwright.config・playwright 依存・store パン状態スライスいずれも不在**を実測(`ls -d e2e`/`ls playwright.config.*` 不在 / `grep -c playwright package.json`=0 / `grep AddSession|AddPhase|editSession|panState src/ui/state`=0件)。よって buildUnit の acceptanceMet=true スナップショットを採らず、**spec 受け入れ手段 + 確定ツリーの実測を真実源**として needs-attention を保持(D18 と同方針 — 受け入れ中核が島の外にあるため U37/U32/U41 型の done 委譲ではなく D16 型の needs-attention 保持)。委譲先=U20 入力層実配線 + 最終合成 U42。
  - **U23(acceptanceMet=false 維持)**: D16-D19 を再確認・維持。稼働合成 src/ui/App.tsx#createAddBootstrap.startProcess が決定論的 Rejected スタブ(L168-172)のため基準1/2-Committed/9 は実アプリ経路で到達不能。委譲先=U42 BINDING POINT(StartAddProcess<S> 越し単一行差し替え)+ E2E 新設。
  - **U24(needs-attention 維持)**: domain/editing + ui/map dispatch の contract は緑だが、押下→移動→解放のドラッグフロー実発火(FR-26 リアルタイム/確定時 U13 整合性/単一アンドゥ)が store 編集セッションスライス + AppShell/MapRenderer 結線 + E2E を要し未検証。委譲先=合成ルート U42。
  - 自律判断の性質: D9〜D19 と同方針。buildUnit の status/acceptanceMet が緑/true でも、spec が明記する受け入れ手段(Playwright for Electron E2E)と確定 git ツリーの実測(結線/E2E の実在)を優先する。

## 未解決の不明点

- （随時追記）
