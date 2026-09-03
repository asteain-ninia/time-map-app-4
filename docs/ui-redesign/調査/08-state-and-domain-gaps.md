# 08 UI ストアと、ドメインにあるが UI から届かない機能

対象コミット: `0956160`（master、作業ツリーはクリーン）。調査日 2026-09-03。
調査範囲: `src/ui/state/*`、`src/domain/**/index.ts` の公開名、`src/ui` からの参照。
ソースは一切変更していない。ビルドも実行していない。

---

## 0. 調べ方と、その限界

機械的に数えた手順は次のとおり。再現用のスクリプトは一時領域に置いてある（成果物には含めない）。

1. `src/domain` 配下の `index.ts`（＝公開の窓口）25 個から、公開されている名前を全部取り出した。**1,180 個**（うち型だけのものを除いた実体は **759 個**）。
2. その 759 個それぞれを、`src/ui` 配下の `.ts` / `.tsx`（テストを除く）で単語単位に検索した。
3. `src/render` / `src/shell` も同じように検索し、さらに「ドメインの中で、UI から届いている関数に使われているか」を推移的にたどった（呼ばれている関数が定義されているファイルを起点に、そのファイルが使う名前へ次々と広げる）。
4. 結果、どこからも届いていない（テストからしか参照がない）**271 個**を「孤立」として全数を付録に並べた。

**限界（そのまま鵜呑みにしないでほしい点）**

- 検索は「単語が現れるか」で判定している。コメントの中に名前が書いてあるだけでも「参照あり」と数える。したがって **「参照あり」は過大**、**「孤立」は過少**になる方向の誤差がある。逆に言うと、孤立と判定された 271 個は「本当に一度も書かれていない」ので、こちらの側の判定は堅い。
- 推移的なたどりは**ファイル単位**で行った。同じファイルの中に届いている関数が 1 つでもあれば、そのファイルの他の関数も「内部経由で届きうる」と甘く見ている。だから「孤立」と出たものは、その意味でも堅い。
- 「孤立していない＝UI で意味のある操作になっている」ではない。あくまで**コード上の到達性**の話。

---

## 1. ストアの形 —— どの状態がどこにあるか

### 1.1 全体像

状態は 4 か所に分かれている。**ストアが唯一の真実源というわけではない**。

| 置き場所 | 何が入っているか | 実体 |
| --- | --- | --- |
| ① セッションストア（zustand/vanilla） | ドメイン状態への参照＋UI/セッション状態 24 項目 | `src/ui/state/store.ts:145` 以降（`SessionStoreState`） |
| ② React のローカル状態（`useState`） | ダイアログの開閉、各ツールが「今描いている最中か」の旗、詳細パネルの一覧、競合解決の途中状態 | `src/ui/App.tsx` に 14 個（`463`, `2733`, `2755`〜`2779`, `2977` 行など） |
| ③ React の `useRef` | **アンドゥ履歴そのもの**、各種ポート、前回値の記憶。`App.tsx` に 25 個 | `src/ui/App.tsx:1891`（`historyRef`）ほか |
| ④ モジュール内のキャッシュ | 描画・判定用の派生結果（LRU） | `src/ui/map/committed-features.ts:224`、`display-resolution-cache.ts:196`、`filtered-display.ts:125`、`live-lookup.ts` |

**再設計で効く事実**: アンドゥ履歴は `useRef` の中にあり、画面を更新するために `setHistoryVersion` というダミーの状態を増やしている（`src/ui/App.tsx:1920-1922`）。履歴の内容（何回戻せるか、直前の操作名）は現在どこにも表示されていない。履歴をストア側に移せば「元に戻す一覧」や「直前の操作名の表示」がそのまま作れる。

### 1.2 セッションストアが持っている状態（24 項目）

`src/ui/state/store.ts` の `SessionStoreState`。行番号は同ファイル。

| 行 | 名前 | 内容 | 主にどの画面が読むか |
| --- | --- | --- | --- |
| 150 | `domain` | ドメイン状態（プロジェクト全体の不変値）への参照 | すべて |
| 160 | `selection` | 選択状態（アクティブ地物＋頂点集合） | 地図・プロパティ欄 |
| 162 | `activeFeature` | 現在の対象地物 | プロパティ欄・一覧 |
| 164 | `vertexSelection` | 頂点選択の文脈（どの地物の頂点か） | 地図 |
| 167 | `mode` | 編集モード（表示／編集／追加…） | ツールバー |
| 168 | `activeTool` | 選択中のツール | ツールバー |
| 171 | `currentTime` | 現在時刻 | タイムライン・地図・一覧 |
| 172 | `lastTimeChangeSource` | 時刻が何によって変わったか | 再描画の判断 |
| 173-174 | `timelineMin` / `timelineMax` | タイムラインの範囲 | タイムライン |
| 177 | `camera` | 拡大率・位置 | 地図 |
| 179 | `centerLon` | 中心経度（世界端の折り返し用） | 地図 |
| 189 | `displayControl` | 階層深度の表示制御（全体深度・個別フォーカス） | 地図・一覧 |
| 201 | `survey` | 測量モードの状態（確定線・下書き） | 測量ツール |
| 214 | `filter` | 表示フィルタ（種別／深度／個別の表示・不透明度・強調） | 表示フィルタ欄・地図・一覧 |
| 217-218 | `projectSettings` / `appSettings` | 設定（プロジェクト単位／アプリ単位） | 設定ダイアログ |
| 224 | `projectDirty` | 未保存の変更があるか | タイトル・終了確認 |
| 226 | `lastSettingsChange` | 直近の設定変更 | 設定の反映 |
| 237 | `basemapReplaceNonce` | 背景地図が差し替わったことの通知用カウンタ | 地図の再読み込み |

### 1.3 ストアの操作（44 個）と、呼ばれていない 4 個

44 個のうち **40 個は UI から呼ばれている**。呼ばれていないのは次の 4 個だけ。

| 操作 | 定義 | 判定 |
| --- | --- | --- |
| `toggleVertexSelection` | `store.ts:303` | **重複**。Shift+クリックによる頂点の加除は `src/domain/selection/reducer.ts:186` の `shiftHeld` 経路で実現していて（`src/ui/map/live-selection-port.ts:114`）、こちらは使われていない。FR-80 の機能自体は生きている。 |
| `addVerticesToSelection` | `store.ts:305` | 同上の重複。矩形選択も上記の reducer 経由。 |
| `setTimelineRange` | `store.ts:339` | **重複**。設定ダイアログは `setProjectTimelineRangeYears`（`store.ts:421`、`src/ui/settings/useSettingsDialog.ts`）を使う。年より細かい粒度で範囲を動かす入口が無いだけ。 |
| `setFocusOrigin` | `store.ts:353` | **重複**。個別フォーカスは `setDisplayFocus` でまとめて設定している（`src/ui/App.tsx`, `src/ui/map/GlobalDepthControl.tsx`）。 |

つまり**ストアの設計にはほとんど無駄がなく、作り直しの足かせにはならない**。問題はストアの外（後述）にある。

### 1.4 UI とドメインの境界

`src/ui/state/store.ts` の冒頭コメント（1-20 行）が境界を宣言している。要約すると:

- ストアは**ドメインの真実を作らない・書き換えない**。ドメインの更新はコマンド（`src/domain/command`）を通し、ストアは**結果として出てきた新しい不変値と `CommandResult` を受け取り**、そこから選択状態を再解決するだけ（`applyCommandResult`, `store.ts:252`）。
- 「その時刻に存在するか」の判定は**注入**（`src/ui/state/existence.ts`）。ストアは中身を知らない。
- ストアは下書き・プレビューを持たない。モード／ツール／選択のクリア時に走る**リセットの入口だけ**を提供し、実際の破棄は各ツール側が行う。
- ストアは `zustand/vanilla` の上に建っていて React に依存しない。Canvas はストアだけを購読し、React の再描画経路には乗らない。

**再設計で効く事実**: この境界は React を前提にしていない。**画面の作り（React コンポーネントの構成）を全部捨てても、ストアとドメインはそのまま使える**。

---

## 2. ドメインにあるのに UI から呼ばれない公開関数（全数）

### 2.1 集計

| 区分 | 件数 |
| --- | --- |
| ドメインの公開名（型を含む） | 1,180 |
| うち実体（型でないもの） | 759 |
| UI から直接参照あり | 315 |
| render / shell からのみ参照あり | 33 |
| ドメイン内部で、届いている関数から使われている | 140 |
| **どこからも届いていない（孤立）** | **271** |

271 件の内訳（分類は筆者の判断）:

| 分類 | 件数 | 意味 |
| --- | --- | --- |
| **欠落** | 23 | UI に載せれば利用者に見える機能になる |
| 別経路 | 92 | 同じ目的を UI は別の関数で果たしている（下位部品・並行実装） |
| 定数 | 87 | 判別子・メッセージ文言・既定値。UI が別の文言／定数を使っている |
| スキーマ | 25 | 保存形式の検証部品。親スキーマ経由で動いている |
| 別名 | 16 | `src/domain/index.ts` が付けた別名だけが未使用。本体は UI から使われている |
| 検査 | 14 | 反証テスト用・性能計測用。UI に載せる性質のものではない |
| 部品 | 14 | 値を差し替えるだけの小関数など |

### 2.2 UI に載せる価値がある 23 件（＋ 結線してはいけない参考 1 件）

各行の「UI に載せるとどんな操作になるか」は 1 文。根拠は定義位置と要件 ID。

| # | 関数 | 定義 | 要件 | UI に載せるとどんな操作になるか | 現状.md |
| --- | --- | --- | --- | --- | --- |
| 1 | `lineLengthKm` | `src/domain/geo/geodesy.ts:93` | FR-19 | 線を選ぶとプロパティ欄に「長さ ○○ km」が面積と同じ形の読み取り専用行として出る。 | R1 |
| 2 | `withKindLabel` | `src/domain/feature.ts:326` | FR-40 | 地物の追加フォームとプロパティ欄に「種別（国・州・郡…）」の入力欄が増える。 | R5 |
| 3 | `defaultDirectDomainName` | `src/domain/promotion/direct-domain.ts:52` | FR-37 | 所属変更の確定前に「直轄領の名前」欄が出て、既定の「〈元名〉 直轄領」を上書きできる。 | R4 |
| 4 | `decideBasemapReplacement` | `src/domain/basemap/format.ts:278` | FR-04 | 背景地図を差し替えたとき、2:1 でない画像を自動補正するか、無理ならプリセットへ戻すかを決めて通知する。 | — |
| 5 | `isFormatAdequate` | `src/domain/basemap/format.ts:151` | FR-04 | 差し替え画像が正距円筒（2:1）として妥当かを判定して、ダイアログに可否を出す。 | — |
| 6 | `isCorrectable` | `src/domain/basemap/format.ts:166` | FR-04 | 「2:1 から少しずれているので自動補正できます」と提示する。 | — |
| 7 | `correctedDimensions` | `src/domain/basemap/format.ts:190` | FR-04 | 補正後の縦横サイズをプレビューに出す。 | — |
| 8 | `aspectRatio` | `src/domain/basemap/format.ts:146` | FR-04 | 差し替え画像の縦横比を数値で表示する。 | — |
| 9 | `basemapNotice` | `src/domain/basemap/messages.ts:34` | FR-04 | 差し替え結果（採用／補正して採用／プリセットへ戻した）の日本語通知を出す。 | — |
| 10 | `formatLatDms` | `src/domain/survey/coords-format.ts:132` | FR-16 | 測量モードのクリック地点の緯度を「北緯 35°41′21.84″」形式でも出す。 | — |
| 11 | `formatLonDms` | `src/domain/survey/coords-format.ts:144` | FR-16 | 同じく経度を度分秒で出す。 | — |
| 12 | `toDmsParts` | `src/domain/survey/coords-format.ts:101` | FR-16 | 度分秒を度・分・秒に分けて表示する（繰り上がり処理込み）。 | — |
| 13 | `shiftToLonDelta` | `src/domain/basemap/longitude-shift.ts:45` | FR-12 | 経度シフトのスライダーを「ズーム倍率によらず画面上の移動量が一定」に変える。 | — |
| 14 | `isLatitudeEmphasized` | `src/domain/basemap/grid.ts:100` | FR-13 | 緯線グリッドの 10 度ごとなどを太線で強調表示する。 | — |
| 15 | `isLongitudeEmphasized` | `src/domain/basemap/grid.ts:104` | FR-13 | 同じく経線の強調表示。 | — |
| 16 | `validateCandidate` | `src/domain/ring-edit/commands.ts:144` | FR-25 | 穴・飛び地の候補形状を、確定前にその場で「この形は作れません」と赤く出す。 | — |
| 17 | `moveRingVertex` | `src/domain/ring-edit/commands.ts:371` | FR-25 | 穴・飛び地の頂点を動かすとき、包含・非交差の破れをその場で拒否する。 | — |
| 18 | `addRingVertex` | `src/domain/ring-edit/commands.ts:392` | FR-87 | 穴・飛び地の辺ハンドルから頂点を足すとき、同じ拒否判定を通す。 | — |
| 19 | `deleteRingVertex` | `src/domain/ring-edit/commands.ts:420` | FR-88 | 穴・飛び地の頂点を消すとき、3 点未満ならリングごと畳む判定を通す。 | — |
| 20 | `manualColorsOnDisable` | `src/domain/coloring/style-permission.ts:55` | FR-100 | 自動配色をオフにしたとき、既定色へ戻さず「そのとき塗られていた色」を手動色として残す。 | — |
| 21 | `judgeDeletion` | `src/domain/deletion/eligibility.ts:124` | FR-41 | 削除の前に「他の地物から参照されているので消せません」と理由つきで止める。 | — |
| 22 | `isDeletable` | `src/domain/deletion/eligibility.ts:169` | FR-41 | 削除ボタンを可否に応じて有効／無効にする。 | — |
| 23 | `hasReferencesInAnchor` | `src/domain/deletion/eligibility.ts:98` | FR-41 | 「この地物を参照している地物が n 件あります」と削除確認に出す。 | — |
| 24 | `applyRepair` | `src/domain/persistence/repair.ts:713` | FR-104 系 | （現状は上位の `applyRepairChecked` が使われている。再設計では**こちらを使わない**判断を維持するのが正しい） | — |

**14〜15・21〜23 は要注意**。以下は事実と解釈を分けて書く。

- **21〜23（削除の可否判定）**: 事実として、削除の実際の経路は `createDeleteFeatureCommand`（`src/ui/App.tsx:2235` の `createDeleteFeatureCommandForRoot`）で、**全時刻を掃いて参照を掃除してから消す**方式である（`App.tsx:2150-2151` のコメントが明言）。`judgeDeletion` はそれとは別の、**参照があれば拒否する**方針の実装で、一度も呼ばれていない。FR-41 の条文（「参照を持つ他地物が存在しないか再編が許容される場合にのみ可能」）は両方の読み方を許すので、**どちらの方針で行くかは再設計時に決め直す論点**。今は「常に掃除して消す」が実装されている。
- **24（`applyRepair`）**: UI は `applyRepairChecked`（整合性を再検査する安全版、`src/ui/file-ops/repair-flow.ts:180`）を使っている。素の `applyRepair` は使わないのが正しい。表には「全数一覧の一部」として載せたが、**結線すべきではない**。

### 2.3 特筆すべき 3 つの発見

#### (a) 背景地図の差し替えは、ドメインの判定をまるごと迂回している

FR-04 の差し替えは 2026-07-12 の監査時点では「ボタンが常に無効」だったが、**現在は結線されている**（`src/ui/file-ops/basemap-replace.ts:165` `runBasemapReplace`、`src/ui/App.tsx:3518` `onRequestBasemapReplace`）。ただし、その中身は**バイト列の安全確認だけ**で（`src/ui/map/base-map-image-guard.ts` の `checkBaseMapImageBytes`）、`src/domain/basemap/format.ts` の縦横比の妥当性判定・自動補正・プリセットへの差し戻しは**一つも呼ばれていない**（`format.ts` の公開関数 11 個が全部孤立）。

迂回先の `checkBaseMapImageBytes` が縦横のサイズを読むのは、**総ピクセル数の上限を超えていないかを見るためだけ**である（`src/ui/map/base-map-image-guard.ts:167` — `widthPx * heightPx > MAX_BASE_MAP_IMAGE_PIXELS` の 1 箇所のみ。比率を見る式は同ファイルに存在しない）。

結果として、**縦横比が 2:1 でない画像を差し替えても、そのまま採用されて地図が歪む**。要件 FR-04 の「適合しない場合は自動補正を試み、不可能ならエラー通知してプリセット地図にフォールバックする」は満たされていない。現状.md の R1〜R10 にも監査の 12 件にも載っていない**新しい欠落**。

#### (b) 穴・飛び地の頂点編集は、リング編集用の検証ゲートを通っていない

`src/ui/ring-edit/useRingEditTool.ts:48-69` が `domain/ring-edit` から取り込んでいるのは、リングを**追加**する側（`addRing`, `placeVertex`, `undoVertex`…）と**削除**する側（`deleteHoleRing`, `deleteTerritoryRing`）だけ。頂点の**移動・追加・削除**は `src/ui/map/active-feature-handles.ts:44` と `src/ui/map/edit-session-snapshot.ts:26` から `domain/editing/edit-ops` の `addVertexToLeafRing` / `deleteVertex` を直接呼んでいる。

つまり `moveRingVertex` / `addRingVertex` / `deleteRingVertex` が持っている **U07 の包含・非交差・非重複の確定前ゲート**（`validateCandidate`）を通っていない。ただし解放時に別の整合性検査（`domain/consistency`）が走るため、これが実際に不正な形を通すかどうかは**コードを読んだだけでは断定できない**。§5 の未確認事項に回す。

#### (c) 「UI に無いのは機能ではなく“説明”」という型が多い

孤立 271 件のうち 87 件は**メッセージ文言と判別子**（`MSG_MERGE_VERTICAL`, `MSG_AFFILIATION_CYCLE`, `AFFILIATION_REJECT`, `DELETE_VERDICT` など）。ドメインは「なぜ拒否したか」を構造化して返しているのに、UI が受け取って表示していない、あるいは独自の文言を持っている。再設計では**拒否理由をそのまま表示する枠**を 1 つ作れば、この 87 件の多くがまとめて生きる。

---

## 3. UI 層（`src/ui`）の中で未結線のもの

ドメインだけでなく、**UI 層の中にも作ったのに誰も呼んでいない部品**がある。`src/ui` の公開宣言 556 個のうち、他モジュールから使われていないものが 153 個。うち意味のあるものを挙げる。

| 部品 | 定義 | 何ができるはずか |
| --- | --- | --- |
| `setEmphasizedDepth` | `src/ui/discovery/filter-state.ts:175` | **階層深度の単位で強調表示**する軸。ストアに操作が無く、表示フィルタ欄にも軸が無い（現状.md R8。R8 は関数名を `withEmphasizedDepth` と書いているが、現在の名前は `setEmphasizedDepth`）。 |
| `setEmphasizedIds` / `setEmphasizedKinds` | 同 `:118` / `:126` | 強調対象を**集合ごと一括で**差し替える入口（今は 1 件ずつのトグルしか無い）。 |
| `evaluateJump` / `JUMP_OUTCOME` | `src/ui/discovery/search.ts:148` / `:130` | 検索結果をクリックしたとき**地図をその地物へ飛ばす**判定（現在時刻に存在しない場合の扱いを含む）。現在は選択と強調だけで、カメラは動かない（`src/ui/help-tools/HelpToolsController.tsx:442` の `onHitClick`）。一方サイドバー一覧のクリックは飛ぶ（`src/ui/shell/SidebarContent.tsx:581`）ので、**同じ「探して飛ぶ」が 2 通りある**。 |
| `highlightIds` | `src/ui/discovery/search.ts:123` | 検索ヒット全体をまとめて強調する。 |
| `resolveVisible` / `visibleIdSet` | `src/ui/discovery/visibility.ts` | 表示フィルタの可視集合を解決する入口（実際は `src/ui/map/filtered-display.ts` が別途持っている）。 |
| `keyboardZoomFactor` / `viewportCentre` / `KEYBOARD_ZOOM_NOTCHES` | `src/ui/map/keyboard-zoom.ts` | **キーボードによる拡大縮小**。コマンド ID `view.zoomIn` / `view.zoomOut` は `src/ui/shell/commands.ts:25-26` に定義されているのに、この計算関数は誰も呼んでいない。 |
| `objectLinkHref` | `src/ui/property/object-link.ts` | 詳細文書の中から**他の地物へのリンク**を張る（FR-98 の「文書内リンク」）。 |
| `BROKEN_IMAGE_SRC` | `src/ui/property/markdown.ts` | 詳細文書の画像が解決できないときの差し替え（画像埋め込み自体が未結線＝現状.md R6）。 |
| `createDiagnosticLogSink` / `buildDiagnosticsSnapshot` | `src/ui/discovery/log-sink.ts` / `log.ts` | 診断ログの収集と書き出し。ヘルプ側に「診断情報を保存」を置けば使える。 |
| `buildUserMessage` / `describeCause` / `mayDismiss` / `DISMISS_ON` | `src/ui/discovery/errors.ts` | エラーを利用者向けの日本語に直して、消してよいかを判定する一式。 |
| `isWithinZoomBoundary` / `ZOOM_LIMIT_REJECTION` | `src/ui/file-ops/zoom-limit.ts` | ズーム上下限を超えた操作を理由つきで断る。 |
| `decideAfterSave` / `GUARD_ACTION` | `src/ui/file-ops/unsaved-guard.ts` | 未保存のまま閉じようとしたときの分岐判断。 |
| `evaluateJump` 以外の `discovery/validation.ts` 一式 | `src/ui/discovery/validation.ts` | 検索語・不透明度・深度しきい値の入力検証と、その却下理由の文言。 |

---

## 4. 作り直しでそのまま使えるドメインの入口の地図

**UI を全部捨てても、次の入口はそのまま呼べる**。以下は「UI から現に呼ばれている実体」だけを並べた（＝動作実績がある）。各行の呼び出し元は代表例。

| 領域（窓口） | 主な入口 | 現在の呼び出し元 |
| --- | --- | --- |
| 地物の追加 `domain/add` | `resolveSnap`, `confirmShape`, `revalidateParent`, `isFaceFeature` | `src/ui/add/useAddTool.ts`, `AddToolController.tsx` |
| 所属変更 `domain/affiliation` | `buildAffiliationProposal`, `isLegalNewParent`, `allowedParentCandidates`, `parentExisting` / `parentNone` / `parentCreateWithTerminal` | `src/ui/reparent/useReparentTool.ts`, `src/ui/merge/MergeOptionsDialog.tsx` |
| 背景地図 `domain/basemap` | `validateImageDescriptor`, `resolveDisplayedBasemap`, `isGridSpacing`, `applyLongitudeShift` | `src/ui/map/base-map-asset.ts`, `src/ui/file-ops/basemap-replace.ts` |
| 配色 `domain/coloring` | `createPalette`, `buildAdjacencyFromLeaves`, `composeWithRecolor` | `src/ui/coloring/recolor-binding.ts`, `src/ui/property/StyleSection.tsx` |
| コマンドと履歴 `domain/command` | `createHistory`, `execute`, `withLimit`, `createCompositeCommand`, `createCommandResult` | `src/ui/App.tsx`, `src/ui/coloring/palette-command.ts` |
| 整合性 `domain/consistency` | `createEditProposal`, `applyResolutions` | `src/ui/consistency-binding.ts`, `src/ui/conflict/useConflictResolution.ts` |
| 右クリックメニュー `domain/context-menu` | `composeContextMenu`, `isBlocked` | `src/ui/map/context-menu-adapter.ts`, `src/ui/context-menu-launch.ts` |
| 削除 `domain/deletion` | `createDeletionState`, `createDeleteFeatureCommand`, `resolveDeleteTarget`, `isNoOpDeletion` | `src/ui/property/DeleteFeatureButton.tsx`, `src/ui/App.tsx` |
| 表示解決 `domain/display` | `createDisplayShapeCache` | `src/ui/map/display-resolution-cache.ts` |
| 穴あけ `domain/drill` | `checkDrillable`, `toEditProposal` | `src/ui/drill/useDrillTool.ts` |
| 頂点編集 `domain/editing` | `decideSnap`, `decideSharePairAtRelease`, `confirmRelease`, `buildSnapshot`, `addVertexToLeafRing`, `addVertexToLine`, `deleteVertex` | `src/ui/map/edit-session-adapter.ts`, `active-feature-handles.ts`, `src/ui/vertex-delete.ts` |
| 測地 `domain/geo` | `createGeoParams`, `multiPolygonAreaKm2`, `unwrapRing` | `src/ui/shell/SidebarContent.tsx`, `src/ui/map/*` |
| 幾何 `domain/geometry` | `isMultiPolygonEmpty`, `isOk` ほか | `src/ui/map/feature-bounds.ts`, `src/ui/conflict/preview.ts` |
| 階層 `domain/hierarchy` | `buildForest`, `resolveLeafShape`, `resolveShapePieces`, `resolveFeatureArea`, `validateHierarchy`, `checkAggregateShapes` | `src/ui/shell/SidebarContent.tsx`, `src/ui/consistency-binding.ts` |
| 分割 `domain/knife` | `checkSplittable`, `executeSplit`, `confirmCut`, `confirmInheritor`, `toSplitSnapshot` | `src/ui/knife/useKnifeTool.ts` |
| 結合 `domain/merge` | `validateMergePreconditions`, `buildMergeProposal`, `toMergeEditProposal` | `src/ui/merge/useMergeTool.ts` |
| 保存・読み込み `domain/persistence` | `checkConsistency`, `applyRepairChecked`, `repairOptionsFor`, `manifestSchema` | `src/ui/file-ops/*` |
| 穴・飛び地 `domain/ring-edit` | `startDraft`, `placeFirstVertex`, `placeVertex`, `updatePreview`, `undoVertex`, `canConfirm`, `addRing`, `deleteHoleRing`, `deleteTerritoryRing`, `confirmRingEdit` | `src/ui/ring-edit/useRingEditTool.ts` |
| 選択 `domain/selection` | `reducer` 一式（`onPointerDown` 経由）、`reresolveAfterStructureChange`, `revalidateForTime`, `revalidateForDisplay`, `classifyFeatureHighlights` | `src/ui/map/live-selection-port.ts`, `src/ui/state/store.ts` |
| 空間索引 `domain/spatial` | `createTerminalShapeCache`, `detectTerminalOverlaps` | `src/ui/consistency-binding.ts` |
| 測量 `domain/survey` | `measureSurveyPair`, `enableSurveyMode`, `clickPoint`, `clearSurvey` | `src/ui/survey/*`, `src/ui/state/store.ts` |

**この地図の読み方**: 縦の 22 領域が、そのまま「機能の単位」になっている。ドメインは**編集案（proposal）を作る → 検証する → コマンドに包む → 履歴に積む**という同じ形をどの領域でも取っている。だから UI 側は「どの領域のどの入口を、どの画面部品から叩くか」だけを決めればよく、**編集の意味論を UI 側で持ち直す必要はない**。

---

## 5. 現状.md R1〜R10 と 2026-07-12 監査の突き合わせ

### 5.1 現状.md の R1〜R10

| ID | 現時点の状態 | 根拠 |
| --- | --- | --- |
| R1 線の長さ | **未解決のまま**。`lineLengthKm` は孤立。面積は `multiPolygonAreaKm2` で表示済み（`src/ui/shell/SidebarContent.tsx:345`）。 | 本文 §2.2 |
| R2 新しい上位領域を作る | **未解決のまま**。`parentCreate` はドメイン内（`src/domain/merge/decision.ts:23`）でだけ使われ、`ReparentToolController` は `parentExisting` / `parentNone` の 2 択のみ（`src/ui/reparent/useReparentTool.ts:34-43`）。結合ダイアログは `parentCreateWithTerminal` を持っている（`src/ui/merge/MergeOptionsDialog.tsx:27`）ので、形は流用できる。 | 同上 |
| R3 上位領域の再帰積み上げ | **未解決のまま**（R2 と同一） | 同上 |
| R4 直轄領の名前上書き | **未解決のまま**。`buildDirectDomainForLeaf` は 6 番目の引数 `nameOverride`（`src/domain/promotion/promote.ts:269`）を取るのに、所属変更の呼び出し（`src/domain/affiliation/proposal.ts:580`）は渡していない。`BuildProposalOptions`（`proposal.ts:288`）にも名前の項目が無い。**UI だけでなくドメイン側にも引数を通す作業が要る**。 | 同上 |
| R5 種別ラベル | **未解決のまま**。`withKindLabel` は孤立。`BasicInfoForm.tsx` / `AddPropertyForm.tsx` に `kindLabel` の語が 1 度も現れない。 | 同上 |
| R6 文書内の画像 | **未解決のまま**。`NO_ASSET_RESOLVER` を常に渡している（`src/ui/App.tsx:3195`, `:3434`、定義は `:3585`）。文書本文の編集自体は結線済み（`src/ui/live-detail-document.ts`）。 | 同上 |
| R7 自動保存の間隔・世代数 | **未解決のまま**。通信路 `configureAutoSave` は `src/shell/ipc/contract.ts:272` と `src/shell/preload/index.ts:55` にあるが、`src/ui` からの呼び出しはゼロ（E2E の存在確認だけ）。 | 同上 |
| R8 階層深度単位の強調 | **未解決のまま**。ただし**関数名が現状.md の記述と違う**。現状.md は `withEmphasizedDepth` と書くが、その名前はソースに存在しない。実物は `setEmphasizedDepth`（`src/ui/discovery/filter-state.ts:175`）で、`src/ui/discovery/index.ts:33` から公開されているのに誰も呼んでいない。 | §3 |
| R9 一覧の階層表示 | **未解決のまま**。`SidebarContent.tsx:571-585` は `featuresAt(...).filter(...).map(...)` の平坦な写像で、親子関係もインデントも使っていない。 | §5.1 |
| R10 追加フォームの年代・色 | **未確認**（本担当の範囲外。`src/ui/add/AddPropertyForm.tsx` の担当へ） | — |

### 5.2 2026-07-12 監査の 12 件

**解消済みと確認できたもの（7 件）**

| 監査 # | 件名 | 解消の根拠 |
| --- | --- | --- |
| 1 | 測量モード一式（FR-14/15/16） | `src/ui/survey/SurveyToolController.tsx`, `SurveyControls.tsx` が存在し、ストアの `surveyEnable` / `surveyClickPoint` / `surveyClear` が呼ばれている。ただし**度分秒表示（FR-16）だけは未結線**（§2.2 の 10〜12） |
| 2 | グローバル深度スライダー（FR-42） | `src/ui/map/GlobalDepthControl.tsx` が `setGlobalDepth` を呼ぶ |
| 3 | 基準地図差し替え（FR-04） | ボタンは結線された（`src/ui/App.tsx:3518`）が、**判定はドメインを迂回**（§2.3 (a)）＝**部分解消** |
| 4 | 共有頂点の共有解除（FR-33） | `src/ui/live-unshare.ts:69` が `unshareReference` を呼ぶ |
| 5 | 右クリックメニュー（FR-96） | `src/ui/map/context-menu-adapter.ts:27` が `composeContextMenu` を呼ぶ |
| 6 | 自動配色（FR-100/101） | `src/ui/coloring/recolor-binding.ts:33` が `composeWithRecolor` を呼ぶ |
| 8 | 表示制御パネル（FR-113） | `src/ui/discovery/DisplayFilterPanel.tsx` が `setFilterKindVisible` ほか 6 操作を呼ぶ |

**未解消のまま残っているもの（5 件）**

| 監査 # | 件名 | 現時点の根拠 |
| --- | --- | --- |
| 7 | 詳細文書（FR-98） | 本文の保存・編集は結線済み。**画像**（R6）と**文書内リンク**（`objectLinkHref` が未使用）が残る |
| 9 | 存続期間の入力が年のみ | 本担当の範囲外（プロパティ欄の担当へ） |
| 10 | グリッド ON/OFF | `src/ui/map/GridToggleControl.tsx` が存在するので**解消と思われる**が、緯経線の強調（`isLatitudeEmphasized` / `isLongitudeEmphasized`）は未結線 |
| 11 | 個別フォーカスの別深度 | `setFocusDepth` は `App.tsx` から呼ばれている＝**解消**。ただし `setFocusOrigin` は未使用（重複） |
| 12 | 検索ヒット→カメラジャンプ | **未解消**。`evaluateJump` が未使用（§3） |

---

## 6. 確かめられなかったこと

1. **穴・飛び地の頂点編集が本当に不正形を通すのか**。`moveRingVertex` などの確定前ゲートを迂回しているのは事実だが、解放時の整合性検査（`domain/consistency`）が同じ違反を捕まえる可能性がある。実機で「穴の頂点を親領土の外へ引きずり出す」操作を試すのが最短。
2. **削除の可否をどちらの方針にするか**（§2.2 の 21〜23）。「常に参照を掃除して消す」（現行）と「参照があれば拒否する」（`judgeDeletion`）はどちらも FR-41 の読み方として成立する。所有者の裁定が要る。
3. **背景地図の縦横比を実際に無視するか**。コード上は `format.ts` を通らないが、`checkBaseMapImageBytes` が別途比率を見ている可能性を全部は追えていない。2:1 でない画像を実際に差し替えて確認するのが確実。
4. **`src/render` 層の到達性**。本調査は `src/ui` からの参照を主眼にした。`src/render` からのみ届いている 33 件は個別に見ていない。
5. **R10（追加フォームの年代・色の初期値）** は担当外のため未検証。
6. **孤立 271 件の分類は筆者の判断**。特に「別経路」91 件は、同じ目的の別実装なのか、単に下位部品なのかを 1 件ずつ確かめてはいない。再設計で「この機能を載せたい」と決まった時点で、その周辺だけ精査するのが現実的。

---

## 付録 A. 孤立している公開名の全数一覧（271 件）

分類の凡例:

- **欠落** … UI に載せれば利用者に見える機能になる
- 別経路 … 同じ目的を UI は別の関数で果たしている（下位部品・並行実装を含む）
- 別名 … `src/domain/index.ts` が付けた別名だけが未使用。本体は UI から使われている
- 定数 … 判別子・メッセージ文言・既定値
- スキーマ … 保存形式の検証部品（親スキーマ経由で動く）
- 検査 … 反証テスト用・性能計測用
- 部品 … 値を差し替えるだけの小関数など

「テスト参照」は `*.test.ts` / `e2e/*.spec.ts` からの参照の有無。**あり＝テストは通っているが利用者には届いていない**という意味。

### `src/domain/add/index.ts`（6 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `placedVertex` | 関数 | `src/domain/add/session.ts:108` | なし | 別経路 |
| `snapToGrid` | 関数 | `src/domain/add/snap.ts:62` | あり | 別経路 |
| `SNAP_SOURCE` | 定数 | `src/domain/add/snap.ts:80` | あり | 定数 |
| `isPlacementAllowed` | 関数 | `src/domain/add/snap.ts:150` | あり | 別経路 |
| `candidateIdSet` | 関数 | `src/domain/add/parent-candidates.ts:75` | あり | 別経路 |
| `resolveParentId` | 関数 | `src/domain/add/proposal.ts:112` | あり | 別経路 |

### `src/domain/affiliation/index.ts`（5 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `resolveTargetLeaves` | 関数 | `src/domain/affiliation/proposal.ts:134` | あり | 別経路 |
| `AFFILIATION_COMMAND_KIND` | 定数 | `src/domain/affiliation/command.ts:30` | なし | 定数 |
| `AFFILIATION_COMMAND_LABEL` | 定数 | `src/domain/affiliation/command.ts:31` | なし | 定数 |
| `MSG_AFFILIATION_SAME` | 定数 | `src/domain/affiliation/messages.ts:10` | なし | 定数 |
| `MSG_AFFILIATION_CYCLE` | 定数 | `src/domain/affiliation/messages.ts:14` | なし | 定数 |

### `src/domain/basemap/index.ts`（18 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `EQUIRECTANGULAR_ASPECT` | 定数 | `src/domain/basemap/format.ts:31` | なし | 定数 |
| `ASPECT_TOLERANCE` | 定数 | `src/domain/basemap/format.ts:39` | なし | 定数 |
| `MAX_CORRECTABLE_ASPECT_FACTOR` | 定数 | `src/domain/basemap/format.ts:49` | なし | 定数 |
| `IMAGE_VALIDATION_ERROR` | 定数 | `src/domain/basemap/format.ts:92` | あり | 定数 |
| `aspectRatio` | 関数 | `src/domain/basemap/format.ts:146` | あり | **欠落** |
| `isFormatAdequate` | 関数 | `src/domain/basemap/format.ts:151` | あり | **欠落** |
| `isCorrectable` | 関数 | `src/domain/basemap/format.ts:166` | あり | **欠落** |
| `correctedDimensions` | 関数 | `src/domain/basemap/format.ts:190` | あり | **欠落** |
| `BASEMAP_OUTCOME` | 定数 | `src/domain/basemap/format.ts:218` | あり | 定数 |
| `BASEMAP_FALLBACK_REASON` | 定数 | `src/domain/basemap/format.ts:228` | あり | 定数 |
| `decideBasemapReplacement` | 関数 | `src/domain/basemap/format.ts:278` | あり | **欠落** |
| `basemapNotice` | 関数 | `src/domain/basemap/messages.ts:34` | あり | **欠落** |
| `DEFAULT_GRID_SPACING_DEG` | 定数 | `src/domain/basemap/grid.ts:38` | あり | 定数 |
| `isLatitudeEmphasized` | 関数 | `src/domain/basemap/grid.ts:100` | なし | **欠落** |
| `isLongitudeEmphasized` | 関数 | `src/domain/basemap/grid.ts:104` | なし | **欠落** |
| `SHIFT_PX_PER_UNIT` | 定数 | `src/domain/basemap/longitude-shift.ts:28` | あり | 定数 |
| `shiftToLonDelta` | 関数 | `src/domain/basemap/longitude-shift.ts:45` | あり | **欠落** |
| `CENTER_LON_PRESET_VALUE` | 定数 | `src/domain/basemap/longitude-shift.ts:85` | なし | 定数 |

### `src/domain/coloring/index.ts`（20 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `parseHex` | 関数 | `src/domain/coloring/color-math.ts:44` | あり | 別経路 |
| `rgbToHex` | 関数 | `src/domain/coloring/color-math.ts:68` | あり | 別経路 |
| `rgbToHsl` | 関数 | `src/domain/coloring/color-math.ts:73` | あり | 別経路 |
| `hslToRgb` | 関数 | `src/domain/coloring/color-math.ts:107` | あり | 別経路 |
| `SELECTION_LIGHTEN_STEP` | 定数 | `src/domain/coloring/color-math.ts:142` | なし | 定数 |
| `SELECTION_SATURATE_STEP` | 定数 | `src/domain/coloring/color-math.ts:143` | なし | 定数 |
| `DERIVE_HUE_STEP_DEG` | 定数 | `src/domain/coloring/color-math.ts:167` | なし | 定数 |
| `DERIVE_LIGHTNESS_STEP` | 定数 | `src/domain/coloring/color-math.ts:168` | なし | 定数 |
| `DERIVE_SATURATION_STEP` | 定数 | `src/domain/coloring/color-math.ts:169` | なし | 定数 |
| `DEFAULT_BASE_COLORS` | 定数 | `src/domain/coloring/palette.ts:35` | あり | 定数 |
| `isBaseColorIndex` | 関数 | `src/domain/coloring/palette.ts:99` | あり | 別経路 |
| `adjacencySignature` | 関数 | `src/domain/coloring/adjacency.ts:133` | あり | 別経路 |
| `assignColorIndices` | 関数 | `src/domain/coloring/four-color.ts:39` | あり | 別経路 |
| `findColorConflicts` | 関数 | `src/domain/coloring/four-color.ts:66` | あり | 検査 |
| `maxColorIndex` | 関数 | `src/domain/coloring/four-color.ts:86` | あり | 別経路 |
| `computeColorPlanFor` | 関数 | `src/domain/coloring/auto-color.ts:104` | あり | 別経路 |
| `adjacencyChanged` | 関数 | `src/domain/coloring/recolor-trigger.ts:25` | あり | 別経路 |
| `manualColorsOnDisable` | 関数 | `src/domain/coloring/style-permission.ts:55` | あり | **欠落** |
| `RECOLOR_COMMAND_KIND` | 定数 | `src/domain/coloring/recolor-command.ts:41` | なし | 定数 |
| `RECOLOR_COMMAND_LABEL` | 定数 | `src/domain/coloring/recolor-command.ts:42` | なし | 定数 |

### `src/domain/command/index.ts`（3 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `COMPOSITE_COMMAND_KIND` | 定数 | `src/domain/command/command.ts:65` | あり | 定数 |
| `clearRedo` | 関数 | `src/domain/command/history.ts:156` | あり | 別経路 |
| `executeIfChanged` | 関数 | `src/domain/command/history.ts:184` | あり | 別経路 |

### `src/domain/consistency/index.ts`（4 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `DEFAULT_MAX_CONVERGENCE_ROUNDS` | 定数 | `src/domain/consistency/orchestrator.ts:47` | あり | 定数 |
| `conflictIdFor` | 関数 | `src/domain/consistency/conflict-adapter.ts:30` | あり | 別経路 |
| `conflictFromOverlapPair` | 関数 | `src/domain/consistency/conflict-adapter.ts:39` | あり | 別経路 |
| `MSG_TIME_VALIDATION_FAILED` | 定数 | `src/domain/consistency/messages.ts:13` | あり | 定数 |

### `src/domain/context-menu/index.ts`（11 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `featureKindLookupFromMap` | 関数 | `src/domain/context-menu/contracts.ts:186` | あり | 別経路 |
| `NO_AXIS_EMPHASIS` | 定数 | `src/domain/context-menu/contracts.ts:210` | なし | 定数 |
| `axisEmphasisLookupFromSet` | 関数 | `src/domain/context-menu/contracts.ts:215` | あり | 別経路 |
| `ITEM_FLOW` | 定数 | `src/domain/context-menu/items.ts:57` | なし | 定数 |
| `MENU_ITEM_LABEL` | 定数 | `src/domain/context-menu/items.ts:71` | あり | 定数 |
| `DISPATCH_BLOCKED_KIND` | 定数 | `src/domain/context-menu/dispatch.ts:34` | あり | 定数 |
| `MSG_INTERNAL_INCONSISTENCY` | 定数 | `src/domain/context-menu/messages.ts:29` | あり | 定数 |
| `flowRejection` | 関数 | `src/domain/context-menu/messages.ts:38` | あり | 別経路 |
| `internalInconsistency` | 関数 | `src/domain/context-menu/messages.ts:43` | あり | 別経路 |
| `nextTargetPreferenceFor` | 関数 | `src/domain/context-menu/reresolve-bridge.ts:59` | あり | 別経路 |
| `bridgeReresolve` | 関数 | `src/domain/context-menu/reresolve-bridge.ts:122` | あり | 別経路 |

### `src/domain/deletion/index.ts`（8 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `shouldAutoDisappear` | 関数 | `src/domain/deletion/auto-disappear.ts:36` | あり | 別経路 |
| `sweepChildLinksOnly` | 関数 | `src/domain/deletion/sweep.ts:168` | あり | 検査 |
| `DELETE_VERDICT` | 定数 | `src/domain/deletion/eligibility.ts:39` | あり | 定数 |
| `hasReferencesInAnchor` | 関数 | `src/domain/deletion/eligibility.ts:98` | あり | **欠落** |
| `judgeDeletion` | 関数 | `src/domain/deletion/eligibility.ts:124` | あり | **欠落** |
| `isDeletable` | 関数 | `src/domain/deletion/eligibility.ts:169` | あり | **欠落** |
| `DELETE_FEATURE_COMMAND_KIND` | 定数 | `src/domain/deletion/command.ts:29` | なし | 定数 |
| `DELETE_FEATURE_COMMAND_LABEL` | 定数 | `src/domain/deletion/command.ts:32` | なし | 定数 |

### `src/domain/display/index.ts`（4 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `NO_FOCUS` | 定数 | `src/domain/display/depth-focus.ts:208` | あり | 定数 |
| `classifyAtThreshold` | 関数 | `src/domain/display/depth-focus.ts:101` | あり | 別経路 |
| `drawableIds` | 関数 | `src/domain/display/depth-focus.ts:285` | あり | 別経路 |
| `geometrySourceFor` | 関数 | `src/domain/display/resolve-display-shapes.ts:90` | あり | 別経路 |

### `src/domain/drill/index.ts`（5 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `MIN_REGION_VERTICES` | 定数 | `src/domain/drill/drill-geometry.ts:72` | なし | 定数 |
| `executeDrill` | 関数 | `src/domain/drill/drill-geometry.ts:268` | あり | 別経路 |
| `DRILL_REJECT_MESSAGE` | 定数 | `src/domain/drill/messages.ts:10` | なし | 定数 |
| `holedOriginalFeature` | 関数 | `src/domain/drill/proposal.ts:396` | なし | 別経路 |
| `toDrillSnapshot` | 関数 | `src/domain/drill/proposal.ts:426` | なし | 別経路 |

### `src/domain/editing/index.ts`（8 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `HANDLE_KIND` | 定数 | `src/domain/editing/handles.ts:37` | あり | 定数 |
| `NO_SLIDE` | 定数 | `src/domain/editing/drag-session.ts:97` | あり | 定数 |
| `deletePointVertex` | 関数 | `src/domain/editing/edit-ops.ts:199` | あり | 別経路 |
| `deleteLineVertex` | 関数 | `src/domain/editing/edit-ops.ts:221` | あり | 別経路 |
| `commandResultFromEditResult` | 関数 | `src/domain/editing/edit-ops.ts:100` | あり | 別経路 |
| `featureVertexIds` | 関数 | `src/domain/editing/move.ts:32` | あり | 別経路 |
| `moveVertexSet` | 関数 | `src/domain/editing/move.ts:87` | あり | 別経路 |
| `isFeatureUnchanged` | 関数 | `src/domain/editing/edit-flow.ts:109` | あり | 別経路 |

### `src/domain/geo/index.ts`（7 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `DISTANCE_MEASURE` | 定数 | `src/domain/geo/geodesy.ts:25` | あり | 定数 |
| `lineLengthKm` | 関数 | `src/domain/geo/geodesy.ts:93` | あり | **欠落** |
| `polygonAreaKm2` | 関数 | `src/domain/geo/geodesy.ts:186` | あり | 別経路 |
| `isRepresentativeRing` | 関数 | `src/domain/geo/seam.ts:48` | あり | 別経路 |
| `maxAdjacentLonGap` | 関数 | `src/domain/geo/seam.ts:165` | あり | 検査 |
| `rewrapReplicas` | 関数 | `src/domain/geo/seam.ts:233` | あり | 別経路 |
| `ringsShareVertexAcrossSeam` | 関数 | `src/domain/geo/seam.ts:261` | あり | 検査 |

### `src/domain/geometry/index.ts`（8 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `countRings` | 関数 | `src/domain/geometry/types.ts:52` | あり | 別経路 |
| `ringsEqual` | 関数 | `src/domain/geometry/types.ts:59` | なし | 別経路 |
| `quantizePolygon` | 関数 | `src/domain/geometry/quantize.ts:120` | なし | 別経路 |
| `isPointStrictlyInside` | 関数 | `src/domain/geometry/predicates.ts:125` | あり | 別経路 |
| `isMultiPolygonValid` | 関数 | `src/domain/geometry/invariants.ts:537` | あり | 別経路 |
| `BOOLEAN_OP` | 定数 | `src/domain/geometry/boolean-ops.ts:42` | なし | 定数 |
| `multiPolygonFromRing` | 関数 | `src/domain/geometry/boolean-ops.ts:274` | あり | 別経路 |
| `multiPolygonFromPolygon` | 関数 | `src/domain/geometry/boolean-ops.ts:279` | なし | 別経路 |

### `src/domain/hierarchy/index.ts`（10 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `HIERARCHY_ROLE` | 定数 | `src/domain/hierarchy/forest.ts:94` | あり | 定数 |
| `hierarchyRole` | 関数 | `src/domain/hierarchy/forest.ts:104` | あり | 別経路 |
| `asAggregate` | 関数 | `src/domain/hierarchy/forest.ts:184` | あり | 別経路 |
| `DEPTH_UNDEFINED` | 定数 | `src/domain/hierarchy/depth.ts:29` | あり | 定数 |
| `SHAPE_RESOLUTION_FAILURE` | 定数 | `src/domain/hierarchy/resolve-shape.ts:39` | なし | 定数 |
| `NO_EXPLICIT_FLAGS` | 定数 | `src/domain/hierarchy/validate.ts:91` | なし | 定数 |
| `checkTopLevelEquivalence` | 関数 | `src/domain/hierarchy/validate.ts:103` | あり | 検査 |
| `checkCycles` | 関数 | `src/domain/hierarchy/validate.ts:127` | あり | 検査 |
| `checkChildParentAgreement` | 関数 | `src/domain/hierarchy/validate.ts:217` | あり | 検査 |
| `checkAggregateChildCounts` | 関数 | `src/domain/hierarchy/validate.ts:527` | なし | 検査 |

### `src/domain/index.ts`（101 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `hasVisibleText` | 関数 | `src/domain/text.ts:36` | あり | 別経路 |
| `asSharedVertexGroupId` | 関数 | `src/domain/ids.ts:68` | なし | 部品 |
| `withLon` | 関数 | `src/domain/coordinate.ts:117` | あり | 部品 |
| `withLat` | 関数 | `src/domain/coordinate.ts:121` | あり | 部品 |
| `verticesEqual` | 関数 | `src/domain/vertex.ts:26` | あり | 別経路 |
| `withVertexId` | 関数 | `src/domain/vertex.ts:32` | あり | 部品 |
| `isShapeEmpty` | 関数 | `src/domain/ring.ts:85` | あり | 別経路 |
| `withTerritoryRingParent` | 関数 | `src/domain/ring.ts:100` | あり | 部品 |
| `withHoleRingParent` | 関数 | `src/domain/ring.ts:116` | あり | 部品 |
| `DEFAULT_PALETTE_THEME_ID` | 定数 | `src/domain/attributes.ts:64` | あり | 定数 |
| `withStartYear` | 関数 | `src/domain/attributes.ts:38` | あり | 部品 |
| `withEndYear` | 関数 | `src/domain/attributes.ts:42` | あり | 部品 |
| `withSelectedOpacity` | 関数 | `src/domain/attributes.ts:166` | あり | 部品 |
| `withBorderColor` | 関数 | `src/domain/attributes.ts:170` | あり | 部品 |
| `withPaletteTheme` | 関数 | `src/domain/attributes.ts:174` | あり | 部品 |
| `isTopLevel` | 関数 | `src/domain/feature.ts:298` | あり | 別経路 |
| `hasNoChildren` | 関数 | `src/domain/feature.ts:303` | あり | 別経路 |
| `withKindLabel` | 関数 | `src/domain/feature.ts:326` | あり | **欠落** |
| `withEntryStart` | 関数 | `src/domain/anchor-series.ts:71` | あり | 部品 |
| `withEntryEnd` | 関数 | `src/domain/anchor-series.ts:76` | あり | 部品 |
| `withEntrySnapshot` | 関数 | `src/domain/anchor-series.ts:85` | あり | 部品 |
| `isValidSeries` | 関数 | `src/domain/anchor-series.ts:260` | あり | 別経路 |
| `DEFAULT_MONTH` | 定数 | `src/domain/time/time-point.ts:38` | なし | 定数 |
| `DEFAULT_DAY` | 定数 | `src/domain/time/time-point.ts:39` | なし | 定数 |
| `durationNormalized` | 関数 | `src/domain/time/normalized.ts:183` | なし | 別経路 |
| `isWithinNormalized` | 関数 | `src/domain/time/normalized.ts:200` | なし | 別経路 |
| `isValid` | 関数 | `src/domain/time/validate.ts:121` | なし | 別経路 |
| `topLevelRings` | 関数 | `src/domain/ring-hierarchy.ts:96` | あり | 別経路 |
| `ringDepth` | 関数 | `src/domain/ring-hierarchy.ts:106` | あり | 別経路 |
| `RING_VIOLATION` | 定数 | `src/domain/ring-hierarchy.ts:128` | あり | 定数 |
| `validateAlternation` | 関数 | `src/domain/ring-hierarchy.ts:202` | あり | 別経路 |
| `MIN_RING_VERTICES` | 定数 | `src/domain/ring-edit/draft.ts:27` | あり | 定数 |
| `startRingAddDraft` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `resetRingAddDraft` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `placeFirstRingVertex` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `placeRingVertex` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `updateRingPreview` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `setRingGridSnap` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `RING_UNDO_RESULT` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `undoRingVertex` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `canConfirmRing` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `RING_REJECT` | 定数 | `src/domain/ring-edit/commands.ts:91` | あり | 定数 |
| `validateCandidate` | 関数 | `src/domain/ring-edit/commands.ts:144` | あり | **欠落** |
| `addHole` | 関数 | `src/domain/ring-edit/commands.ts:277` | あり | 別経路 |
| `addEnclave` | 関数 | `src/domain/ring-edit/commands.ts:315` | あり | 別経路 |
| `moveRingVertex` | 関数 | `src/domain/ring-edit/commands.ts:371` | あり | **欠落** |
| `addRingVertex` | 関数 | `src/domain/ring-edit/commands.ts:392` | あり | **欠落** |
| `deleteRingVertex` | 関数 | `src/domain/ring-edit/commands.ts:420` | あり | **欠落** |
| `isFeatureChanged` | 関数 | `src/domain/ring-edit/confirm.ts:126` | あり | 別経路 |
| `isSharedVertex` | 関数 | `src/domain/shared-vertex.ts:161` | あり | 別経路 |
| `PARTICIPATION_REJECT` | 定数 | `src/domain/shared-vertex.ts:188` | あり | 定数 |
| `checkParticipation` | 関数 | `src/domain/shared-vertex.ts:209` | あり | 別経路 |
| `RESULT_VIOLATION` | 定数 | `src/domain/shared-vertex.ts:241` | あり | 定数 |
| `zeroLengthEdgeValidator` | 関数 | `src/domain/shared-vertex.ts:279` | あり | 別経路 |
| `REJECT_REASON` | 定数 | `src/domain/shared-vertex.ts:337` | あり | 定数 |
| `shareVertices` | 関数 | `src/domain/shared-vertex.ts:513` | あり | 別経路 |
| `moveVertices` | 関数 | `src/domain/shared-vertex.ts:609` | あり | 別経路 |
| `isResharingSuppressed` | 関数 | `src/domain/shared-vertex.ts:760` | あり | 別経路 |
| `shouldLiftSuppression` | 関数 | `src/domain/shared-vertex.ts:776` | あり | 別経路 |
| `liftSuppressionIfMoved` | 関数 | `src/domain/shared-vertex.ts:784` | あり | 別経路 |
| `entryFromShape` | 関数 | `src/domain/spatial/rtree.ts:42` | あり | 別経路 |
| `detectTerminalOverlapsNaive` | 関数 | `src/domain/spatial/overlap.ts:365` | あり | 検査 |
| `ZERO_DELTA` | 定数 | `src/domain/selection/contracts.ts:145` | なし | 定数 |
| `isInteracting` | 関数 | `src/domain/selection/state.ts:245` | あり | 別経路 |
| `EMPTY_RECTANGLE_RESOLVER` | 定数 | `src/domain/selection/reducer.ts:97` | あり | 定数 |
| `PANEL_TARGET_KIND` | 定数 | `src/domain/selection/context.ts:110` | あり | 定数 |
| `resolvePanelTarget` | 関数 | `src/domain/selection/context.ts:132` | あり | 別経路 |
| `VERTEX_HIGHLIGHT` | 定数 | `src/domain/selection/visual.ts:79` | あり | 定数 |
| `createClosedKnifeLine` | 関数 | `src/domain/knife/knife-line.ts:42` | あり | 別経路 |
| `SPLIT_REJECT` | 定数 | `src/domain/knife/split-geometry.ts:57` | あり | 定数 |
| `SPLIT_REJECT_MESSAGE` | 定数 | `src/domain/knife/split-geometry.ts:81` | あり | 定数 |
| `smallerSide` | 関数 | `src/domain/knife/split-geometry.ts:1134` | あり | 別経路 |
| `INHERITANCE_SIDE` | 定数 | `src/domain/knife/proposal.ts:58` | あり | 定数 |
| `createInheritanceChoice` | 関数 | `src/domain/knife/proposal.ts:82` | あり | 別経路 |
| `inheritorFeature` | 関数 | `src/domain/knife/proposal.ts:594` | あり | 別経路 |
| `knifeIdle` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `knifeSelectTarget` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `isKnifeOverlayVisible` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `KNIFE_GUIDE` | 定数 | `src/domain/knife/messages.ts:10` | あり | 定数 |
| `DIRECT_DOMAIN_NAME_SUFFIX` | 定数 | `src/domain/promotion/direct-domain.ts:45` | なし | 定数 |
| `defaultDirectDomainName` | 関数 | `src/domain/promotion/direct-domain.ts:52` | あり | **欠落** |
| `PROMOTION_STATUS` | 定数 | `src/domain/promotion/promote.ts:70` | あり | 定数 |
| `PROMOTION_REJECT` | 定数 | `src/domain/promotion/promote.ts:81` | あり | 定数 |
| `promoteLeafToAggregate` | 関数 | `src/domain/promotion/promote.ts:313` | あり | 別経路 |
| `emptiedAggregateIdsForPromotion` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `syncAggregateChildIdsForPromotion` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `isVerticallyRelated` | 関数 | `src/domain/merge/precondition.ts:67` | あり | 別経路 |
| `isTopLevelDecision` | 関数 | `src/domain/merge/decision.ts:70` | なし | 別経路 |
| `MERGE_KIND` | 定数 | `src/domain/merge/proposal.ts:88` | あり | 定数 |
| `classifyMerge` | 関数 | `src/domain/merge/proposal.ts:103` | あり | 別経路 |
| `toMergeSnapshot` | 関数 | `src/domain/merge/proposal.ts:810` | なし | 別経路 |
| `MERGE_COMMAND_KIND` | 定数 | `src/domain/merge/command.ts:26` | なし | 定数 |
| `MERGE_COMMAND_LABEL` | 定数 | `src/domain/merge/command.ts:27` | なし | 定数 |
| `createMergeCommand` | 関数 | `src/domain/merge/command.ts:55` | あり | 別経路 |
| `MSG_MERGE_TOO_FEW` | 定数 | `src/domain/merge/messages.ts:11` | あり | 定数 |
| `MSG_MERGE_TARGET_MISSING` | 定数 | `src/domain/merge/messages.ts:15` | なし | 定数 |
| `MSG_MERGE_NOT_PRESENT` | 定数 | `src/domain/merge/messages.ts:19` | あり | 定数 |
| `MSG_MERGE_VERTICAL` | 定数 | `src/domain/merge/messages.ts:23` | なし | 定数 |
| `MSG_MERGE_HIERARCHY` | 定数 | `src/domain/merge/messages.ts:35` | なし | 定数 |
| `contextMenuNextTargetPreferenceFor` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |
| `contextMenuBridgeReresolve` | 再輸出 | `src/domain/index.ts`（別名） | なし | 別名 |

### `src/domain/knife/index.ts`（1 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `toSharedEdgeCutSpecs` | 関数 | `src/domain/knife/proposal.ts:667` | あり | 別経路 |

### `src/domain/perf/index.ts`（8 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `representativeResponseMs` | 関数 | `src/domain/perf/metrics.ts:60` | あり | 検査 |
| `peakMemoryBytes` | 関数 | `src/domain/perf/metrics.ts:67` | あり | 検査 |
| `PERF_METRIC` | 定数 | `src/domain/perf/metrics.ts:74` | あり | 定数 |
| `PERF_COMPARISON` | 定数 | `src/domain/perf/metrics.ts:82` | あり | 定数 |
| `judge` | 関数 | `src/domain/perf/metrics.ts:113` | あり | 検査 |
| `failedRecords` | 関数 | `src/domain/perf/metrics.ts:201` | あり | 検査 |
| `describeRecord` | 関数 | `src/domain/perf/metrics.ts:206` | あり | 検査 |
| `DEFAULT_SYNTHETIC_PARAMS` | 定数 | `src/domain/perf/synthetic.ts:66` | あり | 定数 |

### `src/domain/persistence/index.ts`（30 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `vertexSchema` | 定数 | `src/domain/persistence/schema.ts:110` | なし | スキーマ |
| `basicAttributesSchema` | 定数 | `src/domain/persistence/schema.ts:119` | なし | スキーマ |
| `colorInfoSchema` | 定数 | `src/domain/persistence/schema.ts:130` | なし | スキーマ |
| `territoryRingSchema` | 定数 | `src/domain/persistence/schema.ts:157` | なし | スキーマ |
| `holeRingSchema` | 定数 | `src/domain/persistence/schema.ts:166` | なし | スキーマ |
| `ringSchema` | 定数 | `src/domain/persistence/schema.ts:175` | なし | スキーマ |
| `shapeSchema` | 定数 | `src/domain/persistence/schema.ts:180` | あり | スキーマ |
| `pointFeatureSchema` | 定数 | `src/domain/persistence/schema.ts:241` | なし | スキーマ |
| `lineFeatureSchema` | 定数 | `src/domain/persistence/schema.ts:249` | なし | スキーマ |
| `leafFeatureSchema` | 定数 | `src/domain/persistence/schema.ts:257` | なし | スキーマ |
| `aggregateFeatureSchema` | 定数 | `src/domain/persistence/schema.ts:265` | なし | スキーマ |
| `featureSchema` | 定数 | `src/domain/persistence/schema.ts:273` | なし | スキーマ |
| `anchorSnapshotSchema` | 定数 | `src/domain/persistence/schema.ts:337` | あり | スキーマ |
| `anchorSchema` | 定数 | `src/domain/persistence/schema.ts:369` | なし | スキーマ |
| `anchorEntrySchema` | 定数 | `src/domain/persistence/schema.ts:376` | なし | スキーマ |
| `featureHistorySchema` | 定数 | `src/domain/persistence/schema.ts:391` | あり | スキーマ |
| `geoParamsSchema` | 定数 | `src/domain/persistence/schema.ts:441` | あり | スキーマ |
| `projectSettingsSchema` | 定数 | `src/domain/persistence/schema.ts:465` | なし | スキーマ |
| `appSettingsSchema` | 定数 | `src/domain/persistence/schema.ts:475` | なし | スキーマ |
| `settingsSchema` | 定数 | `src/domain/persistence/schema.ts:481` | なし | スキーマ |
| `equirectangularMetaSchema` | 定数 | `src/domain/persistence/schema.ts:670` | なし | スキーマ |
| `baseMapReferenceSchema` | 定数 | `src/domain/persistence/schema.ts:679` | なし | スキーマ |
| `manifestV1Schema` | 定数 | `src/domain/persistence/schema.ts:699` | なし | スキーマ |
| `uiAppSettingsSchema` | 定数 | `src/domain/persistence/schema.ts:616` | あり | スキーマ |
| `uiSettingsSchema` | 定数 | `src/domain/persistence/schema.ts:656` | なし | スキーマ |
| `MSG_VERSION_MISSING` | 定数 | `src/domain/persistence/boundary.ts:74` | なし | 定数 |
| `MSG_VERSION_INCOMPATIBLE` | 定数 | `src/domain/persistence/boundary.ts:77` | なし | 定数 |
| `MSG_INVALID` | 定数 | `src/domain/persistence/boundary.ts:80` | なし | 定数 |
| `REPAIR_OPTION` | 定数 | `src/domain/persistence/repair.ts:63` | あり | 定数 |
| `applyRepair` | 関数 | `src/domain/persistence/repair.ts:713` | あり | 別経路 |

### `src/domain/survey/index.ts`（14 件）

| 名前 | 種別 | 定義位置 | テスト参照 | 分類 |
| --- | --- | --- | --- | --- |
| `COMPASS` | 定数 | `src/domain/survey/coords-format.ts:32` | あり | 定数 |
| `DECIMAL_PLACES` | 定数 | `src/domain/survey/coords-format.ts:24` | あり | 定数 |
| `DMS_SECOND_PLACES` | 定数 | `src/domain/survey/coords-format.ts:92` | なし | 定数 |
| `INVALID_VALUE_TEXT` | 定数 | `src/domain/survey/coords-format.ts:27` | あり | 定数 |
| `representativeLon` | 関数 | `src/domain/survey/coords-format.ts:47` | あり | 別経路 |
| `formatLatDms` | 関数 | `src/domain/survey/coords-format.ts:132` | あり | **欠落** |
| `formatLonDms` | 関数 | `src/domain/survey/coords-format.ts:144` | あり | **欠落** |
| `toDmsParts` | 関数 | `src/domain/survey/coords-format.ts:101` | あり | **欠落** |
| `MAX_PATH_SEGMENTS` | 定数 | `src/domain/survey/great-circle-path.ts:29` | あり | 定数 |
| `MIN_PATH_SEGMENTS` | 定数 | `src/domain/survey/great-circle-path.ts:31` | あり | 定数 |
| `DEGREES_PER_SEGMENT` | 定数 | `src/domain/survey/great-circle-path.ts:33` | あり | 定数 |
| `segmentCountForAngle` | 関数 | `src/domain/survey/great-circle-path.ts:56` | あり | 別経路 |
| `SURVEY_PHASE` | 定数 | `src/domain/survey/survey-state.ts:29` | あり | 定数 |
| `discardOnToolSwitch` | 関数 | `src/domain/survey/survey-state.ts:203` | あり | 別経路 |
