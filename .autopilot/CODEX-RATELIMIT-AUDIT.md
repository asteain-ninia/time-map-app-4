# Codex レート上限 法医学監査（統合レポート）

- 監査日: 2026-06-22
- 対象: Codex（gpt-5.5 / `codex-delegate.sh` 経由）の usage-limit 枯渇と、その失敗が bughunt2 fix 群へ与えた影響
- 実施方法: 読み取り専用（src・テスト・git は一切未変更。本ファイル以外は編集・commit しない）

---

## 1. 結論（端的に）

**Codex の usage-limit 失敗によって「壊れた」「危険な」事象は確認されなかった。**

- fail-open は正しく機能した。Codex が落ちた全ケースで、エージェントは失敗を transcript / journal に明示記録し、「NOT cross-model triangulated / Codex delegation FAILED」と正直に断った上で、コード追跡・実テスト実行・実行時再現で各候補を自己検証していた。
- 「Codex レビュー済」の詐称（誤帰属）はゼロ。捏造 finding（usage-limit エラー文を finding 化したもの）もゼロ。
- 独立ゲート（typecheck / lint / test / test:e2e）を通さずに commit された fix はゼロ。リトライ暴走・長時間ハングも無し（bounded retry）。

リスク総合評価: **低**。要対応は「クロスモデル再レビュー候補」の数件のみ（後述）。

---

## 2. 発生時期と影響範囲

### いつから / いつまで
- **初出（最古ヒット）**: `2026-06-20T14:03:49.732Z`（UTC、wf_836a2fb2-992）。
  - エラー文: `ERROR: You've hit your usage limit. Upgrade to Pro ... try again at Jun 21st, 2026 12:53 AM`
  - 当初は 6/21 早朝にリセット予定だった。
- **記録上の最後のヒット**: `2026-06-21T13:59:02.426Z`（UTC、wf_74e04f66-162）。
  - 6/21 に入って再枯渇し、エラー内の自己申告リセット時刻が `Jun 26th, 2026 2:33 AM` まで後退（長期ロックアウトに延長）。
- 状態まとめ: **6/20 昼すぎ（UTC）から少なくとも 6/21 午後まで断続的に落ちており、エラーの自己申告リセットは 6/26 まで延びていた。**

### どのワークフロー / 何回失敗
- 全 20 ワークフロー中、**実際に Codex が usage-limit で落ちたのは 2 ワークフローのみ**。
  - `wf_74e04f66-162`: 重複マッチ行ベースで **22 件**（最も影響大。当 wf 最古ヒット 2026-06-21T09:06:30Z）
  - `wf_836a2fb2-992`: 重複マッチ行ベースで **3 件**（最初に上限に当たった wf。最古 2026-06-20T14:03:49Z）
- 残り 18 ワークフローでは本物の Codex 枯渇エラーは未検出（"hit your usage limit" 等のヒットは skill ドキュメント文言や本調査タスク自身の転写ログ等のノイズ）。
- 補足: `codex-delegate.sh` を実起動して usage-limit（exit 1）で失敗したのは **6 エージェント**（a4cb4139 / a4d2b43e / a62eeff9 / ab8f535a / abcddaaa / a99ef0b3）。うち 5 つは detection 専用でコードに無影響、1 つ（a99ef0b3）のみ実コードを commit。
- ※ 各 JSONL の「件数」はエラー文字列が findings/再引用で複製されるため過大寄り。本レポートは重複行ベースのカウントを採用。

---

## 3. 扱いの安全性（fail-open / 詐称・捏造の有無）

### fail-open は機能したか → **YES**
- Codex が exit 1 を返した全ケースで、エージェントは
  - (a) 失敗を transcript と journal に明示記録、
  - (b) 「NOT cross-model triangulated / Codex delegation FAILED」と正直に断り、
  - (c) コード追跡・実テスト実行・実行時再現で各候補を直接検証
  していた。
- リトライは bounded:
  - `wf_836a2fb2-992`（a96162）: リセット時刻 00:53（約6分後）まで待つ間に typecheck/lint/2051 unit+16 e2e を実行 → リセット後 1 回リトライ → Codex 成功 → triangulate → 正当に commit（4ad603c）。
  - `wf_74e04f66-162`: retry-after が 2026-06-26 と遠かったため**即時 fail-open** へ切替え、無限リトライしていない。

### 「Codex レビュー済」の詐称（誤帰属） → **なし**
- usage-limit が出た 2026-06-22 の唯一のコミット `faec048` は `fix(bughunt2): ...` であり「Codex review」を一切名乗っていない（`git log --since=2026-06-22` で "codex review" を冠する commit は 0 件）。
- 「Codex review」を冠する 4 コミット（389a469 / e57b8fb / 733a0bb / f625953、すべて 2026-06-20 21:49-22:32）は wf_0e8541ad-2ff で **Codex が実際に exit 0 で findings を出した成功ケース**に対応する。詐称ではない。

### 捏造 finding（エラー文の finding 化） → **なし**
- limit 影響ワークフロー（wf_74e04f66-162 / wf_836a2fb2-992 / wf_8ef8013e-8d2）の finding title を `usage limit / upgrade to pro / quota / 429 / rate limit` で検索しても 0 件。
- 各 finding の出典は実 vitest 実行（例: `npx vitest run src/domain/__bughunt__/...property.test.ts`）やコード追跡で、エラー文起因のものは皆無。

### 参考: 並行する自己監査ラン
- `wf_8ef8013e-8d2`（2026-06-22 00:37）は本件とほぼ同一テーマを既に調査済みで、結論は同じ（fail-open 正常動作・誤処理なし）。本監査の独立な裏付け。

---

## 4. 要対応リスト

### 4-1. 独立ゲート未通過の fix（最優先）
- **該当ゼロ。** wf_74e04f66-162 で commit した 34 エージェント全てが typecheck / lint / test(vitest) / test:e2e の 4 ゲートを実行してから commit済み（機械監査で全 True）。fixed=False を報告した a793f72f / a9ef2574 は正しく commit せず終了。

### 4-2. クロスモデル再レビューすべき commit 一覧
| 優先 | commit | エージェント | 理由 |
|------|--------|-------------|------|
| medium | `74a1c44` | a99ef0b3 | Codex 失敗下で commit された唯一の実コード fix（editing/slide.ts 終端フォールバック分岐の非対称）。4ゲート緑だが、エージェント自身が「非対称は実在するが >1M fast-check でも exploit 入力を合成できず、現状は exploitable でない＝DEFENSIVE hardening」と自己申告。妥当だが非バグの可能性あり。副次として slide.ts の別バグ（constrainSlide が非有限座標で RangeError）を out-of-scope で発見・未修正と記録。 |
| low | `faec048` | a69325a0 | discovery-only。`onConflictCommitted` クロージャ件を「FALSE POSITIVE（phase!==Resolving のハードゲートで二重 commit 不可）」と確認。テスト/レポートのみ、実コード修正なし。非バグ確認の妥当性確認用。 |
| low | `47b827e8` | a7503c92 | discovery-only。競合解決/ズーム clamp 探索を「実在異常なし（厳格ゲート全通過、誤検出/非バグ）」と確認。テスト/レポートのみ。Codex は本件で未起動。 |

### 4-3. クロスモデル確認が欠落した検証経路（再レビュー候補・fix 非直結）
- `a62eeff9`（detection only）: Codex の live probe が finding 1/2/3 を確認後に usage-limit で死亡。エージェントは「seam alignment が VALID な seam promotion を誤 reject するかは再確認できない」と限界を正直に記録。seam promotion 検証経路は cross-model 確認欠落領域。

### 4-4. 運用改善（無駄リトライ等）
- 重大な無駄リトライは検出されず。retry-after が遠い場合の即時 fail-open は適切に動作している。
- 改善提案: リセット時刻が数分以内のときのみ待機リトライ、遠い場合（数日先）は待たず即 fail-open、という現行挙動を明示ポリシーとして固定化することを推奨。

---

## 5. 推奨

- **Codex（gpt-5.5）が usage-limit から復帰するまでは、クロスモデル相互検証を「多様な Claude パネル」での再レビューで代替する**こと。
  - 最優先で `74a1c44`(a99ef0b3) を別系統 Claude で再レビュー（DEFENSIVE hardening が真にバグか、現状実害なしの過剰修正かを判定）。
  - 併せて discovery-only の `faec048` / `47b827e8` の false-positive 判定、a62eeff9 の seam promotion 検証経路を Claude パネルで再確認。
  - 同 fix の副次発見（slide.ts constrainSlide が非有限座標で RangeError、out-of-scope 未修正）を別チケットとして追跡。
- 復帰後は、上記再レビュー候補を Codex で改めて三角測量し、結論の整合を確認する。
- fail-open / bounded retry / 失敗の transcript・journal 明示記録は現状で健全。この挙動は維持すること。
