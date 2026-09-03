執筆: GPT 5.6 Sol（読み取り専用実行）／保存: Opus

# 審査結果

致命 1 件、重 4 件、軽 5 件を確認した。とくに、上書き確認中のファイル切替レースと「読むだけ」から設定を変更できる経路は、増分 1 の安全目的を満たしていない。

## 指摘

### 1. 確認したファイルと実際に保存されるファイルが入れ替わり得る

- **重症度**: 4（致命）
- **ファイル:行**: [FileOpsController.tsx:765](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:765)、[App.tsx:3276](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3276)
- **内容**: `runGuardedSave` は確認前の `savePath` を表示するが、確認後は `contextRef.current` の `needsSaveAs` だけを再評価し、保存先が同じかを検証しない。一方 D&D 読み込みはアプリ全体の root に登録され、上書き確認ダイアログ上の drop も祖先へバブルする。上書き確認は `runExclusive` のラッチを取得しないため、A の確認中に B を drop して読み込み、その後「A を上書きする」を押すと、現在の B に対して `saveCommand` が走る。
- **利用者に起きること**: 画面で確認したパスとは別のファイルを、初回確認なしで上書きする。修復を伴う読み込みなら、B の内容が実際に変更される可能性がある。
- **直し方**: 確認開始時の `SaveContext` または世代番号を保持し、確認後に一致しなければ保存を中止して新しい保存先で確認をやり直す。より安全には、確認開始から保存完了まで同じ file-operation mutex を保持し、D&D・開く・新規・自動保存を止める。

### 2. 自動保存が初回上書き確認を意図的に迂回している

- **重症度**: 3（重）
- **ファイル:行**: [FileOpsController.tsx:851](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:851)、[save-status.test.tsx:165](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/save-status.test.tsx:165)
- **内容**: 自動保存は `runGuardedSave` ではなく直接 `saveCommand` を呼ぶ。読み込み済みファイルは、利用者が一度も保存先を確認していなくてもディスクへ書かれる。追加されたテストも「自動保存が先に `api.save` を実行し、その後の手動保存では確認を出す」挙動を正としている。
- **利用者に起きること**: 利用者が確認ダイアログを見る前に、取り違えた正準ファイルが上書き済みになる。後から確認を表示しても安全確認としては手遅れである。未変更ファイルでも tick ごとに保存される。
- **直し方**: 未確認の既存パスでは自動保存をスキップするか、アプリ専用の復旧ファイルへ保存する。手動確認または Save As で明示的に認可されたパスだけを自動保存可能にし、テストは「確認前に `api.save` が呼ばれない」を期待すべきである。

### 3. 「読むだけ」でもプロジェクト設定と背景地図を変更できる

- **重症度**: 3（重）
- **ファイル:行**: [permissions.ts:28](E:/WORKSPACE/time-map-app-4/src/ui/shell/permissions.ts:28)、[HelpToolsController.tsx:137](E:/WORKSPACE/time-map-app-4/src/ui/help-tools/HelpToolsController.tsx:137)、[SettingsDialog.tsx:71](E:/WORKSPACE/time-map-app-4/src/ui/settings/SettingsDialog.tsx:71)、[useSettingsDialog.ts:192](E:/WORKSPACE/time-map-app-4/src/ui/settings/useSettingsDialog.ts:192)
- **内容**: `ToolsSettings` は全モードで有効とされ、設定ダイアログへ `canEdit` が渡らない。確定すると `updateProjectSetting`、タイムライン範囲、undoable なパレット変更が実行される。背景地図の差し替えボタンも有効である。コード自身がプロジェクト設定更新は dirty-mark すると明記している。
- **利用者に起きること**: 「読むだけ」にしていても世界名、表示・時刻設定、配色、背景地図などが変わり、未保存状態になる。K-6 の「編集経路を一括無効化」が成立しない。
- **直し方**: アプリ共通設定とプロジェクト設定を分離し、View モードではプロジェクト側の入力・保存・背景地図差し替えを無効化する。確定ハンドラでも `canEdit` を再確認する。`CHANGE_PATHS` に設定保存、パレット、背景地図を加え、固定の「10 件」という循環的な検査をやめる。

### 4. アプリバーの高さは名前・道具状態・窓幅で変わる

- **重症度**: 3（重）
- **ファイル:行**: [shell.css:69](E:/WORKSPACE/time-map-app-4/src/ui/shell/shell.css:69)、[shell.css:183](E:/WORKSPACE/time-map-app-4/src/ui/shell/shell.css:183)、[shell.css:197](E:/WORKSPACE/time-map-app-4/src/ui/shell/shell.css:197)、[shell.css:204](E:/WORKSPACE/time-map-app-4/src/ui/shell/shell.css:204)、[SurveyControls.tsx:59](E:/WORKSPACE/time-map-app-4/src/ui/survey/SurveyControls.tsx:59)
- **内容**: アプリバー行は `auto` 高で、`.app-shell__topbar`、経度シフト、階層、測量が `flex-wrap: wrap` を使う。新設の identity は `flex: 0 0 auto` で、短い名前から最大 360px まで占有幅が変わる。測量では active・確定線の有無によってクリア、ガイド、読取部品が増減する。B.4 が要求する「1 段固定」「窓幅だけで決まる畳み」と逆である。
- **利用者に起きること**: 長い世界名・ファイル名、測量の ON/OFF、線のクリア、窓幅の閾値でバーが折り返し、地図の上端と高さが変わる。実装報告自身もアプリバー折返しによる約 31px、全体約 74px の縮小を記録している。
- **直し方**: アプリバーを固定高・`nowrap` にし、B.4 の窓幅ブレークポイントで部品を畳む。identity に固定した割当幅を与え、測量の可変表示はオプションバー／状態行へ移す。K-3 E2E に複数窓幅、長い世界名・ファイル名、測量 ON/OFF を追加する。

### 5. 古いファイルの保存完了が、新しく開いたファイルの「最終保存」になる

- **重症度**: 3（重）
- **ファイル:行**: [FileOpsController.tsx:569](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:569)、[FileOpsController.tsx:583](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:583)、[FileOpsController.tsx:645](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:645)
- **内容**: 保存中に別プロジェクトを読み込んだ場合、保存先の反映には context identity のガードがある。しかし `savedAtMsRef` の更新、`publishSaveStatus()`、「保存しました」の結果通知はガード外にある。読み込み側が時刻と結果をクリアした後でも、古い保存完了がそれらを再設定する。
- **利用者に起きること**: B を開いた直後に「B は今保存された」「保存しました（A）」に相当する矛盾した状態が表示される。利用者が B を保存済みと誤認して終了するおそれがある。`document.title` の保存先は identity guard により A へ戻らない。
- **直し方**: 保存開始世代と現在世代が一致する場合だけ、現在文書の最終保存時刻と結果を更新する。別文書の保存結果を残す必要があるなら、ファイル名付きの別イベントとして扱い、現在文書の `lastSavedAt` には流用しない。

### 6. 「直前の結果」は保存経路しか結線されていない

- **重症度**: 2（軽）
- **ファイル:行**: [App.tsx:572](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:572)、[App.tsx:2004](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:2004)、[App.tsx:3305](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3305)、[FileOpsController.tsx:730](E:/WORKSPACE/time-map-app-4/src/ui/file-ops/FileOpsController.tsx:730)
- **内容**: `StatusMessageStore` は `FileOpsController` にしか渡されておらず、全編集を集約する `recordCommand` は結果を発行しない。追加、編集、削除、所属変更、undo/redo、各種拒否理由は状態行へ出ない。ファイル操作も詳細な失敗理由は引き続き `globalThis.alert` へ送り、自動保存の `false` は状態行へ反映しない。また undo は `lastLabel: null` 固定で操作名を出さない。
- **利用者に起きること**: 状態行が「まだ何もしていません」または古い保存結果のままになり、H.5 の「成功・失敗の唯一の常設場所」にならない。失敗時には禁止された OS 警告が残る。
- **直し方**: `recordCommand`、undo/redo、ドメイン拒否、ファイル I/O の共通結果 port を作り、成功・失敗を `StatusMessageStore` に集約する。`alert` は重大な確認だけに限定する。履歴には日本語の操作名と対象名を保持して undo 表示へ渡す。

### 7. 地図上の DOM 操作帯がクリックを奪い、E2E はそこを避けるよう変更された

- **重症度**: 2（軽）
- **ファイル:行**: [scene-layout.ts:4](E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/scene-layout.ts:4)、[scene-layout.ts:46](E:/WORKSPACE/time-map-app-4/e2e/__bughunt__/scene-layout.ts:46)、[knife.css:55](E:/WORKSPACE/time-map-app-4/src/ui/knife/knife.css:55)、[shell.css:1253](E:/WORKSPACE/time-map-app-4/src/ui/shell/shell.css:1253)
- **内容**: 追加・ナイフ・結合などの確定操作帯は地図下端中央に絶対配置され、`pointer-events: auto` である。新しい E2E 共通 helper は、この帯が入力を「eat」することを明記し、上下の帯を避ける位置へ図形を縮小・移動する。
- **利用者に起きること**: 地図下部中央へ頂点や切り線を置こうとすると、確定・取消ボタンにクリックを奪われる。地図縮小後は相対的な占有率も増えている。
- **直し方**: B.5 のとおり確定部品を新設したオプションバーへ移す。移行まで残す場合も、地図を格子走査する hit-test を追加し、意図したボタン矩形以外では必ず入力層が返ることを検査する。E2E は単に帯を避けるだけにしない。

### 8. 診断ログ表示はロガーを購読していない

- **重症度**: 2（軽）
- **ファイル:行**: [log.ts:84](E:/WORKSPACE/time-map-app-4/src/ui/discovery/log.ts:84)、[HelpToolsController.tsx:595](E:/WORKSPACE/time-map-app-4/src/ui/help-tools/HelpToolsController.tsx:595)
- **内容**: `DiagnosticLogger` は `snapshot()` しか持たず、listener／version がない。`DiagnosticsView` が購読しているのは地物数、dirty、時刻だけで、ログ追加そのものでは再描画されない。
- **利用者に起きること**: 診断画面を開いたまま新しいエラーが発生しても、別の Zustand 状態が変わるまでログ欄へ現れない。「N-34 を直した」は初期スナップショットについてのみ成立する。
- **直し方**: logger に `subscribe/getSnapshot` を追加し、`useSyncExternalStore` で購読する。`clear()` でも通知し、購読解除を返す。

### 9. `registerOptionSlot` の古い cleanup が新しい登録を消す場合がある

- **重症度**: 2（軽）
- **ファイル:行**: [option-bar.ts:141](E:/WORKSPACE/time-map-app-4/src/ui/shell/option-bar.ts:141)、[option-bar.test.ts:131](E:/WORKSPACE/time-map-app-4/src/ui/shell/option-bar.test.ts:131)
- **内容**: cleanup の所有権を `mine.node !== node` で判定している。同じ id を同一の文字列・ReactNode インスタンスで再登録すると、古い cleanup から新しい登録を区別できない。テストは `'A'` から `'B'` への変更しか扱わない。
- **利用者に起きること**: 道具切替時の遅延 cleanup により、新しい道具が登録した吸着・深さ等の設定部品が突然消える。
- **直し方**: 登録ごとに `Symbol` または連番 token を発行し、slot に token を保存する。cleanup は node equality ではなく token identity で所有権を確認する。同じ node で再登録するテストを追加する。

### 10. 「完了報告」「受け入れ条件すべて○」は自己矛盾している

- **重症度**: 2（軽）
- **ファイル:行**: [増分1.md:1](E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分1.md:1)、[増分1.md:29](E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分1.md:29)、[増分1.md:55](E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分1.md:55)、[増分1.md:206](E:/WORKSPACE/time-map-app-4/docs/ui-redesign/進捗/増分1.md:206)
- **内容**: 文書は「完了報告」「すべて○」とする一方、探索的バグ狩り欄は未記入で、末尾も「再開時の第一歩は全件ゲートと探索」としている。計画 §1 の半日探索、とくに「読むだけ」の全経路確認は未実施であり、実際に設定経路を落としている。最終全件ゲートの成功も記録されていない。
- **利用者に起きること**: レビュー担当・リリース担当が、未完了の安全検査を完了済みとして扱う。
- **直し方**: 状態を「作業中」に戻し、全件ゲートと実データ探索を実施する。実行日時・commit・件数を記録し、K-6、上書き、自動保存、窓幅の反証ケースを追加してから○にする。本レビューでは全件ゲートの成否は**未確認**。

## 問いへの回答

1. コードで裏付けられない自己申告は、主に「完了」「受け入れ条件すべて○」「K-6 の全経路を塞いだ」「N-34 を完全に直した」「K-3 を満たした」である。固定枠、通常の Ctrl+S 確認、タイトル更新、ツールチップの `pointer-events: none` 自体は実装されている。

2. 「読むだけ」の関門には設定保存、パレット変更、背景地図差し替えという抜け道がある。

3. 通常の地物選択と長い選択地物名は、個別フォーカスが固定幅なので現時点では高さを変えにくい。一方、長い世界名・ファイル名、dirty 印、測量状態、確定線の有無、窓幅は折返し入力になる。

4. 新設オプションバーとツールチップはクリックを奪わない。ただし既存の地図内確定帯は実際にクリックを奪い、E2E helper もそれを前提に回避している。

5. ファイル名・dirty・世界名・通常の `document.title` は Zustand 購読と effect 依存が揃っている。漏れは、保存／読み込みレース時の最終保存時刻と結果、保存以外の直前結果、undo の操作名、自動保存失敗である。

6. assertion を削除・緩和した変更は確認できなかった。ただし、自動保存の確認迂回を正として追加した単体テストと、地図内 DOM 帯を避けるよう入力座標を変更した E2E がある。後者は結果の期待値ではなく入力を実装へ合わせた変更で、約 74px の地図縮小と K-2 問題を回帰として検出しなくなっている。

7. 新設 `useSyncExternalStore`、自動保存 listener、変更された Zustand `subscribe` には解除処理があり、明白な listener leak は見つからなかった。問題は診断 logger の未購読と option slot cleanup の所有権判定である。コミット範囲に Electron main/preload/IPC 契約の変更はなく、追加された `getProjectStats` は renderer 内の読み取り専用観測である。本番プロセスへ `--tmap-e2e-harness` を外部から直接注入した場合まで遮断できるかは**未確認**。

## 総合判定

**revise**
