執筆: GPT 5.6 Sol（読み取り専用実行）／保存: Sonnet

指定された履歴・差分と現行ファイルを、git を使わず静的に照合した。固定行シェル、鍵＋道具一段、選択維持の基本方針は概ね反映されているが、入力所有権と状態遷移にリリース前修正が必要な問題が残っている。

### 指摘

1. **重要度 3／[src/ui/state/store.ts:1756](E:/WORKSPACE/time-map-app-4/src/ui/state/store.ts:1756)**

   - 内容: `surveyEnable()` は `activeTool` を `null` にする一方、道具から導出すべき `mode` を更新しない。テストも「mode を保つ」と旧契約を固定している（[store.survey.test.ts:48](E:/WORKSPACE/time-map-app-4/src/ui/state/store.survey.test.ts:48)）。
   - 利用者に起きること: `面を描く` 中に測量を開始・終了すると、画面上は「選ぶ」なのに内部は `Add` のままになる。左クリックは追加経路へ送られるが追加 controller は存在せず、選択も追加もできない状態になる。
   - 直し方: `surveyEnable()` で `activeTool: null` と同時に `modeForTool(locked, null)` を設定する。`add.area → 測量ON → OFF → 地図クリック` で Edit に戻り選択できる結合テストを追加する。

2. **重要度 3／[src/ui/map/mount/hit-test.ts:143](E:/WORKSPACE/time-map-app-4/src/ui/map/mount/hit-test.ts:143)**

   - 内容: 読むだけでも編集時と同じ `liveHitTestAt()` を使用し、全頂点と active feature の辺中点を優先して返す（[live-hit-test.ts:1143](E:/WORKSPACE/time-map-app-4/src/ui/map/live-hit-test.ts:1143)、[live-hit-test.ts:1192](E:/WORKSPACE/time-map-app-4/src/ui/map/live-hit-test.ts:1192)）。一方、View ではハンドルを描画しない（[render.ts:180](E:/WORKSPACE/time-map-app-4/src/ui/map/mount/render.ts:180)）。
   - 利用者に起きること: 見えていない頂点付近をクリックすると地物ではなく頂点が選ばれる。辺中点では選択が変わらない場合もあり、「見えているものを選ぶ」という View の操作と食い違う。
   - 直し方: View のヒット結果では `Vertex` と `Edge` を所有地物の `FeatureBody` に正規化するか、View 専用の body-only hit-test を設ける。頂点座標・辺中点を直接クリックするテストが必要。

3. **重要度 3／[src/ui/shell/MenuBar.tsx:21](E:/WORKSPACE/time-map-app-4/src/ui/shell/MenuBar.tsx:21)**

   - 内容: 標準メニューバーの `openKey` は component 内に閉じており、`focusOwner` へ開閉を通知しない。[focus-owner.ts:54](E:/WORKSPACE/time-map-app-4/src/ui/shell/focus-owner.ts:54) はメニューバーを `Modal` に含める契約だが、[AppShell.tsx:133](E:/WORKSPACE/time-map-app-4/src/ui/shell/AppShell.tsx:133) に配線がない。
   - 利用者に起きること: メニューを開いたまま Ctrl+Z/Delete を押すと背後の地図が編集される。Escape も大域 listener が先に動き、選択解除とメニュー閉鎖が一度に起こり得る。
   - 直し方: `MenuBar` に `onOpenChange` を追加して `focusOwner` の modal/menu 入力へ統合する。Escape はメニュー側で capture し、伝播も停止する。

4. **重要度 3／[src/ui/add/SnapOptions.tsx:69](E:/WORKSPACE/time-map-app-4/src/ui/add/SnapOptions.tsx:69)**

   - 内容: 「吸着 ▾」だけが共通 `OptionPopover` を使わず、ローカル `open` を持つ。props に `onOpenChange` がなく、登録元も開閉を報告しない（[AddToolController.tsx:615](E:/WORKSPACE/time-map-app-4/src/ui/add/AddToolController.tsx:615)）。
   - 利用者に起きること: 板を開いても `focusOwner` が Map または ToolDrawing のままになり、Ctrl+Z/Delete、道具の単キー、場合によっては保存・新規・開くが背後で実行される。
   - 直し方: 共通 `OptionPopover` へ移行するか、`onOpenChange={popoverOpenChange('snap')}` を渡す。下書き0点と1点以上の両方でキー遮断を検査する。

5. **重要度 3／[src/ui/App.tsx:2119](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:2119)**

   - 内容: `MergeOptionsDialog` や `InheritorModal` など実際のモーダルが `modalOwnsKeyboard` に含まれず、対象を持つという理由だけで `ToolDrawing` に分類される（[MergeToolController.tsx:229](E:/WORKSPACE/time-map-app-4/src/ui/merge/MergeToolController.tsx:229)、[MergeOptionsDialog.tsx:73](E:/WORKSPACE/time-map-app-4/src/ui/merge/MergeOptionsDialog.tsx:73)、[InheritorModal.tsx:102](E:/WORKSPACE/time-map-app-4/src/ui/knife/InheritorModal.tsx:102)）。
   - 利用者に起きること: モーダル表示中でも ToolDrawing に許可された Ctrl+S/Ctrl+Shift+S/Ctrl+N/Ctrl+O が背後で実行される（[App.tsx:3368](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3368)）。プロパティ入力や継承先選択の途中でファイル操作へ移れる。
   - 直し方: 各 controller から「下書き」と「モーダル」を別々に報告し、実モーダルは必ず最優先の `Modal` にする。boolean 群より overlay owner の集中 registry が安全。

6. **重要度 3／[src/ui/shell/focus-guard.ts:45](E:/WORKSPACE/time-map-app-4/src/ui/shell/focus-guard.ts:45)**

   - 内容: 設計書 §D.4 が明示する `input[type=range]` の focus guard を除外している。テストも range を非ガード対象として固定している（[focus-guard.test.ts:43](E:/WORKSPACE/time-map-app-4/src/ui/shell/focus-guard.test.ts:43)）。
   - 利用者に起きること: 深さ、透明度、経度シフトなどのスライダーに焦点がある状態で Ctrl+Z/Delete を押すと、背後の地物や履歴が操作される。
   - 直し方: 「文字編集可能か」と「大域 shortcut を遮断する control か」を別 predicate にし、range を後者へ含める。Escape で blur する契約も追加する。

7. **重要度 3／[src/ui/shell/useToolBarChrome.ts:55](E:/WORKSPACE/time-map-app-4/src/ui/shell/useToolBarChrome.ts:55)**

   - 内容: `pushedRef` は各 controller のローカル印であり、共有 commit/nextStep チャンネルの現在所有者を確認しない。旧 controller の inactive effect が、新 controller の書き込み後に無条件で `setCommit([])` できる。
   - 利用者に起きること: controller の配置順（[App.tsx:3002](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:3002)）と逆向き、例えば「穴あけ → ナイフ」に切り替えると、ナイフの次の一手・確定欄が消え、次の state 更新まで戻らない。
   - 直し方: commit/nextStep に owner token を持たせ、現在の token と一致する controller だけが解除できるようにする。全道具間の正順・逆順切替を table-driven test にする。

8. **重要度 3／[src/ui/knife/KnifeToolController.tsx:210](E:/WORKSPACE/time-map-app-4/src/ui/knife/KnifeToolController.tsx:210)**

   - 内容: 手順型5道具の cancel が `clearSelection()` と `setActiveTool(null)` を一度に実行する。同じ実装が [MergeToolController.tsx:178](E:/WORKSPACE/time-map-app-4/src/ui/merge/MergeToolController.tsx:178)、[ReparentToolController.tsx:175](E:/WORKSPACE/time-map-app-4/src/ui/reparent/ReparentToolController.tsx:175)、[RingEditToolController.tsx:168](E:/WORKSPACE/time-map-app-4/src/ui/ring-edit/RingEditToolController.tsx:168)、[DrillToolController.tsx:167](E:/WORKSPACE/time-map-app-4/src/ui/drill/DrillToolController.tsx:167) にある。コメント自身も §D.4 の Escape 階段との不一致を認めている。
   - 利用者に起きること: Escape 1回で「手順対象」「元からの選択」「道具」の三段がまとめて失われる。特に結合・所属変更では、tool-owned と保証されていない事前選択まで消える。
   - 直し方: Escape はまず道具内部の対象・点列だけを戻し、道具は保持する。内部状態が空になった後の Escape を大域の頂点→地物→道具解除へ渡す。5道具すべてで一段ずつ検査する。

9. **重要度 3／[src/ui/state/store.ts:639](E:/WORKSPACE/time-map-app-4/src/ui/state/store.ts:639)**

   - 内容: 頂点選択を破棄する条件が「直前の `activeTool` が厳密に `EditVertex`」だけになっている。しかし `null`/Select/Move でも頂点・辺ハンドルを掴める（[tools.ts:139](E:/WORKSPACE/time-map-app-4/src/ui/shell/tools.ts:139)）。
   - 利用者に起きること: 「選ぶ」や「動かす」で頂点を選び、その後ナイフや追加道具へ替えると、頂点選択が不可視のまま残る。新道具がまだ下書きを持たない局面で Delete を押すと、以前の頂点が削除対象になり得る。
   - 直し方: `toolShowsVertexHandles(previous) && !toolShowsVertexHandles(next)` など capability の遷移で破棄する。Select/null/Move 起点の回帰テストを追加する。

10. **重要度 2／[src/ui/App.tsx:1962](E:/WORKSPACE/time-map-app-4/src/ui/App.tsx:1962)**

   - 内容: ナイフだけ確定成功後に `setActiveTool(null)` を呼ぶ。他の4手順道具は道具を保持して次の対象待ちへ戻る。
   - 利用者に起きること: 分断を連続して行う場合だけ、毎回ナイフを選び直す必要がある。設計書 §D.2 の「道具を持ったまま」と、確定後挙動の統一に反する。
   - 直し方: commit 後に Knife hook を対象選択待ちへ再武装し、`activeTool` を保持する。確定直後の Ctrl+Z が大域履歴へ届くことも同時に検査する。

11. **重要度 2／[src/ui/knife/KnifeToolController.tsx:717](E:/WORKSPACE/time-map-app-4/src/ui/knife/KnifeToolController.tsx:717)**

   - 内容: 確定列移設が全状態へ適用されていない。ナイフの拒否 panel は地図上に残り、`pointer-events:auto` でクリックを奪う（[knife.css:172](E:/WORKSPACE/time-map-app-4/src/ui/knife/knife.css:172)）。所属変更の案内・拒否文も地図上に表示される（[ReparentToolController.tsx:443](E:/WORKSPACE/time-map-app-4/src/ui/reparent/ReparentToolController.tsx:443)）。穴あけにも地図上の拒否ボタンが残るが、親の `pointer-events:none` により押せない（[DrillToolController.tsx:423](E:/WORKSPACE/time-map-app-4/src/ui/drill/DrillToolController.tsx:423)、[drill.css:6](E:/WORKSPACE/time-map-app-4/src/ui/drill/drill.css:6)）。
   - 利用者に起きること: 道具によって拒否表示の位置と操作可否が異なり、ナイフでは地図クリックも遮られる。
   - 直し方: 案内・拒否・取消をすべてオプションバーへ集約する。地図側には hidden の観測 marker と必要なモーダル／入力 bridge だけを残す。

12. **重要度 2／[src/ui/map/PointerDispatcher.ts:363](E:/WORKSPACE/time-map-app-4/src/ui/map/PointerDispatcher.ts:363)**

   - 内容: click/drag 判定を `pointerMove` でしか更新せず、`pointerUp` の最終座標と押下座標を比較しない。これは [dispatch.ts:173](E:/WORKSPACE/time-map-app-4/src/ui/map/dispatch.ts:173) の「press→release の総移動量」契約と異なる。
   - 利用者に起きること: 最終移動 sample が欠落・統合された場合、4px以上動かした操作がクリックとして扱われ、View では release 地点の地物を選択する。実機での発生頻度は**未確認**。
   - 直し方: `pointerUp` 冒頭でも閾値を再計算し、Pan なら最終位置を書き込む。`down→moveなし→離れた座標でup` の単体テストを追加する。

13. **重要度 2／[src/ui/shell/view-only-gate.test.tsx:254](E:/WORKSPACE/time-map-app-4/src/ui/shell/view-only-gate.test.tsx:254)**

   - 内容: 「右クリック」は `composeContextMenu` 単体、「どこへでも移動」は `resolveCommandEnabled` 単体だけを検査している（[view-only-gate.test.tsx:425](E:/WORKSPACE/time-map-app-4/src/ui/shell/view-only-gate.test.tsx:425)）。実 UI がその関門を経由していることは検証していない。
   - 利用者に起きること: composition root が `registry.dispatch` を直に呼ぶ、という過去と同じ迂回が再発してもテストは通る。
   - 直し方: 実際に context menu／Jump UI を開き、View では handler が呼ばれず、Edit では1回呼ばれるところまで検査する。

14. **重要度 2／[e2e/inc5-shell.spec.ts:540](E:/WORKSPACE/time-map-app-4/e2e/inc5-shell.spec.ts:540)**

   - 内容: K-2 の25点走査は Ring/Drill を省き、手順開始・拒否・ダイアログなど状態遷移後も走査しない。popover 走査も Depth/Survey だけで Snap/Display を含まない（[inc5-shell.spec.ts:572](E:/WORKSPACE/time-map-app-4/e2e/inc5-shell.spec.ts:572)）。
   - 利用者に起きること: 指摘4・11のような、特定道具／特定局面だけ地図を覆う回帰を受け入れテストが検出できない。
   - 直し方: §B.5 の overlay 台帳をそのまま table 化し、全道具・全 overlay の hidden/open/拒否局面を5×5走査する。

15. **重要度 2／[e2e/inc5-shell.spec.ts:192](E:/WORKSPACE/time-map-app-4/e2e/inc5-shell.spec.ts:192)**

   - 内容: 「地図は再マウントされない」というテストがカメラ値の維持しか確認していない。カメラは外部 store にあるため、MapContainer が再マウントされても同じ値を復元でき、このテストは通る。
   - 利用者に起きること: 現時点の JSX 配置は安定して見えるが、将来 remount により Canvas・入力 session・一時 preview が失われても検出できない。
   - 直し方: `onMount` 回数、mount generation、または同一 DOM node handle を保持して、帯・sidebar・resize の前後で identity が同じことを直接検査する。

固定行の DOM 構造、800px 幅の固定列、`enterAddMode()` の「鍵を開けて面道具を押す」への変更、表示条件変更時の地物選択維持については要件との不整合を確認しなかった。ただし、上記の重要度3、とりわけ mode 不整合・入力所有権漏れ・オプションバーの effect 順序依存が受け入れを妨げる。

**総合判定: revise**
