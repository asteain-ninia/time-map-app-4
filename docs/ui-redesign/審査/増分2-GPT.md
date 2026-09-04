執筆: GPT 5.6 Sol（読み取り専用実行）／保存: Opus

# コードレビュー結果

**総合判定は `revise`。** 年だけの通常データでは「現在年へ保存」は概ね成立していますが、所有者裁定に反する月日付き錨の扱い、下書き消失、集約子の錨選別、仮想化前の全件計算が残っています。

本レビューは指定差分の静的審査です。実装者が報告した全件テスト結果と計測値の再実行は未確認です。

## 指摘

### 1. 同じ年の月日付き錨を上書きできない

- **重症度**: 3（重）
- **ファイル:行**: [src/ui/property/edit-plan.ts:124](/E:/WORKSPACE/time-map-app-4/src/ui/property/edit-plan.ts:124)、[src/ui/property/edit-plan.ts:130](/E:/WORKSPACE/time-map-app-4/src/ui/property/edit-plan.ts:130)、[src/domain/anchor-series.ts:463](/E:/WORKSPACE/time-map-app-4/src/domain/anchor-series.ts:463)、[src/ui/property/AnchorList.tsx:316](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:316)
- **内容**: 保存時刻を年頭へ丸めた後、既存錨との一致を正規化された日時の完全一致で判定している。1200年6月1日開始の錨は1200年の錨として扱われず、しかも存続期間編集から実際に月日付き開始を作れる。[edit-plan.test.ts:88](/E:/WORKSPACE/time-map-app-4/src/ui/property/edit-plan.test.ts:88) はこの不一致を正しい期待値として固定している。
- **利用者に起きること**: 1200年6月の錨を選ぶと保存は無効。1200年へ丸めると、以前の錨があれば1月1日の新錨が作られ、最初の錨が6月なら地物不在となって選択ごと外れる。所有者裁定の「見ている年＝錨の開始年なら上書き」に反する。
- **直し方**: プロパティ保存とCtrl+Kの同一性を「正規化日時」ではなく「暦年キー」にする。同一年に複数錨を許すなら上書き対象が曖昧なので、年単位操作については一暦年一錨を不変条件にするか、複数時の拒否・修復規則を先に決める。上書き時は既存錨の月日を保持する。

### 2. N-04/K-5 の下書き状態機械に複数の消失・持越し経路がある

- **重症度**: 3（重）
- **ファイル:行**: [src/ui/property/PropertyPanel.tsx:327](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:327)、[src/ui/property/PropertyPanel.tsx:344](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:344)、[src/ui/property/PropertyPanel.tsx:351](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:351)、[src/ui/property/PropertyPanel.tsx:361](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:361)、[src/ui/property/PropertyPanel.tsx:487](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:487)
- **内容**:
  - `dirty` が「元の値とも移動先の現在値とも違う」ときだけ真になる。例えば0年で `A→B` と打ちかけ、移動先1200年の確定名が偶然 `B` なら、確認なしで0年への編集意図が失われる。
  - 同じ編集キーでdomainだけ変わる取り消し・やり直し・外部読込は、下書きがあっても361–366行で無条件に上書きされる。
  - 不在年へ動くと [store.ts:1455](/E:/WORKSPACE/time-map-app-4/src/ui/state/store.ts:1455) で選択が消える。確認UIは `feature !== null` 側にあるため表示されない。
  - 鍵を「読むだけ」にしてもキーが変わらず、下書きと詳細文書の編集状態が残る。再び鍵を開くと古い下書きが復活し、K-5のモード切替時破棄に反する。
  - `alertdialog` 中もCtrl+K、Delete、存続期間操作などが停止されず、[App.tsx:2961](/E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:2961) のショートカット所有権にも含まれない。
- **利用者に起きること**: 打ちかけが警告なく消える、別の年・取り消し後に古い下書きが復活する、確認待ち中に背後の履歴が変更される。
- **直し方**: 値比較による暗黙同期をやめ、`TargetChanged`、`TimeChanged`、`ModeLocked`、`UndoRedo`、`ProjectReplaced`、`SaveSucceeded` を持つ明示的なreducerへ移す。汚れは原則「origin baselineとの差」で判定し、確認を省略できるのは自分の保存成功イベントだけにする。確認はパネルの不在分岐より外へ置き、表示中はショートカットと他の編集操作を停止する。

### 3. 集約子の「関わる錨」判定が保存対象を網羅せず、無変更の錨は原理的に識別できない

- **重症度**: 3（重）
- **ファイル:行**: [src/ui/property/anchor-diff.ts:59](/E:/WORKSPACE/time-map-app-4/src/ui/property/anchor-diff.ts:59)、[src/ui/property/anchor-diff.ts:114](/E:/WORKSPACE/time-map-app-4/src/ui/property/anchor-diff.ts:114)、[src/ui/property/anchor-diff.ts:198](/E:/WORKSPACE/time-map-app-4/src/ui/property/anchor-diff.ts:198)
- **内容**: 比較対象は名前・種別ラベル・親・頂点ID/座標だけで、所有者裁定の保存対象である色、不透明度、パレット、詳細文書を見ていない。形の比較も地物種別、リング種別、リングID、`parentRingId`、リング境界を見ない。またCtrl+Kで作る「値は同じだが、この子について作った錨」は前後スナップショットだけでは誰に関する錨か復元不能。
- **利用者に起きること**: 集約子の見た目や詳細文書だけを歴史化しても、その子の錨表・将来の錨レーンから記録が消える。リング構造だけ変わった錨も落ちる。無変更のCtrl+Kは表示されたりされなかったりし、自己申告のBH2-01の真因は未確認のまま。
- **直し方**: 全保存対象と完全な形状トポロジーを比較する。さらに錨へ `touchedFeatureIds` などの由来を保存し、同一年に複数の子を編集した場合は集合を累積する。後方互換不要なので、この段階で保存形式へ明示的な由来を入れるのが安全。

### 4. 集約子では仮想スクロールより前に全錨×形状比較が走る

- **重症度**: 3（重）
- **ファイル:行**: [src/ui/property/PropertyPanel.tsx:232](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:232)、[src/ui/property/PropertyPanel.tsx:248](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:248)、[src/ui/property/anchor-diff.ts:210](/E:/WORKSPACE/time-map-app-4/src/ui/property/anchor-diff.ts:210)、[src/ui/property/AnchorList.test.tsx:378](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.test.tsx:378)
- **内容**: `relevantEntriesFor` が親の全錨を走査し、各隣接組について子の全頂点を比較してから `AnchorList` に渡す。`governing` は現在時刻依存なので、時間移動でも再実行される。5000本テストは空スナップショットを `AnchorList` へ直接渡しており、この経路を通らない。
- **利用者に起きること**: DOMは16行程度でも、集約子を選ぶ・時刻を動かすたびに数百万～数千万回の比較が起こり得る。実機で何ms/秒になるかは未確認だが、「見えている行だけ差分計算」という受入条件は構造上満たしていない。
- **直し方**: `series identity × featureId` で関連錨の索引をキャッシュし、domain更新時だけ差分更新する。可能なら錨に変更対象IDを持たせ、選別をO(錨数)のID参照にする。5000本テストは実際の`PropertyPanel`、集約子、非空の大形状で計測する。

### 5. N-46 は統合されず、存続期間だけ即時確定のまま

- **重症度**: 3（重）
- **ファイル:行**: [docs/ui-redesign/03-実装計画.md:126](/E:/WORKSPACE/time-map-app-4/docs/ui-redesign/03-実装計画.md:126)、[src/ui/property/AnchorList.tsx:343](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:343)、[src/ui/property/AnchorList.tsx:348](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:348)、[docs/技術方針.md:255](/E:/WORKSPACE/time-map-app-4/docs/技術方針.md:255)
- **内容**: 実装計画は基本情報・詳細文書・存続期間の3契機を「押して保存」側へ揃える要求だった。しかし開始、終了、継続中、錨削除はその場でdispatchしている。技術方針側を「存続期間だけは即時」と書き換えており、実装が計画を満たしたのではなく正本を実装に合わせている。
- **利用者に起きること**: 同じ素性欄で、名前・見た目・本文は下端の保存待ち、存続期間は「反映」を押した瞬間に確定する。N-46の元の混乱が残る。
- **直し方**: 開始・終了もパネルのdraftへ積み、下端保存で一つのdomain commandにまとめる。錨削除だけ破壊操作として例外にするなら、所有者裁定と明示的確認を追加してN-46を書き直す。実装者判断だけで技術方針に例外を足さない。

### 6. 「錨を作って保存」という表示なのに、無変更なら何も書かない

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/property/PropertyPanel.tsx:424](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:424)、[src/ui/property/PropertyPanel.tsx:668](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:668)、[e2e/anchor-edit-time.spec.ts:194](/E:/WORKSPACE/time-map-app-4/e2e/anchor-edit-time.spec.ts:194)
- **内容**: `NewAnchor` 状態ではボタンが「1500年に錨を作って保存」と表示されるが、値が同じなら黙ってreturnする。E2Eの204–206行は、この表示と動作の不一致を期待値として固定している。
- **利用者に起きること**: 押せるボタンが約束した錨を作らず、エラーや理由も出ない。
- **直し方**: `dirty` を保存ボタンの状態に反映し、無変更時は無効化して「変更はありません。錨だけ作る場合は［この年に錨を作る］」と表示する。あるいは文言どおり新設させるが、その場合はCtrl+Kとの役割整理が必要。

### 7. 保存ボタンの「地物不在」状態は実UIに存在しない

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/property/PropertyPanel.tsx:487](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.tsx:487)、[src/ui/state/store.ts:1457](/E:/WORKSPACE/time-map-app-4/src/ui/state/store.ts:1457)、[src/ui/property/PropertyPanel.test.tsx:1258](/E:/WORKSPACE/time-map-app-4/src/ui/property/PropertyPanel.test.tsx:1258)
- **内容**: 不在年では選択が外れ、`feature === null` 分岐が保存列全体を消す。純粋な`EditPlan`には4状態あるが、画面で観測できるのは実質3状態。テストも「4状態」ではなく保存ボタンが無いことを期待している。
- **利用者に起きること**: 約束された「1200年｜この年にはまだありません」と理由付き無効ボタンではなく、一般的な「地物が選択されていません」に変わる。
- **直し方**: 時刻変更時にアクティブ地物の文脈を保持して不在表示へ渡すか、設計上の第3状態を廃止して3状態仕様へ正式に改める。

### 8. 「保存対象は4つだけ」という契約なのに、飾りの開始年・終了年も書き込む

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/property/contracts.ts:190](/E:/WORKSPACE/time-map-app-4/src/ui/property/contracts.ts:190)、[src/ui/property/contracts.ts:198](/E:/WORKSPACE/time-map-app-4/src/ui/property/contracts.ts:198)、[src/ui/property/BasicInfoForm.tsx:195](/E:/WORKSPACE/time-map-app-4/src/ui/property/BasicInfoForm.tsx:195)、[src/ui/App.tsx:3258](/E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3258)
- **内容**: 契約コメントは名前・種別ラベル・見た目・詳細文書の4つだけとする一方、型とフォームに`startYear/endYear`があり、`createBasicAttributes`で保存される。
- **利用者に起きること**: 「表示専用の飾り」と説明された年を変えただけで、現在年に新錨が作られ、保存量と取り消し履歴が増える。
- **直し方**: 飾りの年を読み取り専用にするか、別の明示的編集契約へ分ける。保存対象に含めるなら「4つだけ」という設計・型コメント・画面説明を改訂して所有者裁定を取る。

### 9. Ctrl+Kの最終判定は一つだが、右クリックの可否表示が接続されていない

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/App.tsx:2521](/E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:2521)、[src/domain/context-menu/compose.ts:304](/E:/WORKSPACE/time-map-app-4/src/domain/context-menu/compose.ts:304)、[src/ui/App.tsx:3352](/E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3352)
- **内容**: 実行の最終条件は`canRun`にまとまっているが、Appが`ComposeInput.hasAnchorAtCurrentTime`を渡さないため、既存錨のある年でも右クリック項目が有効表示になる。
- **利用者に起きること**: 押せる項目を押した後で「すでに錨があります」と拒否される。
- **直し方**: 対象決定後のfeature IDと同じ`anchorExistsAt`判定をcompose入力へ供給する。実行時の`canRun`は競合防止用の最終関門として残す。

なお、現行UI経路では「読むだけ」は`resolveCommandEnabled`と表示ゲートで止まる。最初のCtrl+Kが同期的に錨を追加するため、キーリピートの2回目は`canRun`で止まり、二重錨も作られない。`CommandRegistry.dispatch`自体は権限境界ではないため、将来の直接呼出しには注意が必要。

### 10. 仮想表は現在錨を初期表示範囲の外へ置く

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/property/AnchorList.tsx:56](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:56)、[src/ui/property/AnchorList.tsx:125](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:125)、[src/ui/property/AnchorList.tsx:213](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:213)
- **内容**: 前後12本の25件へ切り出すが、`scrollTop`初期値は0のまま。表示高は12行なので、中央錨は13行目、末尾近くなら25行目となり、選択中／現在有効な錨が見えない。
- **利用者に起きること**: 「現在時刻の前後」を開いたのに過去側12本だけが見え、現在錨を探すためにスクロールが必要。
- **直し方**: datasetまたは現在錨が変わったとき、中央行が枠中央に来る`scrollTop`を設定する。Playwrightで2500番・末尾・先頭へ移動し、実際に`toBeVisible()`となる行IDを検査する。

### 11. 親変更の差分名を「後のスナップショット」だけから引いている

- **重症度**: 2（軽）
- **ファイル:行**: [src/ui/property/AnchorList.tsx:151](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:151)、[src/ui/property/AnchorList.tsx:291](/E:/WORKSPACE/time-map-app-4/src/ui/property/AnchorList.tsx:291)、[src/ui/property/anchor-diff.ts:129](/E:/WORKSPACE/time-map-app-4/src/ui/property/anchor-diff.ts:129)
- **内容**: `changesBetween`は旧親と新親の両方を一つのresolverへ渡すが、呼出側は現在錨のsnapshotしか検索しない。そもそも親が別historyなら両snapshotに親本体が入らないこともある。
- **利用者に起きること**: 「親が変わった: 不明な親 → 不明な親」や、新しい名前を旧親にも使った誤表示になる。
- **直し方**: before/after別のresolverを渡し、必要ならプロジェクト全体の各時刻の名前lookupをホストから注入する。内部IDを出さない方針は維持する。

### 12. 計測の方向性は妥当だが、結論が測定能力を超えている

- **重症度**: 2（軽）
- **ファイル:行**: [scripts/measure-anchor-growth.ts:217](/E:/WORKSPACE/time-map-app-4/scripts/measure-anchor-growth.ts:217)、[scripts/measure-anchor-growth.ts:229](/E:/WORKSPACE/time-map-app-4/scripts/measure-anchor-growth.ts:229)、[scripts/measure-anchor-growth.ts:547](/E:/WORKSPACE/time-map-app-4/scripts/measure-anchor-growth.ts:547)、[src/domain/persistence/consistency.ts:530](/E:/WORKSPACE/time-map-app-4/src/domain/persistence/consistency.ts:530)、[docs/ui-redesign/進捗/増分2.md:155](/E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分2.md:155)
- **内容**:
  - `countDistinctAnchorTimes`はstartのJSON表現だけを数えるが、実際の整合チェックは正規化したstartとendの両境界を数える。報告の「異なる年」は一般には分母が違う。
  - 基準→A→Bを各1回、固定順で実行し、ウォームアップ、反復、中央値、GC・OSキャッシュ分離がない。
  - `manifest +1,383,826 bytes`は1.32 **MiB**／1.38 **MB**。実際の`.gimoza`増分は309,373 bytes、約0.295 MiB。報告の「ファイルが5.14→6.46MB」はmanifestをファイルと呼んでいる。
  - `checkConsistency`が境界数ぶん全世界を検査するため、主因という解釈はコードとも整合する。ただし「保存形式を変えても読み込みは速くならない」は強すぎる。差分化だけではこのO(境界数×世界検査)を消せない、が正確。
- **利用者に起きること**: 所有者が圧縮後の実ファイル増加とmanifest増加を取り違え、保存形式変更と整合チェック改善を誤って二者択一と判断する。
- **直し方**: start+endを同じ正規化キーで数え、冷／温を分けて順序をランダム化し、各ケース複数回の中央値・p95を出す。manifestと`.gimoza`を別名称・MiB単位で記載する。

### 13. 探索E2Eは「異常」を検出しても失敗しない

- **重症度**: 2（軽）
- **ファイル:行**: [e2e/__bughunt__/inc2-explore.spec.ts:118](/E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/inc2-explore.spec.ts:118)、[e2e/__bughunt__/inc2-explore.spec.ts:229](/E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/inc2-explore.spec.ts:229)、[e2e/__bughunt__/inc2-explore.spec.ts:248](/E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/inc2-explore.spec.ts:248)
- **内容**: 保存文言不一致、再読込失敗、錨数不一致を`observations.push("[異常] ...")`するだけで、最後に空であることをassertしない。
- **利用者に起きること**: 回帰が起きても163件全緑になり得る。手動で標準出力を読まない限り失敗扱いにならない。
- **直し方**: 観察用ログと`anomalies`を分離し、最後に`expect(anomalies).toEqual([])`を入れる。BH2-01のように保留する既知事象は明示的な既知一覧と一致させる。

### 14. 完了報告の視覚回帰記述が自己矛盾している

- **重症度**: 1（文言）
- **ファイル:行**: [docs/ui-redesign/進捗/増分2.md:225](/E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分2.md:225)、[docs/ui-redesign/進捗/増分2.md:257](/E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分2.md:257)
- **内容**: 前者は基準画像を撮り直して確認済み、後者は撮り直していないと記載する。Git差分上はPNGが更新されている。
- **利用者に起きること**: どの視覚確認が完了済みか判断できない。
- **直し方**: 257–259行の古い申し送りを削除または「撮り直し済み」へ更新する。

## 境界条件の結論

| 条件 | 実装結果 |
|---|---|
| 錨と錨の間 | 直前の有効snapshotを継承し、現在年に新錨。未来錨は変更しない |
| 最初の錨より前 | 地物不在となり選択が外れる。書込みなし。ただし4状態表示とN-04確認が破れる |
| 真の時間的な隙間 | 同上 |
| 最後の錨より後 | 最後が開放端なら新錨。終了済みなら不在で書込みなし |
| 負の年 | 年値、比較、表示、保存とも対応済み |
| 月日付き | 同一年判定が所有者裁定と不一致。指摘1 |
| 取り消し／やり直し | domain全体の1コマンドで戻る。保存1回＝1手。ただし未保存draftは黙って失われ得る |
| 集約子の編集 | 親の現在snapshotを複製し、対象子だけ置換、兄弟は保持。同一年の複数子編集は同じ親錨を順次上書き。各保存は別のundo単位 |

増分1で問題になった購読については、`PropertyPanel`のfeature memoに`domain`と`currentTime`が入り、own/governing seriesもdomain更新へ追従しているため、取り消し後のフォーム凍結は修正されている。変更されたZustandの`subscribe`にもcleanupがある。今回の増分はmain/preloadのIPC契約を変更しておらず、新たなIPC境界違反は確認できなかった。

## 所有者へ出す保存形式裁定の書き直し案

> **裁定 N-13（改）**  
> 最終保存形式として「錨ごとに集約全体のsnapshotを複製する形」は採らない。要件で1地物5万錨を許す以上、同一年の編集が合流することだけを容量対策にはできない。リリース前であるため旧`.gimoza`の読替え・後方互換は要件とせず、形状・頂点の共有または錨差分を持つ形式へ変更する。  
>  
> ただし、保存形式の変更と読み込み時整合チェックの改善は別の判断である。現行の遅延主因は、全start/end境界ごとに全世界を再構築・検査する処理であり、保存形式を差分化するだけでは解消しない。整合チェックも、変更対象／時間区間の索引化、増分検査または検査結果キャッシュへ改める。  
>  
> 判定資料には、非圧縮manifestと圧縮後`.gimoza`を分け、同一年へ集中するケースと年が分散するケースの双方について、複数回の中央値・p95を載せる。

# 総合判定

**revise**
