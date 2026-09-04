執筆: GPT 5.6 Sol（読み取り専用実行）／保存: Opus

# コードレビュー結果

**総合判定: revise**

単一時点での頂点共有と保存形式は概ね成立しています。しかし、異なるアンカー時刻をまたぐ共有頂点、入れ子の確定時検証、編集操作での N-51、保存直後の取り消しに重大な欠陥があります。重症度 4 はありませんが、この状態での受け入れはできません。

## 指摘事項

### 1. 共有頂点が将来アンカーで分裂する

- **重症度:** 3（重）
- **ファイル:行:** [src/domain/editing/apply-proposal.ts:1515](/E:/WORKSPACE/time-map-app-4/src/domain/editing/apply-proposal.ts:1515)、[src/domain/editing/apply-proposal.ts:1620](/E:/WORKSPACE/time-map-app-4/src/domain/editing/apply-proposal.ts:1620)、[src/domain/anchor-series.ts:427](/E:/WORKSPACE/time-map-app-4/src/domain/anchor-series.ts:427)、[src/domain/add/proposal.ts:139](/E:/WORKSPACE/time-map-app-4/src/domain/add/proposal.ts:139)
- **内容:** 共有頂点の移動や頂点 ID の再マッピングは、編集時刻に各履歴へアンカーを挿入するだけである。参加国の一方にそれ以後の既存アンカーがある場合、そのアンカーに保存された古い頂点座標が再び有効になり、同じ `VertexId` が国ごとに別座標を表す。分割・結合・穴あけの再マッピングにも同じ時間方向の問題がある。
- **利用者に起きること:** ある年では一緒に動いた国境が、年を進めると再び離れる。保存後の整合性検査で共有 ID の座標不一致として修復対象になる可能性もある。単純な同時点の双方向追随は動くが、異なる錨をまたぐ共有は成立していない。
- **直し方:** 共有 ID に参加する全履歴についてアンカー境界時刻の和集合を作り、どれか一つの座標が変わる時刻には他方にも同じ座標を持つアンカーを挿入する。より堅牢には、共有頂点を feature ごとの `vertices` ではなく、時間変化を持つ正規の共有頂点履歴として管理する。再マッピングも共有が解除される時刻まで伝播させる。

### 2. 削除後の頂点ストアに孤児頂点が残る

- **重症度:** 2（軽）
- **ファイル:行:** [src/domain/deletion/command.ts:45](/E:/WORKSPACE/time-map-app-4/src/domain/deletion/command.ts:45)、[src/domain/deletion/command.ts:65](/E:/WORKSPACE/time-map-app-4/src/domain/deletion/command.ts:65)、[src/domain/persistence/consistency.ts:352](/E:/WORKSPACE/time-map-app-4/src/domain/persistence/consistency.ts:352)
- **内容:** feature を削除しても、各アンカーの頂点ストアは元のまま保持される。削除された feature だけが参照していた頂点や、以前共有していた頂点の古い複製が残る。
- **利用者に起きること:** 保存データが不要に増える。さらに整合性検査が参照中の頂点だけでなくストア内の同一 ID を比較するため、孤児になった古い座標が共有頂点の不一致として誤検知されうる。
- **直し方:** 各アンカーの feature 削除後に `pruneVertexStore` 相当を適用し、そのスナップショットから参照されなくなった頂点を除去する。削除、所属変更、分割・結合のすべてを同じ不変条件で処理する。

### 3. FR-29 の「全頂点が同じ面の内側」は包含判定になっていない

- **重症度:** 3（重）
- **ファイル:行:** [src/domain/add/session.ts:167](/E:/WORKSPACE/time-map-app-4/src/domain/add/session.ts:167)、[src/ui/add/useAddTool.ts:324](/E:/WORKSPACE/time-map-app-4/src/ui/add/useAddTool.ts:324)、[docs/現状.md:116](/E:/WORKSPACE/time-map-app-4/docs/現状.md:116)、[e2e/snap-share.spec.ts:164](/E:/WORKSPACE/time-map-app-4/e2e/snap-share.spec.ts:164)
- **内容:** B33 の例外を「打った点の `insideTerminalId` がすべて同じ」で実装しているが、辺と面の包含を検査していない。凹面では全頂点が内側でも辺が外へ出られ、穴をまたぐ形も作れる。外側へ出る辺や閉じる辺も確定時に再検証されない。また `docs/現状.md` は所有者裁定まで厳格な FR-29 を維持するとしており、実装が先行している。
- **利用者に起きること:** 見た目上は親国からはみ出す、凹みを横切る、穴を塞ぐ子領域を「入れ子」として確定できる。後続の union や包含判定が不安定になる。
- **直し方:** 確定時に、新規ポリゴン全体が候補親の実領域内に含まれることを seam-aware な boolean geometry で検証する。少なくとも `newShape \ parentShape` が空で、親の穴を覆わないことを確認する。所有者裁定までは点ベースの例外を正式仕様として固定しない。

### 4. 確定後の `parentId` が幾何学上の親を表さない

- **重症度:** 3（重）
- **ファイル:行:** [src/ui/App.tsx:3029](/E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3029)、[src/ui/add/AddPropertyForm.tsx:113](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddPropertyForm.tsx:113)、[src/domain/add/proposal.ts:201](/E:/WORKSPACE/time-map-app-4/src/domain/add/proposal.ts:201)
- **内容:** 親候補はその時刻に存在する面から列挙され、選択値を幾何学検証せず `parentId` に採用する。フォームの既定値は「親なし」であり、同一面内として FR-29 を通過しても自動的にはその面の子にならない。無関係な面や表示上隠れている面も選べる。
- **利用者に起きること:** 国の内部に描いた領域がトップレベルとして保存され、重なり競合になる。逆に、離れた国を親として保存できる。
- **直し方:** 完全包含する面だけを候補にし、一意なら既定の `parentId` とする。入れ子例外で確定した場合は親選択を必須にし、保存直前にも現在時刻の形状と親の存続期間を再検証する。E2E では保存後と再オープン後の `parentId` を検査する。

### 5. 集約表示の見えている境界へ吸着できない

- **重症度:** 3（重）
- **ファイル:行:** [src/ui/map/display-resolution-cache.ts:238](/E:/WORKSPACE/time-map-app-4/src/ui/map/display-resolution-cache.ts:238)、[src/ui/add/snap-ports.ts:81](/E:/WORKSPACE/time-map-app-4/src/ui/add/snap-ports.ts:81)、[src/ui/add/snap-ports.ts:131](/E:/WORKSPACE/time-map-app-4/src/ui/add/snap-ports.ts:131)
- **内容:** 集約描画された親領域には吸着可能な固有頂点が作られず、吸着は `liveHitTestAt` が返す生の頂点だけを対象とする。一方、入れ子判定は表示解決を経ない生の leaf を参照する。このため、描画対象・吸着対象・FR-29 判定対象が一致していない。
- **利用者に起きること:** 画面に見えている連邦・集約領域の境界をクリックしても吸着できず、見えていない子 feature の内外判定で追加が拒否されたり、別の親名が表示されたりする。
- **直し方:** 描画、hit-test、入れ子、親候補を同一の表示解決結果から構築する。集約境界を吸着可能にするなら、技術方針 §2.8 に従い union 出力座標を入力側 `VertexId` へ再マッピングする。対応できない集約境界ではドリルダウンを要求し、理由を UI に表示する。

### 6. 共有頂点の可視所有者と複数候補の扱いが不定

- **重症度:** 2（軽）
- **ファイル:行:** [src/ui/map/display-resolution-cache.ts:305](/E:/WORKSPACE/time-map-app-4/src/ui/map/display-resolution-cache.ts:305)、[src/ui/map/live-hit-test.ts:1094](/E:/WORKSPACE/time-map-app-4/src/ui/map/live-hit-test.ts:1094)
- **内容:** 頂点索引は共有頂点について最初の所有 feature だけを記録する。その所有者がフィルターで非表示だと、同じ頂点を使う可視 feature があっても候補から除外される。また、異なる ID の頂点が同位置または同距離にある場合、走査順の最後の候補が暗黙に選ばれ、利用者は選択できない。
- **利用者に起きること:** 可視国の頂点なのに吸着しない場合がある。三国接点や重なった頂点では、どの共有関係が作られたかが履歴順に依存する。
- **直し方:** 索引には `VertexId` ごとの全所有者、または `(vertexId, ownerId)` を保持し、少なくとも一つ可視所有者があれば候補にする。hit-test は距離順の候補配列を返し、同率候補では候補選択 UI を出す。選択 UI が未実装なら曖昧な同率吸着を拒否する。

### 7. 編集ドラッグでは N-51 が検査されない

- **重症度:** 3（重）
- **ファイル:行:** [src/domain/add/shape-draft.ts:120](/E:/WORKSPACE/time-map-app-4/src/domain/add/shape-draft.ts:120)、[src/domain/add/shape-draft.ts:182](/E:/WORKSPACE/time-map-app-4/src/domain/add/shape-draft.ts:182)、[src/domain/editing/edit-flow.ts:161](/E:/WORKSPACE/time-map-app-4/src/domain/editing/edit-flow.ts:161)
- **内容:** 追加モードは `abs(Δlongitude) >= 180` を拒否し、閉じる辺も検査している。しかし既存頂点や feature 全体のドラッグ確定経路には同じ検査がない。共有頂点の移動で隣国側に長辺が発生する場合も未検査である。
- **利用者に起きること:** 編集操作で、保存形式が表現できない 180 度以上の辺を作れる。再描画・再オープン時に意図しない側へ回り込む可能性がある。
- **直し方:** N-51 を追加ツール固有ではなく、全 geometry proposal のコミット直前に適用する共通不変条件にする。点・線・面、閉じる辺、共有先、分割・結合・穴あけ結果を検査する。180 度ちょうど、日付変更線の複製表示、頂点ドラッグ、feature ドラッグをテストする。

### 8. 年を変更しても追加ドラフトと吸着 ID が旧時刻のまま残る

- **重症度:** 3（重）
- **ファイル:行:** [src/ui/add/AddToolController.tsx:183](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:183)、[src/ui/add/AddToolController.tsx:246](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:246)、[src/ui/add/AddToolController.tsx:423](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:423)、[src/ui/add/useAddTool.ts:436](/E:/WORKSPACE/time-map-app-4/src/ui/add/useAddTool.ts:436)
- **内容:** 保存先時刻は最新の `currentTime` へ切り替わるが、既に打った頂点の座標、吸着した `VertexId`、候補名は旧時刻から引き継がれる。時刻変更時に親候補は再検証するものの、頂点の再解決またはドラフト破棄をしていない。候補名更新 effect に時刻・domain の依存もない。
- **利用者に起きること:** 過去年で吸着した国が存在しない年へ移動して保存すると、現在年の無関係な feature と同じ ID を共有したり、旧年の座標を現在年へ持ち込んだりする。画面の候補名も古いままになりうる。
- **直し方:** 設計書 K-5 に沿い、時刻・domain 変更時はドラフトがあれば確認して破棄する。継続を許す場合は全吸着 ID を新時刻で再解決し、不在または座標不一致なら明示的に解除する。候補表示の effect も時刻と domain revision に購読させる。

### 9. 追加保存直後の Ctrl+Z が追加 feature を取り消さない

- **重症度:** 3（重）
- **ファイル:行:** [src/ui/add/AddToolController.tsx:233](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:233)、[src/ui/add/AddToolController.tsx:263](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:263)、[src/ui/add/AddToolController.tsx:304](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:304)
- **内容:** 保存成功後に空の `Drawing` セッションを即座に再開し、追加ツールがグローバル undo を引き続き占有する。空ドラフトでの Ctrl+Z はセッションをキャンセルして再度 armed 状態になるだけで、保存した追加操作へ届かない。
- **利用者に起きること:** 保存直後に Ctrl+Z を押しても何も消えない。設計書 E.1 V1/V2 の「確定後 Ctrl+Z 1手」に違反する。
- **直し方:** 「追加ツール選択中だがドラフトなし」と「頂点編集中」を別状態にする。保存後は idle に戻し、最初の地図クリック時に遅延して Drawing を開始する。グローバル undo を止めるのは、追加ツール自身が戻せる頂点または未確定形状を持つ間だけにする。undo→redo 後も共有 ID が同じことを検査する。

### 10. 素性フォームと Escape/Ctrl+S の状態規則が欠けている

- **重症度:** 2（軽）
- **ファイル:行:** [src/ui/add/AddPropertyForm.tsx:63](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddPropertyForm.tsx:63)、[src/ui/add/AddPropertyForm.tsx:92](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddPropertyForm.tsx:92)、[src/ui/add/AddToolController.tsx:263](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:263)、[src/ui/shell/useShortcuts.ts:82](/E:/WORKSPACE/time-map-app-4/src/ui/shell/useShortcuts.ts:82)
- **内容:** 名前は空のまま保存でき、モードやツールを離れると確定前の形状が確認なしに破棄される。空名を許すかは資料からは**未確認**。フォームは自動 focus されるが、ショートカット処理が入力欄の focus 判定で先に終了するため Ctrl+S がプロジェクト保存へ届かない。PropertyForm 中の Escape も追加ツール側で処理されない。Drawing 中の Escape は 3 点以上でも確認なしに全破棄する。
- **利用者に起きること:** 名前入力中だけ Ctrl+S が効かない。Escape の挙動が Drawing と素性入力で変わり、完成した形状を誤って失う。空名 feature も作成できる。
- **直し方:** Drawing、PropertyForm、保存済み idle ごとのキー規則を明文化する。Ctrl+S のような always-allowed 操作は focus guard より前に判定する。3 点以上の Escape、タブ・ツール・時刻変更は確認後に破棄する。空名は必須入力にするか、安定した「名前なし」表示へ正規化する。

### 11. 毎 pointermove で React state 更新と親候補検証が走る

- **重症度:** 2（軽）
- **ファイル:行:** [src/ui/add/AddToolController.tsx:246](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:246)、[src/ui/add/AddToolController.tsx:325](/E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:325)、[src/ui/add/useAddTool.ts:353](/E:/WORKSPACE/time-map-app-4/src/ui/add/useAddTool.ts:353)
- **内容:** pointermove ごとに近傍検索と `setSession` を実行する。さらに親候補再検証 effect が `add.session` 全体に依存するため、候補の identity が変わっていなくても preview 更新ごとに再実行される。R-tree により全 feature 走査は避けられているが、フレーム単位の集約はない。
- **利用者に起きること:** 大規模データでマウス移動時の CPU 使用率や入力遅延が増える可能性がある。実際に目視できる遅延が出るかは**未確認**。
- **直し方:** pointermove を `requestAnimationFrame` 単位に coalesce し、最後のイベントだけ処理する。preview は可能なら React state から分離し、親再検証は候補 ID、時刻、domain revision が変わった場合だけ実行する。

### 12. E2E が問題のある実装結果を固定し、重要な永続化を検証していない

- **重症度:** 2（軽）
- **ファイル:行:** [e2e/snap-share.spec.ts:164](/E:/WORKSPACE/time-map-app-4/e2e/snap-share.spec.ts:164)、[e2e/__bughunt__/inc3-explore.spec.ts:16](/E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/inc3-explore.spec.ts:16)、[e2e/__bughunt__/inc3-explore.spec.ts:262](/E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/inc3-explore.spec.ts:262)
- **内容:** `snap-share` は B33 の点ベース規則を期待値として固定するが、素性フォームで保存せず、`parentId` も検証しない。`inc3-explore` は「save/reopen」と称するものの、追加フォームの保存を押して同一プロセス内を確認するだけで、ファイル保存・再起動・再オープンを行っていない。異なるアンカー、逆方向追随、削除、undo/redo、分割・結合・穴あけ・所属変更の共有保持も未検証である。
- **利用者に起きること:** テストが通っても、今回の主要要件である共有関係の時間的・永続的な正しさを保証しない。誤った B33 実装だけが回帰テストで維持される。
- **直し方:** 異なるアンカー構成を含む双方向追随、保存→プロセス再起動→再オープン、undo/redo の ID 一致、削除後の孤児除去、各幾何操作後の共有保持を追加する。FR-29 は凹面、穴、外への横断、閉じる辺、集約表示について保存後の `parentId` まで検査する。

## 指摘なし、または成立を確認できた点

- 追加モードの N-51 は 180 度**ちょうど**も拒否し、面の閉じる辺も検査している。
- 日付変更線ではクリック側の world turn へ表示座標を移す処理があり、保存される頂点本体は正規座標のままである。
- 非集約の leaf については、面の外周・穴、飛び地、線、点が頂点索引へ入る。穴の内側は `leafAtPoint` で面外として扱われる。
- 索引は immutable root、時刻、表示制御をキーに更新され、フィルターは照会時に適用される。上記「最初の所有者」問題を除き、明確な鮮度漏れは見つからなかった。
- 単一時点では共有 ID の双方向移動が働き、serializer も `VertexId` を保持する。undo/redo の履歴自体も immutable root を保持するため ID を再採番しない。ただし保存直後のキー配送は指摘 9 のとおり壊れている。
- 分割・結合・穴あけ・所属変更は現在スライス内では頂点再マッピングを行っている。将来アンカーへの伝播だけが指摘 1 の問題である。
- `onMapMount` の4分割は、観測→描画→hit-test→入力の生成順と、入力→描画→観測の破棄順を維持している。カメラ参照、入力層、観測、`redraw-watch` に静的差分上の二重登録・購読欠落は見つからなかった。実際の再マウント時挙動は**未確認**。
- K-2 の popover/backdrop 条件、K-3 の OptionBar 寸法、および `add-complete`／`add-save` の testid 付け替えは一貫している。K-5 は指摘 8・10 に違反がある。
- 極付近について特別な欠落条件は見つからなかったが、実機上の極端な投影・吸着操作は**未確認**。

## 検証状況

- `git diff --check`: 成功
- TypeScript 型検査: 成功
- ESLint: エラーなし。既存の不要な `eslint-disable` 警告が12件
- Vitest: 読み取り専用環境で Vite が `vitest.config.ts.timestamp-*.mjs` を作成できず、`EPERM` で起動不能
- E2E: 未実行

**最終判定: revise**
