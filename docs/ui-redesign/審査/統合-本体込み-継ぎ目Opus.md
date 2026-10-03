# 統合ブランチ（本体＝増分 7 の取り込み）の継ぎ目の検証（検証係 Opus）

- 対象: worktree `E:\WORKSPACE\time-map-app-4-integ`、ブランチ `integ-2026-10`（先端 `99ef92e`。merge コミットは `f4172f1`、そのあとの直しは `10fb975`・`38caaf1`・`61f6083`・`487fb42`・`5455211`・`99ef92e`）
- 見たもの: 増分 7（本体）と 8A〜8E の継ぎ目だけ（各増分の中身の再審査はしていない）。依頼書 `brief-integ-main.md`、merge コミット `f4172f1` の本文と差分、`増分8E.md` §15、前回の継ぎ目の記録 `統合8A-8D-継ぎ目Opus.md`、継ぎ目にあたるコード。
- 書いたもの: この記録と、scratchpad の探針（`scratchpad\seam2-probe\`）だけ。src・e2e・ほかの文書は触っていない。コミットもしていない。

## 総合判定: **revise**（小さい）

重症度 3 は無い。取り込みそのもの（衝突の解き方・番号の付け替え・保存の前の確認の板の登録）に誤りは見つからなかった。
ただし、相談役が見るように指定した (1) の「捨てた記録の件数が知らされること」が **実物では一度も知らされない**（2-1）。これは取り込みが壊したものではなく本体（増分 7）のときから配線が切れていたものだが、merge コミットの本文と `増分8E.md` §15 は「本体の `reportRepairDiscards` を残した」と、働いているかのように書いている。直しは 1 行の配線と検査 1 本で済む。

| 番号 | 重症度 | 取り込みが原因か | 一言 |
| --- | :-: | --- | --- |
| 2-1 | 2 | いいえ（本体のときから） | 修復で捨てた記録の件数の知らせ（`reportRepairDiscards`）が、`buildFileCommandPorts` で落ちて実物では呼ばれない。普通の「開く」・D&D・「以前の保存から開く」のどれでも |
| 1-1 | 1 | いいえ（本体の設計の範囲） | 手動の保存の確認の板が出ている間に自動保存のティックが来ると、板で［やめる］を選んだ直後に、並んでいた自動保存が聞かずに書く |
| 1-2 | 1 | いいえ（継ぎ目で初めて見えた。増分 7 × 8E） | 見ている年で「この年に終わったことにする」を押すと、その地物（と一緒に終わるまとめ役）の詳細パネルがその場で閉じる。状態行は言わず、取り消しても開き直さない |
| 1-3 | 1 | いいえ（継ぎ目で初めて見えた。増分 7 の B76 × 8B。いまは隠れている） | 分割の切り口を後ろの錨へ引き継ぐ範囲（`carryUntil`）は継承先の「次の錨」しか見ず「終わり」を見ない。いまは B77（新しい片が終わらない）のおかげで食い違わないが、B77 を直すと終わった後の年の隣へ切り口が入る |
| 1-4 | 1 | いいえ（継ぎ目で初めて見えた。増分 7 の B79 × 8D） | 修復が解消しきれずに板が出直すとき、8D の「各行の先頭を選んだ状態から始める」で、いま効かなかった方法がまた選ばれた状態で出る（B79 の形＝古いファイルだけ） |
| 1-5 | 1 | はい（取り込みの番号の付け替え） | 前回の継ぎ目の記録の「B65〜B80 の出どころはすべて合っている」は、B72→B80 の付け替えで範囲の中に本体の B72〜B79 が入り、文の範囲と列挙が合わなくなった（言い回しだけ） |

---

## 重症度 2

### 2-1 修復で捨てた記録の件数が、実物では知らされない

- **場所**:
  - `src/ui/file-ops/file-commands.ts:145`（`FileCommandPorts.reportRepairDiscards?` は省略できる口）・`:213`・`:232-233`（`ports.reportRepairDiscards?.(…)` で呼ぶ）
  - `src/ui/file-ops/FileOpsController.tsx:940-942`（宿主は `reportRepairDiscards` を持ち、状態行へ `REPAIR_STRINGS.discarded(count)` を出すつもりで書いてある）
  - `src/ui/file-ops/bridge.ts:43-110`（`FileOpsHost` に `reportRepairDiscards` が **無い**）・`:208-242`（`buildFileCommandPorts` が返す口の一覧に **写していない**）
- **何が起きるか**（探針 `seam2-probe\fileops.probe.test.ts`。本物の `buildFileCommandPorts` に宿主の模型を渡し、本物の `dropLoadCommand`・`openBackupCommand` を通した）:
  - `buildFileCommandPorts(host)` の戻りに `reportRepairDiscards` が無い（`'reportRepairDiscards' in ports` は偽）。
  - 既定の修復で 1 件捨てる形（`repair-orphan-materialize.test.ts` の「同じ年で中身が食い違う」と同じ形）を D&D で開くと、流れは「修復の板 → `reflect(…, repaired: true)`」で終わり、宿主の知らせは **呼ばれない**。
  - 対照: `ports` に宿主の口を足すと、同じ流れで `discards:1` が呼ばれる（流れそのものは件数を正しく数えている）。
  - 「以前の保存から開く」で同じ形の世代を開いても同じ（`openBackup → 修復の板 → reflect(…, repaired: true) → endBackupChoice`。知らせは無い）。
- **いつから**: 本体の先端 `140747e` の `bridge.ts` にも口が無く、`FileOpsController.tsx` の宿主にだけある。増分 7 の手直し 2 回目で口と宿主を足したときに、間の写しが漏れた。取り込みは両側をそのまま残しただけで、壊してはいない。ただし merge コミットの本文と `増分8E.md` §15 の衝突の表は「8D の反映の行に本体の知らせの行を続けた」と書き、働いているように読める。
- **なぜ検査で見つからなかったか**: `file-commands.test.ts` と `repair-flow-interval.test.ts` は `FileCommandPorts` を直接組んで口を差すので、`bridge.ts` を通らない。`FileOpsController.test.tsx` には捨てた記録が出る形の読み込みが無い。E2E にも、修復して開いたあとの状態行の件数を読むものは無い（`e2e/*.ts` に `REPAIR_STRINGS`・「捨てました」の参照なし）。型の検査（エラー 0）も守りにならなかった: 宿主は `useMemo` の中の関数が返す値なので、`FileOpsHost` に無い `reportRepairDiscards` を宿主に足しても余分な欄として咎められず、`buildFileCommandPorts` の戻りに無いことも省略できる口なので咎められない。直すときは **`FileOpsHost` の型に口を足す**（戻りの値に足すだけにしない）。
- **利用者に起きること**: 修復の既定「各地物に自分の年表を作って残す」で、同じ年に食い違う古い記録を捨てても、状態行は何も言わない（反映で状態行は消える）。増分 7 の手直し 2 回目が「中身のある記録を黙って捨てない」ために足した知らせが、一度も出ない。所有者の原則（削除以外でデータが黙って変わらない）に当たる。
- **直し方の案**: `FileOpsHost` に `readonly reportRepairDiscards?: (count: number) => void` を足し、`buildFileCommandPorts` の戻りに `reportRepairDiscards: host.reportRepairDiscards` を写す。検査は、`buildFileCommandPorts` を通して件数が宿主へ届くことを 1 本（探針の 2 本目・3 本目と同じ形）。あわせて merge の記録（`増分8E.md` §15 の表）に「本体のときから配線が切れていた」と一言足す。

---

## 重症度 1

- **1-1 板で［やめる］を選んだ直後に、並んでいた自動保存が書く**（本体。取り込みが原因ではない）。手動の保存は、上書きの確認の間だけ排他の鍵を取り、保存の前の確認の板（#27）を待つ間は鍵を取っていない（`FileOpsController.tsx:1083-1123`）。そのため板が出ている間に自動保存のティックが来ると、ティックは止まらずに保存の列（`bridge.ts` の `saveChain`）の後ろへ並ぶ。利用者が［やめる］を選ぶと手動の保存は「やめました」で終わり、すぐ後ろの自動保存が `origin: 'auto'` で板を出さずに書く（探針 (2b): `{"kind":"cancelled"}` のあと `{"kind":"saved"}`、`api.save` 1 回）。自動保存が年をまたぐ食い違いを聞かずに書くのは本体の設計どおり（`preSaveGate` の注記）なので、5 分以内には同じことが起きる。違うのは「やめた直後に、状態行は『やめました』のまま書く」ことだけ。直すなら、手動の保存が板で［やめる］になったら、その間に並んだ自動保存の 1 回を落とす。
- **1-2 終わらせると、その地物の詳細パネルがその場で閉じる**（増分 7 × 8E）。見ている年で素性欄の「この年に終わったことにする」を押すと、その地物はその年に居なくなるので、8E の `keepPanelsPresent`（`App.tsx:3397-3411`。いまの年に居ない地物のパネルを閉じる）が開いていた詳細パネルを閉じる。素性欄は増分 7 の決め（`existence-status.ts`）どおり選択を保ったまま「この地物は1500年で終わっています。」と言い、状態行は「『…』は1500年で終わったことにしました。」とだけ言う。取り消すと地物は戻るが、パネルは開き直さない（8E の「戻っても開き直さない」どおり）。まとめ役を終わらせたときは、まとめ役のパネルが閉じ、最上位になった子のパネルは残る（実物の探針 `seam2-probe\pw\endhere-detail.probe.spec.ts`。2 本とも記録どおり）。どちらの増分の決めにも合っているが、「押した操作が失敗したように見せない」（増分 7）と「居ない年は閉じる」（8E）が、終わらせた直後の 1 枚のパネルでは逆向きに働く。データは変わらない。直すかは司令塔の判断（記録だけでよい）。
- **1-3 分割の切り口の引き継ぎは、継承先の「終わり」を見ていない**（増分 7 の B76 × 8B。いまは隠れている）。`applySplitProposal` の手順 5（`apply-proposal.ts:433-442`）は、隣の後ろの錨へ切り口と頂点の付け替えを入れる範囲を「継承先の次の錨の始まり」（`nextEntryStartAfter`）までにしている。継承先が終わりのある錨で分けられても（B76 で継承先の新しい錨は終わりを引き継ぐ）、終わりの後の年の隣の錨にも切り口が入る（探針 (6b): A を 1200 年で終わらせて 1100 年に分けると、隣 B の 1700 年の錨にも切り口 `nv-7` が入る）。いまは新しい片が終わらない（`docs/現状.md` B77）ので、1700 年にも新しい片が居て隣と切り口を共有し、**T 字 0・整合の検査 0 件**で食い違わない。B77 を「新しい片も元と一緒に終わる」で直すと、終わった後の年の隣にだけ、誰とも共有しない一直線の頂点が残る。B77 を直すときに、`carryUntil` を「次の錨の始まり」と「継承先の終わり」の早いほうにすること（B77 の記述へ一言足すのがよい）。8A の辺への挿入（探針 (6a)・(6d)）は、終わりを越えて生き返らせず（B76 どおり）、T 字 0・整合 0 件。終わった後の年の隣にも頂点が入るが、隣の 1100 年の錨がもともと終わりの後まで効いているので、それと揃っているだけで形は変わらない。
- **1-4 修復の板が出直すとき、効かなかった方法がまた選ばれている**（増分 7 の B79 × 8D）。8D は修復の板を「各行の先頭を選んだ状態から」始める（`RepairDialog.tsx:91` の `defaultRepairChoices`）。1 回目の修復で解消しきれず板が出直す（`file-commands.ts:216-219`）と、出直した板も新しく組み立てられるので、残った行の先頭＝いま効かなかったのと同じ方法が選ばれた状態で出る。B79（区間の修復が効かない形でも先頭に出す。古いファイルだけ）の形では、そのまま押すと 2 回目も解消できず読み込みが止まる。8D の前は利用者が自分で選び直す必要があった。コードを読んだ限りで、画面では確かめていない。直すなら、出直した板では、1 回目に選んで効かなかった方法を先頭の既定にしない（B79 の直しと一緒に）。
- **1-5 前回の継ぎ目の記録の範囲の文**。`統合8A-8D-継ぎ目Opus.md:117` の「B65〜B80 の出どころはすべて合っている（本体 B65〜B67・8C B68・8B B69/B70・8A B71/B80）」は、付け替え前は「B65〜B72 … 8A B71/B72」だった。B72 を B80 へ置き換えたので、範囲「B65〜B80」に本体の B72〜B79 が入り、列挙と合わない。言い回しだけで、番号の指す先は正しい。

---

## 確かめたこと（問題が無かったもの）

### (1) 壊れたファイルの読み込みの通し

- 修復の方法の並びは本体のまま（`repair.ts:175-259`）: 区間の修復（`DetachToTopLevelWithin`・`RemoveEmptyAggregateIntervals`）と「各地物に自分の年表を作って残す」が先頭（既定）、捨てる方法は後ろ。8D の「各行の先頭を選んだ状態から始める」（`RepairDialog.tsx:91`）はこの先頭をそのまま選ぶ。`repair-option-order.test.ts`（選択肢が 2 つ以上ある行の先頭は捨てる方法でない）は通る。
- 対象の呼び名は 8D の `repair-names.ts` → `participant-name.ts` の 1 本から引く（`repair-flow.ts:96-120`）。「空のタイムライン」の文は `61f6083` で「持ち主の居ない歴史（中に N 件の地物の記録）を、中身ごと読み込みから除外します（中の地物も消えます）。」に直っている（件数は `historyMembers`）。`RepairDialog.test.tsx` の「文に英字が混ざらない」は通る。
- 修復は全部当ててから整合検査を 1 回（`repair-flow.ts:340-373`）。捨てた件数は 2 回目の修復の分も足して数える（`file-commands.ts:232`）。
- 修復したら未保存で始めるのは 8D の決めどおり「世代から開いて修復したとき」だけ（`FileOpsController.tsx:851`）。普通のファイルを修復して開いたときは従来どおり（8D の範囲の決め）。
- 「以前の保存から開く」で壊れた世代を開いても、同じ `completeLoad` を通る（探針: `openBackup → 修復の板 → reflect(…, repaired: true) → endBackupChoice`。`endBackupChoice` は反映の後に 1 回）。件数の知らせだけが 2-1 で落ちる。

### (2) 保存の前の確認の板 × 「以前の保存から開く」・自動保存

- 「以前の保存から開く」の未保存の確認で［保存］を選ぶと、`saveWithOverwriteConfirm`（鍵は取り直さない）→ `performSave` → `preSaveGate('manual')` の順で板が出る。探針で 3 通りを通した（どれも `endBackupChoice` はちょうど 1 回）:
  - 板で［このまま保存する］: `api.save → onSaved → openBackup → 修復 → reflect → endBackupChoice`。選んだ世代は保存の間引きから外れたまま開ける（8D の E2E「世代が上限まで溜まった状態で最古の行を選び、未保存の確認で『保存』しても、選んだ世代は消えずに開ける」も通る）。
  - 板で［やめる］: 保存も世代を開くのもせず、`endBackupChoice` だけ。
  - 保存を止める形（`block`）: 同じく `endBackupChoice` だけ。
- 「以前の保存から開く」は 1 つの排他の鍵の中で走るので、その間の自動保存のティックは落ちる（`opInFlightRef`）。板で流れが止まって鍵が残ることは無い（`finally` で `endBackupChoice`、鍵は `runExclusive` が外す）。
- 手動の保存の板と自動保存は 1-1。

### (3) 右クリックのメニューの口

- 取り込みで右クリックのメニューの部品（`MapContextMenu.tsx`・`live-context-menu-port.ts`・`mount/hit-test.ts`・`RailContextMenu.tsx`・`rail-menu.ts`）はどれも変わっていない（`635c5c5..99ef92e` の差分に無い）。本体の手直し 2〜4 回目が時刻レールで変えたのは、「この年へ移動して錨を作る」の結果の文を移動の知らせの後ろへ続ける所（`Timeline.tsx` の `stageMoveTrailer`）だけで、8C のボタンつきの知らせ・8A の候補一覧の印とは交わらない。前回の継ぎ目の記録 §(1) の確かめはそのまま成り立つ。
- 単体 `rail-menu`・`MapContextMenu`・`vertex-candidates`・`live-context-menu-port` と、E2E `inc8c-survey`・`inc8a-vertex-density` は通る。

### (4) 8E の詳細パネルの掃除 × 増分 7 の素性欄・終わらせる

- 8E の掃除（`keepPanelsPresent`）は詳細パネルだけを見ていて、選択も素性欄も触らない。終わらせた直後の素性欄は「この地物は1500年で終わっています。」、レールの見出しは「もう」（`inc7-fix2.spec.ts` の B-10 が通る）。詳細パネルが閉じる点は 1-2。
- 詳細文書の下書きは素性欄（`PropertyPanel` の `DetailDocumentSection`）にあり、詳細パネルは読むだけなので、パネルが閉じても打ちかけは失われない。

### (5) 押す前の板と鍵盤の持ち主

- 保存の前の確認の板（#27）は `10fb975` で `useModalRegistration` で名乗るようになり、`modal-registration.test.tsx` の母集合にも入った（出たら名乗り、外れたら取り消す）。K-2 の走査（`inc5-shell.spec.ts` の `IMPACT_BOARDS`）と「板 × 打鍵」（`inc7-fix-ui.spec.ts`）にも載った（`38caaf1`）。終わらせる前の影響の板（#26）・縦横比の板（#30）も両方に載っている。世代の一覧の板（#28）は名乗りの単体だけで、設計書 §B.5 はそのとおりに書いている（前回の 1-3 が文書で片付いている）。
- `FileOpsController` の `modalOpen` には 5 つの板（未保存・修復・上書き・世代の一覧・保存の前の確認）がすべて入り、背面の覆いが出る。
- 単体 `modal-registration`（14 件）と、E2E `inc5-shell`・`inc7-fix-ui` は通る。

### (6) `apply-proposal.ts` の終わりのある錨

- 本体の B76（`applyPastEdit` が効いている錨の終わりを写す）は 9 か所の入口すべてで効いている（`apply-proposal-bounded-end.test.ts` 12 件が通る）。8A の辺への挿入（`applyEdgeInsertToHistories`）も 8B の後ろの錨への引き継ぎ（`carrySplitIntoLaterAnchors`）も、T の時点の錨は `applyPastEdit` を通り、後ろの錨は写しを差し替えるだけで錨の始まり・終わりを変えない（`carryIntoLaterAnchors`）。
- 探針 `seam2-probe\ended.probe.test.ts`（App と同じ確定の口）:
  - (6a) A を 1200 年で終わらせてから、1100 年に共有辺へ頂点を足す: A は `[1100,1200)` で終わり 1300・1700 年に居ない。T 字 0、整合の検査 0 件。
  - (6b) A を 1200 年で終わらせてから、1100 年に共有辺を横切って分ける: 継承先は `[1100,1200)` で終わる。新しい片は終わらない（B77、既知）。T 字 0、整合 0 件（1-3）。
  - (6d) A が 1200 年で終わり 1300 年から再び現れる形で頂点を足す: 1300 年の錨にも頂点が入り、1200 年には居ない。T 字 0、整合 0 件。
- 継承先の後ろの錨と新しい片が重なる件は `docs/現状.md` B81 に載っている。

### (7) 番号の付け替え

- `docs/現状.md`: 本体の B72〜B79 はそのまま、統合側は B80〜B86。コード・E2E の B 番号の注記は B74・B76（本体）と B83（統合）だけで、どれも指す先が合っている。
- 開発ガイド: §5.89（本体）のあと §5.90〜§5.94（8B）・§5.95〜§5.98（8E）。参照（実装計画・現状.md・実装済み.md・`split-geometry.holes.test.ts`・8B と 8E の進捗と審査）は新しい番号で、見出しの中身とも合う。
- 設計書 §B.5 の台帳: #27（保存の前の確認）・#28（世代の一覧）・#29（ズームの上下限の断り）・#30（縦横比）。コード・E2E の注記（`PreSaveConfirmDialog.tsx`・`BasemapAspectDialog.tsx`・`ZoomLimitNote.tsx`・`zoom-limit-note.css`・`App.tsx`・`FileOpsController.tsx`・`modal-registration.test.tsx`・`inc5-shell.spec.ts`・`inc7-fix-ui.spec.ts`・`helpers.ts`）も合う。
- 各進捗の「取り込み」の節（8A §14・8B〜8D §13・8E §14）の古い番号は、その時点の記録として残してあり、付け替え表が添えてある。漏れは 1-5 の言い回しだけ。

---

## 走らせたもの

| 種類 | 対象 | 結果 |
| --- | --- | --- |
| 単体 | `modal-registration`・`repair-option-order`・`RepairDialog`・`repair-flow-interval`・`repair-names`・`file-commands`・`FileOpsController`・`apply-proposal-bounded-end`・`apply-proposal.edge-insert`・`existence-status`・`detail-panels`・`status-message`・`participant-name`・`live-context-menu-port`・`end-here-impact`・`pre-save` | 16 ファイル・242 件 合格 |
| 単体 | `rail-menu`・`MapContextMenu`・`vertex-candidates` | 3 ファイル・52 件 合格 |
| 単体（実データ。`DERLE_TMAP_DIR` は scratchpad の複写） | `end-here-real-data` | 1 件 合格 |
| E2E（`--project=main --workers=2`、実データは同じ複写） | `inc5-shell`・`inc7-fix-ui`・`inc7-fix2`・`inc7-fix3`・`inc8d-recovery`・`inc8c-survey`・`inc8a-vertex-density` | 117 件 合格（1.9 分） |
| 探針（scratchpad。worktree には置いていない） | `fileops.probe.test.ts`（2-1・(1)・(2)・1-1）・`ended.probe.test.ts`（(6)・1-3）・`pw\endhere-detail.probe.spec.ts`（1-2。実物） | 上の各節 |

探針は `C:\Users\asteain-ninia\AppData\Local\Temp\claude\e--WORKSPACE-time-map-app-4\7dc706e1-76cc-4022-8df8-04e559dde326\scratchpad\seam2-probe\` にある（vitest は同じ場所の `vitest.probe.config.mts` を `--config` に、`--root E:/WORKSPACE/time-map-app-4-integ` で走らせる。playwright は `pw` で `node ../node_modules/@playwright/test/cli.js test --config playwright.probe.config.ts`。`node_modules` は worktree へのジャンクション。**探針の場所を消すときは、先にジャンクションを外すこと**（辿って消すと worktree の `node_modules` が消える）。前回の `seam-probe\node_modules` も同じく worktree へのリンク）。
