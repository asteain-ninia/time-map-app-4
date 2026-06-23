# HUMAN-BUGS-3 仕様/設計の判断（自走中の決定・ユーザー委任 2026-06-22）

> **単一真実源の一部 (D36 衛生スイープ)**: 本ファイルは [`DECISIONS.md`](./DECISIONS.md) の **HB3 フェーズ拡張**。識別子は `HB3-*`（D 番号と非衝突）。正準 D 番号レジストリは DECISIONS.md。**これ以上の分岐ファイルを作らない** — HB3 以外の運用決定は DECISIONS.md へ「最大番号 + 1」で追記する。

ユーザー離席中。診断 `HUMAN-BUGS-3-DIAGNOSIS.md` の16設問に既定を決定し実装。`[確定]`=低リスク即実装、`[暫定・要確認]`=戻ったら最終確認（変更時の手戻り小）。

| ID | 判断 | 区分 |
|----|------|------|
| HB3-1 | 中心経度は相対ジョグ維持（U18 ズーム依存shiftの利点を保つ）＋**現在の中心経度を数値で常時表示**＋相対と分かるラベル。 | 暫定・要確認 |
| HB3-2 | 「太平洋」=180°プリセット（正常）。ラベルを**「太平洋中心(経度180°)」**へ明示。位置症状は HB3-1 で対応。 | 確定 |
| HB3-3 | 指定粒度のみ表示を維持（U21「未指定=値なし」規約）。年のみ時は**「YYYY年」と明示**、月日は捏造しない。 | 確定 |
| HB3-5/19 | **【ユーザー訂正＝確定】**「ちょうど2片」は誤り。正しくは **境界を2k回横断する1本の分断線→k+1片**（4回横断＝3片が直感的）。余計な小片(90°アーティファクト)を出さず、内部で止まる線は不正分断しない。現 `openLineToClip` の半平面押し出し方式は2-way固定なので**n-way分割への再設計が必要**＝proposal/スナップショット/U13適用/継承UI/FR-93/95/テスト全体に波及する大物。ユーザー指示により**「広く先に＋ナイフは後で本格対応」**＝専用ユニットとして後回し。 | 確定(訂正) |
| HB3-7/22 | 確定ボタンは**4ツール共通で地図セル下部中央**。共通クラス `.tool-controls` に統一。 | 確定 |
| HB3-8 | **【ユーザー確定＝変更】別ツールで排他**: 頂点編集モードでは本体ドラッグで地物全体が動かない（ハンドル経由の頂点移動のみ）。地物移動は別ツール/モードとして分離（移動ツールが無ければ最小実装で追加、または既存の移動導線を頂点編集と排他化）。⚠️ワークフロー内インライン指示（旧=共存）より**本決定を優先**。 | 確定(変更) |
| HB3-10 | 競合解決後、調整後境界を優先地物の既存頂点へ**共有頂点化(溶接)**する＝新規要件として実装（FR-95継続規則を解決へ拡張）。ユーザーが共有頂点の発生を期待と明示。 | 暫定・要確認 |
| HB3-11 | 詳細パネルは**全属性 dl＋文書本体は当面空(正直スタブ)**で機能成立。文書本体の保存は別タスク。 | 確定 |
| HB3-12 | 存在期間の**単一真実源=歴史の錨列(FR-54/58)**。属性の開始/終了年(FR-97)は錨列からの導出・表示専用へ。 | 暫定・要確認 |
| HB3-13 | 新規地物の既定 **fillOpacity=0.7**（全地物一律）。設定変更は後日。 | 確定 |
| HB3-15 | (a)集約表示中でも個別リーフをピック可。(b)兄弟A,Bは親子不可→所属変更は別の上位領域へ移す操作。後から選択が消えるのはhit-test同一親解決バグ＝修正。(c)ターゲットは**ツール専用ハイライト色**。 | 確定 |
| HB3-16 | 結合/所属変更中は集約内の**個別リーフ子を直接ピック可(leafAtPoint)**。 | 確定 |
| HB3-21 | 点用確定ラベル=**「点を確定」**。 | 確定 |
| HB3-23 | グリッド間隔を**0.1°まで対応**(1°/0.5°/0.1°追加)。小数ラベル・経線上限・性能対応込み。FR-13改訂。 | 暫定・要確認 |
| HB3-24 | Electron既定メニューは **autoHideMenuBar:true**(Alt一時表示)＋本番最小化。ネイティブ ショートカット完全消失を避ける中間策。 | 暫定 |
| HB3-25 | 年操作バーは **nowrap一行**、caption は横並び/縮小。 | 確定 |
| HB3-28 | 各一覧に説明キャプション追加。**「イベント一覧」→「歴史アンカー一覧（年表）」**へ改称。 | 確定 |

実装順は診断の Phase A(コア)→B(ツール)→C(属性)→D(UX)＋spec大物(HB3-10/12/20)。各 HB3 = behavioral E2E 1本以上で回帰ロック。実形状フィクスチャ（国の輪郭）を使用。

---

## 引き継ぎセッション進捗（2026-06-22, 別Claudeが継続・完全自律）

前セッションが生成不具合で中断。後続セッションが `../../`(!WORKSPACE) のログを精読して引き継ぎ。ユーザー指示=「AskUser禁止・自己判断で じゃんじゃん自走」。攻略順は**「広く先に＋ナイフ(HB3-5/19 n-way)は後で本格対応」**（ユーザー選択）。

**コミット済（全ゲート緑・デグレ無し / vitest 249 files・~2916 tests）**
- HB3-20 `ebf0c10`: slide/snap ライトパス結線（前セッション未コミット作業を確定）。
- HB3-21 `fbf575a`: 点追加の確定ボタン「点を確定」（line/face/point 分岐）＋回帰。
- HB3-1/2 `2caf96c`: 経度プリセット明示「太平洋中心（経度180°）」等＋シフトが相対である可視ヒント（HB3-1 暫定）。
- HB3-28 `0986c74`: 「イベント一覧」→「歴史アンカー一覧（年表）」＋各一覧キャプション。
- HB3-3 `4851c91`: タイムライン年のみ表示維持＋未指定 tooltip（granularityNote）＋回帰。
- HB3-6/18 `ca96655`: ナイフ対象選択を `setActiveFeature` へ結線（強調＋選択色）＋回帰。
- HB3-17 `9281abe`: 分割確定後にツール解除（選択保持）でデシンク解消。
- HB3-26 `61efb29`: 面ラベルを可読色＋ハロー描画（LabelPrimitive.halo? 追加）＋回帰。
- HB3-7/22/25 `a65018e`: 確定ボタン下部中央統一＋年操作バー一行（CSS）。
- HB3-11 `2289489`: 地物詳細パネルを結線（既存 DetailPanels をマウント、文書本体は空スタブ）。
- HB3-8 `3e58136`: 頂点編集↔地物移動を排他化（featureMoveAllowed を 地物移動ツール時のみ）。
- HB3-24 `60ffaa8`: Electron ネイティブメニューバーを autoHideMenuBar で既定非表示（Alt表示）。

**= ここまでで HB3 28件中 14件 処理（HB3-20/21/1/2/28/3/6/18/17/26/7/22/25/11/8/24）。**

**残り（調査済・継続用メモ）**
- **HB3-14 属性編集**: 適用機構は既存（`createLiveEditBinding`＝App の `editBinding` ／ `applyEditProposal`／consistency）。要実装＝`buildSidebarContent` に `editDispatch` を渡す。dispatch は PropertyEditIntent から「新 attributes/color を持つ FeatureSnapshot の EditProposal」を作り `editBinding.startProcess`→`recordCommit`。FeatureSnapshot 組立は `src/ui/map/edit-session-snapshot.ts` の buildEditSnapshot を参考に属性のみ版を作る。現状は throwing stub `editNotWired`（SidebarContent.tsx:100）。
- **HB3-15/16 リーフピック**: `live-hit-test.ts:418` + `depth-focus.ts:100` が兄弟を同一親へ解決。`leafAtPoint`（集約中でも個別リーフを拾う）を追加し、結合/所属変更/集約時のピックに使う。HB3-15(b) 後から選択が消えるのは hit-test 同一親解決バグ＝修正。ツール専用ハイライト色も。
- **HB3-8 排他**: `edit-session-adapter.ts:170-178`×`App.tsx`（body hit→featureMoveAllowed=true）。**ユーザー確定=別ツールで排他**（頂点編集中は本体ドラッグで地物全体を動かさない／移動は別ツール）。
- **HB3-24 electron**: main の `autoHideMenuBar:true`（Alt表示）。`src/main/`（or electron entry）。
- **HB3-23 グリッド0.1°**: GridSettingsPanel に 1°/0.5°/0.1° 追加＋小数ラベル＋経線上限＋性能。FR-13改訂。
- **HB3-13 既定透過0.7**: `activeColor`(feature-layer)は opacity 非適用＝feature 塗りは現状不透明。data-model 透過の配管（ColorInfo.fillOpacity→FeatureStyle→withOpacity 適用）＋新規既定0.7＋**視覚ベースライン再生成**が必要。要注意（DEFAULT_OPACITY を変えると load 既定/テストに波及）。
- **E2E スイープ**: 各 HB3 に behavioral E2E（実ドラッグ/クリックで結果アサート）＋テキストアサート E2E の追従（タブ改称・ボタン文言）＋**視覚回帰ベースライン再生成**（HB3-26 ハロー/HB3-7/22/25 配置で screenshot が変わる）。`npm run test:e2e`。
- **大物（専用ユニット）**: HB3-5/19 ナイフ n-way（k+1片）／HB3-10 共有頂点溶接／HB3-12 存在期間の単一真実源。

---

## 後継セッション進捗（2026-06-23, 新Claude・完全自律 / トークンループ病治療後）

前任ログは犠牲subagent経由で要約参照（病原体は隔離済・本体未摂取）。ユーザー指示=「AskUser禁止・じゃんじゃん自走・いっぱいバグ直して未実装機能を実装」。

- **ベースライン**: HEAD `dd09bf9` は緑。未追跡WIP `e2e/human-bugs-3.spec.ts`(未使用helper)のみ赤→除去しコミット `1052f5f`。vitest 250 files / 2931 tests / typecheck=0 / lint=0。
- **[最重要] 編集モードのクリック選択回帰を根治** (commit `8d1ce75`)。前任が病に倒れる直前まで二分探索していた未解決バグ。診断手順: edit-select/edit-handles が retries=0 で 3/3 決定的失敗 → 一時HITDIAG計測で「本体中心クリックが hit-test に届かない」を観測 → `document.elementFromPoint` で**HB3-1 経度シフトパネル(`.longitude-shift`, ~526×174)が地図下半分を覆い `.map-area__overlay > *{pointer-events:auto}` でクリックを横取り**と特定。修正=パネルを `pointer-events:none`(コントロールのみauto)+`max-width:240px`。回帰E2E追加。**教訓: HB3-1のような"情報を足すUI"が容易にオーバーレイ肥大→背面操作奪取を起こす。新規オーバーレイは必ず pointer-events:none+コントロールのみauto。**
  - 副次: この修正は add/knife 等**全モードで**地図クリックの横取りを解消する(パネルは全モードで map-overlay に存在)。
- 次の着手: HB3-13(新規地物の既定塗り透過0.7・確定)→ HB3-23(グリッド0.1°)→ 大物。

### 本セッション後半の決定（2026-06-23 続き）

- **HB3-13 完了** (`0a42894`): 新規地物の既定 fillOpacity=0.7（`DEFAULT_NEW_FEATURE_FILL_OPACITY`、デシリアライズ既定 DEFAULT_OPACITY=1 とは別概念）。透過は `committed-features.styleOf` で `withOpacity` 適用（不透明は hex 維持で rgba チャーン回避）。選択時は不透明（選択地物が際立つ）。
- **HB3-23 完了** (`26a8b71`): グリッド `[0.1,0.5,1,5,10,15,30]`。ラベル小数対応。経線上限1000は据置（0.1°広域ズームアウトは「グリッドなし」へ degrade＝経線ストーム回避。微細グリッドはズームイン前提で実用域は十分）。エラーメッセージは定数から動的生成。
- **HB3-14 完了（2コミット）**: `a77f19b`=保存→永続化の behavioral E2E ロック。`8e31639`=**錨自動選択フォールバック**。editDispatch 結線(`3869c09`)後も「属性編集の保存が必ず失敗」が残っていた真因＝PropertyPanel の `selectedAnchorId` 初期 null・手動クリックのみで、地物選択→即名前変更→保存が「錨が選択されていません」で失敗。修正=編集対象錨を「明示選択 ?? 現在時刻に有効な錨(`resolveAt` §5.8)」へフォールバック。これで手動の錨選択なしに属性編集が通る。明示選択は優先・錨無し時刻は従来どおり対象なし。**[決定・低リスク]** 既存 PropertyPanel.test 16 緑（全テストが明示クリックするためフォールバックは上書きされ非干渉）。
- **HB3-5/19 ナイフ n-way は本セッション延期 [決定・根拠]**: probe で現行2-wayの4回横断挙動を確認＝`sideA=1多角形 / sideB=2多角形`（飛び地を束ねた1地物を返す＝**有効だが束ねられた**、無効/クラッシュではない）。よって「正直 reject」は動く機能を奪うため不当。フル n-way（独立k+1片化）が真の修正だが split-geometry/proposal/apply/session/UI/型に跨る大物・高リスクで、監視なし夜間の完遂に不適（プラン自体も専用ユニット・ユーザーも「後で本格対応」）。次セッションの最優先・専用作業として申し送り（プランは `HB3-5-19-NWAY-PLAN.md` で確定済）。
- **未解決の編集回帰を根治 [最重要成果]** (`8d1ce75`): 前任が病に倒れる直前まで二分探索していた「編集モードで地物本体クリックで選択できない」回帰。`elementFromPoint` 計測で HB3-1 経度シフトパネルが地図を覆いクリックを横取りと特定・修正。詳細は上記§とコミット。

### HB3-5/19 ナイフ n-way 分割 — 着手・ドメイン層完了 (2026-06-24, 新セッション)

前セッションで「延期・申し送り」とした大物に着手し、ドメイン層を完遂。

- **幾何コア** (`collectOpenPieces`/`splitIntoChords`, split-geometry.ts): 開線を内部チョード(境界→面内→境界)へ分解、各チョードに既存2-way機構(`openLineToClip`+U06 intersection/difference)を1本ずつ適用 = **2k横断→k+1片**。dangling頭尾は自然脱落、自己交差は `SelfIntersectingCut` で正直reject。probe(`__nway-probe.test.ts`)で 2/3/4片・面積保存を確認。
- **純粋に加法的スコープ**: OPEN・単一ポリゴン単一リング面・**≥2チョード**時のみ n-way。≤2片/CLOSED/穴/飛び地は既存2-wayを**bit-for-bit維持**(全既存テスト・FR-95シーム節点保存)。前セッションが恐れた「動く機能を奪う」懸念は加法スコープで回避。
- **検証 Workflow**(Sonnet/Explore 多エージェント, Codex代替): シーム=checkSplittableのアンカー後値を渡す/穴・飛び地=2-wayフォールバックで延期(将来課題)/自己交差・凹面・境界沿い=correct。最重要リスク(凹面1チョードが片側を2連結成分へ分断)は「単一連結面のみ成分分割」を試みたがコム過剰分割で撤回・文書化済み限界へ。
- **移行(加法的エイリアス方式)**: `SplitResult.pieces[]`+`smallestPieceIndex`(FR-93一般化)、`InheritanceChoice.inheritIndex`+`createInheritanceChoiceAt`、`SplitEditProposal/SplitSnapshot.newFeatures[]`、`applySplitProposal` が k 新地物を1アンドゥ単位でループ確定(FR-94一般化)。`sideA/sideB`/`newFeature`/`smallerSide` はエイリアス保持で churn 最小。
- **ドメイン commit `8cc828c`**: 全 vitest **2944 passed** / typecheck=0 / lint=0。bughunt property(W/diagonal/seam の3 applySplit変種)を面積=全片合計・apply=全新地物へ修正。
- **進行中(背景委譲)**: (A) UI移行 subagent = InheritorModal/session/useKnifeTool/Controller を n片チューザへ + **実機スクショ behavioral E2E**(コム/Wカット→k+1片観測)+ ゲート→緑なら自己コミット。(B) Sonnet 多ペルソナ・レビュー workflow(Codex代替)= ドメイン migration を4レンズで敵対的レビュー。
- **残課題(将来)**: 穴/飛び地面の n-way、n-way の FR-95 edge-cut 一致、エイリアス最終削除。
- **運用学習(ユーザー指摘)**: 本スレに逐次編集を抱え込みすぎ＝subagent/workflow 活用不足。以降は**主スレ=オーケストレーター、重い作業=背景 workflow/subagent**。Codex は死亡、レビューは Sonnet 多ペルソナ workflow で代替する。
