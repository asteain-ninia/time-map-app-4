# HUMAN-BUGS-3 統合診断 (HB3)

人間バグハント第3弾（HB3-1〜HB3-28）を実コードで読み取り専用に検証した統合診断。
src / テスト / git は一切変更していない（このファイルのみ Write）。

---

## 1. 総括 — 「核」の評価

**編集ツール層は『ドメインは完備、UI/render への結線が欠落』が支配的な構造である。**
頂点ドラッグ・地物移動・ハンドル・滑り(slide)・共有化(snap)・ナイフ・結合・所属変更・属性編集の
**ロジックは純粋関数として実装済みかつ単体/プロパティテスト通過済み**であり、ほぼ全ての HB3 不具合は
「実装が無い」のではなく「合成ルート(App.tsx)・PointerDispatcher・render パイプラインへの配線が
欠落・部分的」という結線層の問題に収斂する（教訓5.7「ロジックはあるがUIから呼ばれない」）。

**したがって core 編集体験は『骨組みは健全だが live では未通電』の状態にある。**
最も影響が大きい4本柱は (a) 選択ハンドルの描画が render に存在しない(HB3-9)、(b) ドラッグ中
プレビュー通知 callback の欠落(HB3-4)、(c) slide/snap deps の意図的未注入(HB3-20)、(d) 属性編集/
詳細表示の App.tsx 結線漏れ(HB3-14/HB3-11)。これらが解けると体感品質は大きく回復する。

**残る難所は2系統に限られる。** ナイフ開線分割の openLineToClip 半平面押し出し方式(HB3-5/HB3-19)は
read-only 再現が未達で実ジェスチャ特定が必要、競合解決後の境界共有化(HB3-10)と錨↔属性期間の二重表現
(HB3-12)は現行仕様未定義のため要件判断が前提。これら以外は明確修正で着手可能。

---

## 2. HB3 ごとの診断一覧

| ID | status | 分類 | 根本原因 (file:line) | effort |
|----|--------|------|----------------------|--------|
| HB3-1 | works-as-is | design-question | LongitudeShiftControl.tsx:50,62-80（momentary ジョグ、真値は readout 同期 App.tsx:1625） | medium |
| HB3-2 | works-as-is | spec-question | LongitudeShiftControl.tsx:37 / longitude-shift.ts:78,87（太平洋中心=180°プリセット、正常） | small |
| HB3-3 | works-as-is | spec-question | settings.ts:245 / store.ts:595（既定 currentTime=year粒度）/ time-display.ts:78-87（粒度依存表示） | small |
| HB3-4 | implemented-broken | clear-fix | edit-session-adapter.ts:238 / Deps 88-144 に onPreview 無し（release は結線済 PointerDispatcher.ts:332-334,368-370） | medium |
| HB3-5 | unclear | design-question | split-geometry.ts:241-282 openLineToClip 半平面押し出し / gate 410-421 | large |
| HB3-6 | implemented-broken | clear-fix | useKnifeTool.ts:189-202（selectTarget が setActiveFeature 未呼出）/ App.tsx:1708-1746 useKnifeTargetShape | small |
| HB3-7 | implemented-broken | design-question | shell.css:685-700（add は左上）vs knife/merge/reparent.css（下部中央） | medium |
| HB3-8 | implemented-broken | design-question | edit-session-adapter.ts:170-178 × App.tsx:489-490（body hit で featureMoveAllowed=true）/ 誘因 HB3-9 | medium |
| HB3-9 | missing | clear-fix | handles.ts:178 computeHandles は実装済だが render 層に消費者ゼロ（domain/test のみ） | medium |
| HB3-10 | works-as-is | spec-question | consistency-binding.ts:418-457 applyResolutionAt / 366-408 buildRing が新規ID採番、共有化せず | large |
| HB3-11 | implemented-broken | clear-fix | App.tsx:1325-1334（onOpenDetail 未渡し）+ DetailPanels 未マウント / PropertyPanel.tsx:169 | medium |
| HB3-12 | implemented-broken | spec-question | attributes.ts:14-18(属性年) vs anchor-series.ts:370(錨列) を結ぶ同期コード無し / BasicInfoForm.tsx:145-165 | large |
| HB3-13 | missing | spec-question | AddPropertyForm.tsx:24 DEFAULT_COLOR が opacity 省略 → attributes.ts:73 DEFAULT_OPACITY=1 | small |
| HB3-14 | implemented-broken | clear-fix | App.tsx:1325-1334（editDispatch 未渡し）→ SidebarContent.tsx:100-110 throw editNotWired | medium |
| HB3-15 | implemented-broken | clear-fix | live-hit-test.ts:418 + depth-focus.ts:100（兄弟が同一親IDに解決）/ useReparentTool.ts:166-184 / store.selection 未更新 | medium |
| HB3-16 | implemented-broken | clear-fix | live-hit-test.ts:418 + depth-focus.ts:100 / useMergeTool.ts:162,177（同一IDトグルで count 1↔0） | medium |
| HB3-17 | implemented-broken | clear-fix | App.tsx:1158-1165 onKnifeCommitted が setActiveTool(null) 未呼出 / Toolbar.tsx:77 aria-pressed | small |
| HB3-18 | missing | clear-fix | useKnifeTool.ts:189-202（setActiveFeature 未呼出）= HB3-6 と同根 | small |
| HB3-19 | unclear | design-question | split-geometry.ts:241-282 openLineToClip（A・B 起点の90度脚）/ read-only 再現未達 | large |
| HB3-20 | implemented-broken | clear-fix* | App.tsx:467-470,478-511（slide/snap deps 意図的未注入）→ edit-session-adapter.ts:190-200 preview-only 分岐 | large |
| HB3-21 | implemented-broken | clear-fix | AddToolController.tsx:469（Face/Line 2分岐のみ、Point 欠落）/ strings.ts に completePoint 無し | small |
| HB3-22 | implemented-broken | design-question | shell.css:685-700（add のみ未統一、編集3ツールは下部中央実現済） | medium |
| HB3-23 | works-as-is | spec-question | grid.ts:28 GRID_SPACINGS_DEG=[5,10,15,30]（FR-13 列挙に忠実）/ validation.ts:104,144-146 | medium |
| HB3-24 | works-as-is | design-question | main/index.ts:83-102 に setApplicationMenu(null)/autoHideMenuBar 無し（Electron 既定メニュー残存） | small |
| HB3-25 | implemented-broken | design-question | shell.css:379-385 flex-wrap:wrap + 482-487 caption 縦積み → 多段折返し | small |
| HB3-26 | implemented-broken | clear-fix | feature-layer.ts:733,763（面ラベル fill=塗り色と同一）+ canvas2d-renderer.ts:331-337（ハロー/縁取り無し） | small |
| HB3-28 | works-as-is | spec-question | SidebarContent.tsx:142-185(地物一覧=現在時刻に存在) vs 195-249(イベント一覧=全錨横断) | small |

*HB3-20 は分類上 clear-fix（結線修正）だが、注入する neighboursAt は U10 近傍クエリ実装が主で effort=large。

### 詳細補足（実コード確認済み）
- **HB3-9**: `computeHandles` の呼び出し元は handles.test.ts のみ。render 層(feature-layer/canvas2d-renderer/map-renderer)に頂点・エッジハンドルの primitive 生成は皆無。
- **HB3-20**: App.tsx:467-470 のコメントが「The slide/snap LIGHT PATH deps are intentionally omitted here ... the adapter does a preview-only move」と明言。live では constrainSlide(排他)・decideSnap(滑り)・decideSharePairAtRelease(共有化)が一切呼ばれない（HB3-10 とも同根）。
- **HB3-14/HB3-11**: App.tsx:1327 の buildSidebarContent が editDispatch も onOpenDetail も渡していない（実コード確認）。保存は SidebarContent.tsx の throw editNotWired スタブに落ち必ず失敗、詳細ボタンは no-op。
- **HB3-26**: feature-layer.ts:763 で label.fill=color（=面塗り色 activeColor）、canvas2d-renderer の drawLabel は fillText のみで strokeText/ハロー無し。同色背景に同色文字＝実質不可視（明確なバグ）。
- **HB3-21**: AddToolController.tsx:469 は `isFace ? completeFace : completeLine` の2分岐のみ。strings.ts に completePoint が無く、点追加でも「線を確定」と誤表示。

---

## 3. 「明確な修正」一覧（着手順 = 依存 × 影響度で優先度付け）

着手順は **相互作用コア → 各ツール結線 → UX/表示** の順。前段が後段の前提になるよう並べた。

### Phase A — 編集相互作用コア（最優先・他の全頂点編集体験の前提）
1. **HB3-9（頂点/追加ハンドルが描画されない・medium）**
   選択 active feature に対し `computeHandles(feature, vertexStore)` を毎フレーム評価する選択ハンドル層を新設（feature-layer 隣に edit-handles-layer batch）。VertexHandle.position / EdgeHandle.midpoint を world→screen 投影、FR-17 の画面上一定サイズをこの層で適用。map-renderer のパイプラインに editing mode かつ active feature 有り時のみ合成。**HB3-4・HB3-8 の前提**。
2. **HB3-4（ドラッグ中プレビュー欠落=確定後ジャンプ・medium）**
   EditSessionAdapterDeps に `onPreview(session)` を追加し begin/update/release/cancel で通知。App.tsx で受けて live session を ref 保持し frame 再描画をスケジュール。render に transient プレビュー層を追加（HB3-9 のハンドル層と統合可）。これでカーソル追従が実現。
3. **HB3-8（地物移動の暴発・medium / 要件確認後）**
   HB3-9 のハンドル描画で頂点 hit 視認性が上がれば誤爆は実質減る。ツール排他の最終仕様は section 4 の question で確定後に実装（頂点編集中 featureMoveAllowed を false にするか）。

### Phase B — ナイフ／結合／所属変更ツールの結線
4. **HB3-6 + HB3-18（ナイフ対象の強調・選択色なし・small×2、同一修正）**
   ナイフ対象選択時に `store.setActiveFeature(targetId)` を同期（KnifeToolController.onMapPointerDown 経路、または useKnifeTool.selectTarget にホスト注入ポートを追加）。knifeTargetShape が解決され強調＋選択色が同時に出る。
5. **HB3-17（分割確定後にナイフボタンが押下表示のまま・small）**
   onKnifeCommitted で recordCommit 後に `store.setActiveTool(null)`。選択（昇格継承先）は保持しつつ activeTool のみ解除。
6. **HB3-16 + HB3-15（結合/所属変更で兄弟リーフを別個に選べない・medium×2、同根 / 要件確認後）**
   live-hit-test に「表示制御を無視して実リーフを返す」専用 featureAtPoint（leafAtPoint 相当）を用意、またはツール起動中 globalDepth を一時リーフ展開。併せて選択中ターゲットを一時ハイライト層 or ツール専用 highlight set で描画。UX 方針は section 4 で確定後。

### Phase C — 属性/プロパティの結線
7. **HB3-14（属性編集の保存が必ず失敗・medium）**
   App.tsx で EditDispatch を実装し buildSidebarContent に渡す。intent.attributes → FeatureSnapshot → createEditProposal → applyEditProposal(既存)→ recordCommit 経路へ（単一 undo 単位）。
8. **HB3-11（詳細パネルが開かない・medium）**
   App.tsx で DetailPanelsState を useState 保持、onOpenDetail を渡し、overlay に DetailPanels をマウント。detailDocumentOf は文書ソース未保持なら空文字の正直スタブで枠+属性 dl は機能（文書本体は section 4 の判断後）。

### Phase D — UX/表示の独立修正（依存なし、いつでも着手可）
9. **HB3-26（面ラベルが同色で不可視・small）**
   drawLabel に白/黒ハロー（strokeText→fillText）を追加。堅牢には LabelPrimitive に labelFill/labelHalo を持たせ面塗り色の相対輝度からコントラスト文字色を決定。textBaseline=middle/textAlign=center も設定。
10. **HB3-21（点追加で「線を確定」誤表示・small）**
    strings.ts に completePoint を追加し AddToolController.tsx:469 を tool による3分岐へ（ラベル文言は section 4 で確認）。
11. **HB3-13（新規地物が不透明・small / 値は要確認）**
    AddPropertyForm.tsx の DEFAULT_COLOR に fillOpacity 既定（例 0.7）を渡す。値は section 4 で確定。
12. **HB3-25（年操作バーが多段折返し・small / 方針確認後）**
    .timeline__controls を flex-wrap:nowrap、unit/speed の caption 縦積みを横並び or visually-hidden 化。
13. **HB3-7 + HB3-22（確定ボタン配置の統一・medium、同一変更）**
    add の .add-tool__controls を編集3ツールと同じ下部中央規則へ。共通 .tool-controls クラスに切り出し4ツールで共有。最終配置は section 4 で確認。

**明確修正 件数: 13 項目**（HB3-4, 6, 9, 11, 14, 15, 16, 17, 18, 20*, 21, 26 を中心とする clear-fix 群。HB3-7/13/22/25 は design 要素を含むが実装箇所は確定済み。*HB3-20 は結線修正だが neighboursAt 実装が大）。

---

## 4. 「ユーザー判断が要る」一覧（各 question 明記）

| ID | 分類 | question |
|----|------|----------|
| **HB3-1** | design | 中心経度スライダーを『絶対位置（つまみ=実中心経度）』に作り替えるか、現行『相対シフト(ジョグ)＋数値表示』を維持し相対であると分かる UI（ラベル/数値強調）に留めるか。U18 はズーム依存シフト前提で、絶対位置化はズーム依存の利点を失う。 |
| **HB3-2** | spec | 『太平洋』疑義は (A)ボタンのラベル/意図が分かりにくい話か、(B)太平洋中心時の表示位置がおかしい(=HB3-1のスライダー位置症状)か。B なら HB3-1 として扱う。ラベルを『太平洋中心(経度180°)』へ明示するか。 |
| **HB3-3** | spec | タイムライン現在時刻表示は『指定粒度のみ（未指定の月日は省略＝現行/仕様通り）』のままか、『常に年月日（未指定は補完値1月1日）』に変えるか。後者は『未指定=値なし』という U21 コア規約と矛盾するため表示専用補完に限定する方針で良いか。 |
| **HB3-5 / HB3-19** | design | ナイフ開線分割は『1本の線で必ず2片だけに割る（余分な小片を作らない）』が要件か。半平面押し出し方式（多片許容・教訓5.1 片落とし禁止）を維持しつつ余計分断を消す方向で良いか、リング再構成方式へ作り直すか。**併せて HB3-19 の正確な再発条件を実機で1例特定してほしい（どの地物に、どこからどこへ線を引いたか）** — read-only では地図駆動できず確定再現が未達。 |
| **HB3-7 / HB3-22** | design | 確定ボタンバーの統一配置は『下部中央』で確定して良いか（編集3ツールの現状に合わせる前提）。追加ツールのグリッド方式と編集ツールの position:absolute 方式を共通クラスへ統一して良いか。追加ツールのグリッドスナップ等の補助コントロールも同じ下部バーに集約するか、確定/取消のみ下部・補助は別配置か。 |
| **HB3-8** | design | 頂点編集ツールと地物移動を別ツールとして排他にすべきか（頂点編集中は本体ドラッグで全体移動させない）。それとも同一モードで『頂点上ドラッグ=頂点移動／本体ドラッグ=地物移動』を意図的に両立させるか。後者なら本体ドラッグ開始の発火条件（ハンドル直上限定か等）の希望は。 |
| **HB3-10** | spec | 空間オーバーラップを競合解決した後、調整後地物の新境界を優先地物の既存境界頂点と自動的に共有頂点化（溶接）してほしいか。現行仕様(FR-26/30/31/32/95)はこれを要求せず、解決経路は新規ID座標一致境界が残る（後で片方を動かすと境界がちぎれる）。望む場合 FR-95 の継続規則を競合解決へ拡張する新規要件として実装。望まない場合は『共有頂点はスナップ・分割・結合でのみ生成、解決では生成しない』が正式挙動として確定。 |
| **HB3-11** | clear-fix(要判断) | 詳細パネルの『詳細文書(Markdown)』ソースは現状ドメイン未保持。当面『全属性 dl + 文書は空』で機能成立とするか、文書本体の保存/編集まで含めるか。後者はデータモデル追加が必要。 |
| **HB3-12** | spec | 存在期間の正本を『歴史の錨列(FR-54/58)』に一本化し、属性の開始年/終了年(FR-97)は錨列から導出する表示専用に変更して良いか。それとも属性年と錨を双方向同期させる設計を望むか（前者を推奨＝単一真実源）。 |
| **HB3-13** | spec | 新規地物の既定塗り透過度を具体的にどの値にするか（例 0.7=やや透過）。全地物一律か面のみか。設定ダイアログ(FR-109)で変更可能にするか、コード既定の固定値で十分か。 |
| **HB3-15** | design | (a) 所属変更の対象/新親は集約表示中でも個別リーフをピックできるべきか(HB3-16 と共通)。(b) 同レベル A,B への所属変更は A を B の子にする意図か、別の上位領域へまとめて移す意図か（兄弟同士は親子になれない isLegalNewParent 仕様）。(c) ツール選択中ターゲットは『選択色』を使うか、ツール専用ハイライト色にするか。 |
| **HB3-16** | design | 結合/所属変更ツールは、アグリゲート表示中でも内部の個別リーフ子地物を直接ピックして対象にできるべきか（現状は集約表示時にクリックが親アグリゲートに解決されリーフを選べない）。それとも『集約をリーフ展開してから操作する』前提とし、ツール起動時に自動でリーフ展開/フォーカスするか。 |
| **HB3-21** | clear-fix(要判断) | 確定ボタンの点用ラベルは『点を確定』『点を配置』どちらが望ましいか。あるいは点はクリック即確定にしてボタン自体を出さない設計に寄せるか。 |
| **HB3-23** | spec | グリッド間隔の追加は『1°のみ』か『0.1°まで』対応か。0.1°はラベル小数表示化・経線数上限(1000)見直し・広域密描画の性能対応が必要で工数増。FR-13(現在5/10/15/30°列挙)の改訂を許可するか。 |
| **HB3-24** | design | Electron ネイティブメニューバーは完全削除(setApplicationMenu(null))で良いか、Alt 押下で一時表示できる autoHideMenuBar 方式が良いか。標準の Copy/Paste/再読込/開発者ツール等のショートカットがアプリ内で別途提供済みか要確認（削除でネイティブ既定ショートカットも消える）。 |
| **HB3-25** | design | 年操作バー（前へ/次へ・ステップ単位・再生・速度）を常に強制一行(nowrap)にするか。狭幅時は横スクロール許可で良いか、それともアイコン縮小やキャプション非表示で詰めるか。 |
| **HB3-28** | spec | 地物一覧=『現在時刻に存在する地物の選択リスト』(FR-111)、イベント一覧=『全地物の全錨を横断列挙しクリックでその時刻へジャンプ』(FR-84) という差異。UI 上で各一覧に説明キャプションを追加するか。『イベント一覧』を『歴史アンカー一覧(年表)』等へ改称するか。 |

**要判断 件数: 17 項目**（HB3-1, 2, 3, 5, 7, 8, 10, 11, 12, 13, 15, 16, 19, 21, 23, 24, 25, 28 — うち HB3-5/HB3-19 は1論点として統合、HB3-7/HB3-22 も1論点に統合。質問数としては 16 設問）。

---

## 5. バグハント UI 未検証ギャップを埋める behavioral E2E スイープ設計

**問題意識:** 既存のプロパティ/バグハント試験は「両端が地物外へ大きくはみ出す貫通線」など
ドメイン純粋関数を狙ったケースに偏り、**実ユーザーの実ジェスチャ（実ドラッグ・実クリック・
境界近傍で止まる線・アグリゲート表示中の操作）を駆動していない**。これが HB3 群（特に
HB3-4/8/9/15/16/19）を単体テスト通過のまま live で破綻させた。教訓「Behavioral E2E standard」
（実 drag/wheel + テストフック + visual regression + 人間バグ毎の回帰テスト）に沿って設計する。

### 5.0 共通基盤
- Playwright で Electron(または web ビルド)を実起動し、**ポインタ実イベント(mousedown→mousemove×N→mouseup)** で駆動。合成イベントの近道は禁止（教訓: 合成では HB3-4 のプレビュー欠落を検出できない）。
- **テストフック**: window に `__E2E__` を露出し (a) `getActiveFeature()`, (b) `getActiveTool()` の aria-pressed, (c) 現フレームの primitive 種別カウント（handle/label/preview/shape）, (d) live session preview の有無、を JSON で読めるようにする（render を観測可能化）。
- **visual regression**: 各ツール状態の地図セルをスクリーンショットし baseline 比較（面ラベル可読性 HB3-26、確定ボタン配置 HB3-7/22 をピクセルで固定）。

### 5.1 頂点/地物編集（相互作用コア）
- **VE-1 ハンドル描画(HB3-9)**: 面を選択→ハンドル primitive 数 == 頂点数、エッジハンドル数 == 辺数 をアサート。FR-17 のため zoom 変更後もハンドル画面サイズが一定であることを確認。
- **VE-2 ドラッグ追従(HB3-4)**: 頂点ハンドルを掴み mousemove 中の各フレームで preview 頂点座標がカーソルに追従（release 前に動く）こと、release 後にジャンプしないことをアサート。
- **VE-3 地物移動の排他(HB3-8)**: 頂点編集中に本体をドラッグ→（確定仕様に応じ）全体移動が発火しない or ハンドル直上のみ発火、をアサート。
- **VE-4 滑り/共有化(HB3-20)**: 隣接面の境界近くへ頂点をドラッグ→ slide で重ならない、release で共有頂点が1IDに畳まれる（preview→snap→share）をアサート。

### 5.2 ナイフ
- **KN-1 対象強調(HB3-6/18)**: ナイフモードで面クリック→ getActiveFeature() == 対象id、knife-preview の対象 shape primitive(黄塗り)が存在することをアサート。
- **KN-2 確定後ツール解除(HB3-17)**: 分割確定→ tool-edit.knife の aria-pressed が false に戻ることをアサート。
- **KN-3 開線分割の片数(HB3-5/19・最重要ギャップ)**: **実ドラッグ2点**で多様な線を引き（貫通線／境界近傍で止まる線／曲がる線／小地物に対する線／±180シーム跨ぎ）、結果が**ちょうど2片・余分小片0**であることをアサート。HB3-19 の実機再現が取れ次第その具体ジェスチャを回帰ケースとして固定。

### 5.3 結合 / 所属変更
- **MR-1 兄弟リーフの別個選択(HB3-16/15)**: 共通親を持つ子 A,B を持つデータで、A クリック→B クリックが**別 id** に解決され targetIds.length==2（merge）/ target≠newParent（reparent）になることをアサート。
- **MR-2 ターゲット選択色(HB3-15)**: 対象選択後、その地物が選択色 or ツールハイライトで描画されることを visual + primitive でアサート。
- **MR-3 確定有効化(HB3-16)**: 2件選択で確定ボタン aria-disabled が false、縦関係違反時は適切なエラーメッセージが出ることをアサート。

### 5.4 属性 / 詳細
- **PR-1 属性保存(HB3-14)**: 地物選択→錨選択→名前変更→保存→ save-message(失敗)が出ず、再選択で新名反映、undo で旧名に戻ることをアサート。
- **PR-2 詳細パネル(HB3-11)**: 地物選択→「詳細を開く」→ detail-panel-<id> 出現、属性 dl が見えることをアサート。

### 5.5 追加ツール / UX / 表示
- **AD-1 点確定ラベル(HB3-21)**: 点追加→クリック1回→確定ボタン textContent が点用文言であることをアサート。
- **AD-2 新規透過(HB3-13)**: 面追加→ fillOpacity が既定透過値で永続することをアサート。
- **UX-1 ラベル可読性(HB3-26)**: 面ラベルで strokeText 呼出（ハロー）が走り、文字色が塗り色と異なることをアサート + visual。
- **UX-2 確定ボタン配置統一(HB3-7/22)**: 4ツールで確定ボタンが地図セル下部に出ることを座標 + visual で固定。
- **UX-3 年操作バー一行(HB3-25)**: 標準幅で .timeline__controls が1行に収まる（高さ閾値）ことを visual で固定。

### 5.6 回帰ロック方針
- **HB3 1件 = behavioral テスト1本以上** を新設（教訓: 人間バグ毎に回帰テスト）。
- works-as-is 判定の項目（HB3-1/2/3/10/23/24/28）は**現挙動を固定するテスト**を置き、仕様変更時に意図的に更新する（誤った「修正」での退行を防ぐ）。
- design/spec 判断待ち項目は question 確定後に期待値を確定してから実装＋テスト化する。
