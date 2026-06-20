# 撤去タスク: タイムラインの「時刻ブックマーク」機能（ユーザー決定 2026-06-21）

ユーザー判断: 時刻ブックマーク（揮発的な栞）は不要 → **撤去**。HB-15 完了後・バグハント前に実行。Codexレビュー不要だが、削除後の全ゲート緑（typecheck/lint/test/test:e2e、skip 0、デグレなし）必須。commit はローカルのみ。

## 撤去する（= 時刻ブックマークだけ）
- `src/ui/timeline/EventMarkers.tsx`, `EventMarkers.test.tsx` を削除。
- `src/ui/timeline/markers.ts`, `markers.test.ts` を削除（addMarker/editMarker/removeMarker/positionMarkers/EventMarker は栞専用）。
- `src/ui/timeline/Timeline.tsx`: `EventMarkers` の import と `<EventMarkers .../>` ブロック、`markers` state（useState）、`nextMarkerId`/`markerSeq`/`markerIdPrefix`、`addMarker/editMarker/removeMarker` import を除去。`range`(toNormalizedRange) が栞専用なら一緒に除去（他用途あれば残す）。
- timeline-markers 系 CSS（shell.css / timeline css の `.timeline-markers*`）を除去。
- 関連文言（strings の 時刻ブックマーク/ブックマーク名 等）を除去。
- E2E: `e2e/ux-cluster.spec.ts` の HB-12「時刻ブックマーク見出し/説明が存在」アサートを除去（機能撤去に伴い）。代わりに「タイムラインに時刻ブックマークUIが存在しない」軽い回帰アサートを1つ足してもよい。
- ドキュメント: `docs/要件定義書.md` の FR-66（イベントマーカー/時刻ブックマーク）を**ディスコープ**として除去/明記。DECISIONS.md に「FR-66 撤去（ユーザー決定）」を記録。

## 撤去しない（= コア機能、触らない）
- **サイドバーの「イベント一覧」= `SidebarContent.tsx` の `EventsSection`** … 各地物の歴史の錨（時間アンカー）一覧（FR-84/111）。栞とは無関係のコア機能。**そのまま維持**。
- タイムライン本体（スライダー/年目盛/ステップ/再生/直接ジャンプ）、歴史の錨、地物編集など全コア機能。

## 確認
- 撤去後に EventMarkers/markers への dangling import が無いこと（grep）。
- 全ゲート緑。`screenshots` 再生成で UI からブックマークUIが消えていること。
