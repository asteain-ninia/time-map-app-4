# 全 FR × UI 到達性 全数監査(2026-07-12)

対象 HEAD: 25562a4。契機: ユーザー実機発見「表示階層レベル変更の UI が無い」(FR-42)を受けた全数点検指示。
手法: FR-01〜FR-118 全数 × ドメイン実装 grep × UI マウント/メニュー/ショートカット結線 grep。「単体テスト有 ≠ 到達可」(D47 教訓)。
実施: Claude Opus 4.8 subagent(読み取り専用) / 指揮: Claude Fable 5。

## ヘッドライン

- **MUST の UI 不達は 0 件**(D47 の6件は D48 復旧を再確認)。
- **should/could に「実装済み・UI 未結線」型が 12 件残存**。最大の新発見は**測量モード一式(FR-14/15/16)が丸ごと不達**(D43/D47 の死角)。
- (d) 完全未実装は 0 件。ただし FR-98 詳細文書は「ビューアはマウント済・**本文フィールドがドメインに無く編集 UI も無い**」ため実質未実装に近い (c)。

## (b)(c) 未結線・部分 12 件(重大度順・当たり所つき)

| # | FR | 内容 | 当たり所 |
| --- | --- | --- | --- |
| 1 | FR-14/15/16 | **測量モード一式が不達**。domain/survey + ui/survey/survey-batch.ts 完備、モード/ツール/マウント皆無 | SurveyToolController 新設(2点クリック→measureSurveyPair→overlay)、クリア/座標読取 |
| 2 | FR-42 | グローバル深度スライダー。setGlobalDepth 実装済・UI writer ゼロ(ユーザー報告の実体) | 上部バーにスライダ(別ユニット結線中) |
| 3 | FR-04 | 基準地図差し替え。SettingsDialog のボタンが **onRequestBasemapReplace 未供給で常時 disabled**(死んだアフォーダンス)。domain/basemap/format.ts 完備 | 画像選択 IPC→decideBaseMapAdoption 結線 |
| 4 | FR-33 | 共有頂点の共有解除。unshareReference+メニュー合成実装済・到達ゼロ | FR-96 と一体修正 |
| 5 | FR-96 | ライブ右クリックメニューが2項目のみ(削除+表示切替)。domain composeContextMenu(プロパティ/共有解除/分割/所属変更/結合)未結線 | MapContextMenu を composeContextMenu+dispatch へ |
| 6 | FR-100/101 | **自動配色が一度も起動しない**(autoColorEnabled=true でも実際は塗られない)。domain/coloring(四色/computeColorPlan/composeWithRecolor)完備・ライブ呼出ゼロ | commit 経路を composeWithRecolor でラップ(1 undo 単位) |
| 7 | FR-98 | 詳細文書: ビューア(markdown-it+DOMPurify)マウント済も**空文字供給・編集UI無し・ドメインにフィールド無し** | Feature に文書フィールド+スキーマ+編集UI(新規ドメイン作業) |
| 8 | FR-113 | 表示制御(種別/個別の表示非表示・不透明度・強調)の FilterState が store 未統合・パネル不在(検索のみ到達) | FilterState を store へ+パネル+buildCommittedFeatures 結線 |
| 9 | FR-70 | プロパティ存続期間が年のみ独自 input(タイムラインの YearMonthDayInput 未共有=月日粒度なし) | 共有コンポーネントへ差し替え |
| 10 | FR-13 | グリッド ON/OFF トグルが無い(間隔/色/不透明度のみ) | 設定 or 表示メニューにトグル |
| 11 | FR-43 | 個別フォーカスの別深度深掘り(setFocusDepth)の UI 呼出無し(強調のみ検索から到達) | FR-42 結線に相乗り |
| 12 | FR-113付随 | 検索ヒット→カメラジャンプ未結線(選択+強調のみ) | focusCameraOnFeature へ相乗り(仕様解釈要確認) |

## 要実機確認

- FR-104 バージョン非互換の警告 UI 導線 / FR-47 再帰積み上げの実挙動 / FR-91・FR-95 分割の穴横断・共有辺途中切り / FR-43 の focus 深度 / FR-113 ジャンプの仕様解釈。

## 過去監査との差分

- D43「中核 MUST 脱落なし」は MUST に関して現在も正。D47 の6件(FR-20/22/24/30/45/87/88)は D48 復旧をコード位置で再確認。
- 本監査の新規性: should/could 帯の到達性を初めて全数検査し 12 件捕捉。STATE:212-213 の「U41 受入は E2E 非依存」が死角の証左(search だけ結線、filter/visibility 未結線)。
- 教訓5.7(実装済み・未結線)が should 帯で反復。実機 FB で発見された FR-81/FR-37/FR-03/FR-42 も全て同型だった。

## §7.4 との矛盾

なし(FR-66 イベントマーカー撤去=D32 の意図的ディスコープ含め整合)。
