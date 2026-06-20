# Autopilot 再開プロトコル（中断/再起動したとき用）

あなた（Claude）は time-map-app-4 の夜間自律ビルドを担当している。ユーザーは就寝中で、**起床まで停止してはならない**。質問はしない（決定は自分で行い DECISIONS.md に記録）。

## 再開手順
1. このディレクトリの STATE.md と DECISIONS.md を読む。
2. `git -C "c:\!WORKSPACE\time-map-app\time-map-app-4" log --oneline -15` で実際の進捗を確認（STATEとgitが食い違えば **git が真**）。
3. 走行中のworkflowを /workflows で確認。死んでいれば `Workflow({scriptPath, resumeFromRunId})` で再開（完了済みagentはキャッシュ復帰）。
4. STATE の「次のアクション」を実行 → **1ユニット進めるごとに commit + STATE更新 + DECISIONS追記**。
5. ターン終了前に必ず **ScheduleWakeup** でウォッチドッグ起床を仕込む（~1500s / 25分。workflow完了通知が主、これは固着検知の保険）。
6. 作業が尽きてもユーザーが起きるまで停止しない。テスト追加・些細なバグ/性能改善（**デグレ厳禁**）を探す。

## 固着検知ウォッチドッグ（停止耐性）
起床のたびに、走行中workflowを次で分類して自動復旧する:
- 実測: `TaskOutput(task,block=false)` の status / `git log -1 --format=%cr`(最終commit経過) / `git status --short`(作業ツリー変化) / `Get-Process node,electron,codex`(直近起動の有無)。
- **健全**(直近commit or 作業ツリー変化 or 数分以内に起動した node/electron/codex あり) → ScheduleWakeup 再武装して終了。
- **固着**(status=running だが commit/ファイル変化/プロセス活動が ~40分以上ゼロ) → `TaskStop(task)` → `Workflow({scriptPath, resumeFromRunId})` で再開（完了agentはキャッシュ、固着agentのみ再実行）。誤検知回避のため閾値は緩め（Codex xhigh 1回や electron E2E ビルドは無commitで10〜20分かかる）。
- **死亡/完了** → 次フェーズへ。
- 以降のworkflowは**ステージごとにcommit**して進捗を可視化する。

## フェーズ遷移
DESIGN（要件定義書/技術方針/開発ガイド/specs）
→ IMPL（buildOrder順。各unit: 実装 → 多視点レビュー収束 → テスト緑 → commit）
→ CONVERGE（全要件FR-idが満たされるまで収束レビュー）
→ QUALITY（些細なバグ/性能改善、デグレなし）
→ 仕事探しを継続。

## 不変条件
- commit はローカルのみ（push 禁止）。
- v4 プロダクト文書はクリーンルーム（過去版に言及しない）。
- 受け入れ基準（テスト）が緑になるまでユニットを「完了」にしない。
