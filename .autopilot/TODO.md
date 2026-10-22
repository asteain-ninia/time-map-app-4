# 低優先度 TODO バックログ

## T1: バグハントのコミット件名を復元（LOW priority・暇になったら / ユーザー承認済 2026-06-22）

**問題**: `fix(bughunt...)` / `fix(bughunt2...)` のコミット件名が、修正テンプレの `String(f.title).slice(0,~55)` で**単語途中で切断**され、詳細ボディも欠落。ログが辿りづらい。

**復元可能性**: 各 fix エージェントの完全な finding / summary（＝本来の件名・詳細）は破棄されておらず、以下に残存:
- workflow transcript: `C:\Users\…\.claude\projects\c---WORKSPACE\87df7544-909d-4aad-b1cf-3eefcb5f77de\subagents\workflows\wf_*\*.jsonl`
- task 出力: `C:\Users\…\AppData\Local\Temp\claude\c---WORKSPACE\87df7544-909d-4aad-b1cf-3eefcb5f77de\tasks\*.output`

**計画（big effort 前提）**:
1. 切れた `fix(bughunt...)` コミットを列挙（`git log`）。
2. 各 SHA/差分/切れた件名を、対応する fix エージェントの transcript の finding/summary と突き合わせ、**完全な「件名(≤72字, 単語途中で切らない)＋詳細ボディ」**を再構成（SHA→新メッセージのマッピング表を作る）。
3. ローカル限定なので履歴書き換えで amend（`git rebase` の exec か `git filter-repo` の message callback）。**書き換え前に必ず backup tag/branch を作成**。push しない。
4. 書き換え後に全ゲート（typecheck/lint/test/test:e2e）緑を再確認。少しでも異常なら abort して backup へ戻す。

**実施タイミング**: STABLE 後・他に作業が無い真の idle 時のみ（ビルド進行中は触らない）。不確実なら無理せずユーザー判断に委ねる。

**再発防止**: 済。今後の新規コミットは「完結件名＋詳細ボディ（2つ目の -m）」で出している。

## T2: bughunt#3 round3 で 529 により直せなかった指摘の再surface（priority: med・サーバ回復後）

**問題**: 2026-06-22 のサーバ過負荷で bughunt#3 のエージェントが失敗（discovery 6本・fix 約11本・perf監査1本が 429/529）。round3 で discovery が拾った指摘のうち、fix エージェントが 529 で落ちた数件は**未修正のまま**でファイルにも残っていない可能性。

**対応**: Anthropic サーバが安定したら、bughunt#3 と同型の**短い1〜2ラウンド**（新シード・多様Claudeパネル・property/fuzz・e2e エクスプローラ）を回して再surface＋修正。dry になれば収束扱い。Codex は ~6/26 まで使わない。

**注**: 失敗は server-side（こちらの使用量超過ではない）。ジャーナル(resumeFromRunId)で再開も可能だが、round3 の fix 失敗は finding がファイル化されていないため、resume より新シード再走の方が確実。
