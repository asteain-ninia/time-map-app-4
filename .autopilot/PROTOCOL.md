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

## コミット前 hygiene（毎コミット前に必ず確認 — D36 / 引き継ぎで蒸発しがちな規律）

「作る規律」（property test / behavioral E2E / フルゲート緑）と対になる「散らかさない規律」（衛生・監査可能性）。引き継ぎのたびに選択的に摩耗してきたため PROTOCOL に固定し継承を強制する。**全コミットの前**に次の3点を確認する:

1. **probe/scratch ゼロ**: `git ls-files | grep -iE 'probe|_debug|_scratch|/_[a-z]'` が `__bughunt__/` 配下の正規テスト/baseline 以外ゼロ。使い捨て probe・デバッグ・スクラッチを HEAD に混ぜない（D14/U27/U31 で幽霊replay・フレーキー赤・偽 build-health を誘発した現物債務型）。一時 probe は**削除前に不変量を正規テストへ昇格**してから消す。クロスモデルレビュー scratch は `.tooling/_rev*.txt`（.gitignore 済）で追跡しない。
2. **DECISIONS D番号が一意**: `grep -noE 'D[0-9]+' .autopilot/DECISIONS.md` で重複採番なし。新決定は「最大番号 + 1」。DECISIONS の**フォークを作らない**（派生トピック別ファイルは明示クロスリンクのみ。単一真実源）。
3. **STATE「フェーズ状態」が実態と同期**: STATE 冒頭のフェーズ地図が git log の実態と一致（乖離したら STATE を先に直す＝**git が真**）。暫定決定（`[暫定・要確認]`）は STATE 冒頭の単一「要確認リスト」へ集約し既定値を1行で明記する（離席運用前提＝起床後レビューは事実上起きない）。

4. **スクショ再生成の儀式**: e2e スクショを含む変更では「baseline 削除 → 再生成 → 両方再生成を確認」を commit メッセージに明記する。

## 不変条件
- commit はローカルのみ（push 禁止）。
- v4 プロダクト文書はクリーンルーム（過去版に言及しない）。
- 受け入れ基準（テスト）が緑になるまでユニットを「完了」にしない。
