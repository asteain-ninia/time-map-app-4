# クロスモデル再レビュー統合 (REREVIEW)

生成日: 2026-06-22
入力: claude-sonnet-4-6 / claude-haiku-4-5 / claude-opus-4-8[1m] による各コミットのクロスモデル・クロスペルソナレビュー(JSON)
集約ルール: `real-bug` が **2 モデル/ペルソナ以上で一致 = 確定欠陥** / **1 つだけ = 要確認** / **全 clean(または suspect 止まり) = お墨付き寄り**

---

## 1. 結論(確定欠陥の有無)

**確定欠陥は 0 件。**

どのコミットについても `real-bug` 判定が 2 モデル以上で一致したものは存在しない。
`real-bug` 判定が出たのは **47b827e8 に対する haiku の 1 件のみ**で、同コミットを sonnet は `suspect`(low のみ)、opus は `clean` と評価しており、合議では「要確認」止まり。
他は全コミットとも最悪でも `suspect`(指摘は medium 以下が大半、high は単一モデルのみ)で、複数モデル一致の確定欠陥には至らない。

加えて、ターゲットハッシュ `a62eeff9` はリポジトリに存在せず(opus が `git cat-file -e` で不在を確認)、このハッシュ宛のレビューは別コミット(faec048)や別ファイル(seam.ts/promote.ts)を対象にしており、**評価対象の同定自体が不一致**。a62eeff9 の指摘は確定欠陥として扱えない。

---

## 2. コミット別の集約 verdict と根拠

### 74a1c44 — `constrainSlide` / 親包含 + 候補回避の統合チェック(slide.ts)
**集約 verdict: お墨付き(suspect 1 / clean 2、real-bug 0)**

| モデル | ペルソナ | verdict | 最悪 severity |
|---|---|---|---|
| sonnet-4-6 | adversarial skeptic | suspect | medium |
| haiku-4-5 | boundary/edge-case + robustness | clean | — |
| opus-4-8[1m] | correctness/contract/regression | clean | medium(low 扱い) |

- 根拠: real-bug ゼロ。sonnet の medium 2 件(stale boundary highlights の残存、`satisfiesBoth(start)` 前提の未強制)は、いずれも **本コミット以前から存在する契約ギャップ**で sonnet/opus 双方が「regression ではない」と明言。影響は UX(古いハイライト残り)または既存リスクの踏襲に留まり、安全不変条件違反は確認されていない。
- 残る指摘(test helper の ±0.0001 許容、satisfiesBoth の二重呼び出し)は test 品質/微小な冗長で correctness 欠陥なし。

### faec048 — `fix(bughunt2): onConflictCommitted closure captures conflictState`
**集約 verdict: お墨付き(suspect 2 / clean 2、real-bug 0)**

| モデル | ペルソナ | verdict | 最悪 severity |
|---|---|---|---|
| sonnet-4-6 | adversarial skeptic | suspect | high |
| sonnet-4-6 | adversarial-skeptic(a62eeff9 宛 → faec048 を代理レビュー) | suspect | medium |
| haiku-4-5 | boundary/edge-case + robustness | clean | — |
| opus-4-8[1m] | correctness/contract/regression | clean | low |

- 根拠: real-bug ゼロ。sonnet が high を 2 件挙げているが、いずれも **単一モデルのみ**で他 3 評価は clean。内容を精査すると合議で確定欠陥に昇格しない:
  - 「production code 未変更・test 追加のみ」: 当該コミットの性質(回帰テスト追加)であり欠陥ではない。
  - 「`cancel()` が Committed/Rejected 後に phase を Resolving へ巻き戻す」: opus と sonnet 自身が「本番では `setConflictState(null)` で同期アンマウントされ到達不能(defense-in-depth レベル)」と確認。state machine の意味論的弱さは残るが live failure path ではない。
- 複数モデルが共通して指摘した唯一の論点は「**回帰テストが phase ゲートを isolate できておらず退行検出力が弱い**」(opus・sonnet・a62 代理レビュー)。ただしこれは **test 品質の問題で出荷コードの欠陥ではない**(本番挙動は phase ゲート + canApply + アンマウントで二重三重に正しい)。

### 47b827e8 — zoom clamp / `zoomRangeOf` + `clampZoom` の property test
**集約 verdict: 要確認(suspect 1 / clean 1 / real-bug 1、複数一致なし)**

| モデル | ペルソナ | verdict | 最悪 severity |
|---|---|---|---|
| sonnet-4-6 | adversarial skeptic | suspect | low |
| haiku-4-5 | boundary/edge-case + robustness/security | **real-bug** | medium |
| opus-4-8[1m] | correctness/contract/regression | clean | low |

- 根拠: real-bug は haiku の **1 件のみ**(2 モデル一致せず → 確定欠陥ではない=「要確認」)。
- haiku の real-bug 根拠(eps=1e-9 が実装の厳密比較と不一致、非正/非有限境界の fallback 未テスト、`zoomRangeOf` の入力非検証)は、**全て test カバレッジ/堅牢性の指摘であり production の clampZoom 本体の動作は正しい**(opus は本体のクランプ性質を健全と判定、sonnet も同様に test 強度の弱さのみ指摘)。
- 3 モデルが共通して触れている確かな論点は「**property test の eps=1e-9 許容が `clampZoom` の厳密比較(浮動小数演算なし)とミスマッチで、将来の drift 回帰を見逃しうる**」。これは出荷バグではなく **テスト強化の推奨事項**。

### a62eeff9 — (リポジトリに存在しないハッシュ)
**集約 verdict: 同定不能(評価対象不一致のため集約不可)**

| モデル | ペルソナ | verdict | 備考 |
|---|---|---|---|
| haiku-4-5 | boundary/edge-case + seam-crossing | suspect | seam.ts/promote.ts を実コードとしてレビュー(high 2 含む) |
| opus-4-8[1m] | correctness/contract/regression | clean | a62eeff9 不在を確認し faec048 を代理レビュー |

- 根拠: opus が `git cat-file -e a62eeff9` 失敗を全 worktree で確認。haiku は seam.ts/promote.ts を実在コードとして評価したが、opus は同ハッシュを faec048 と同定し直しており、**2 モデルが別物を見ている**。対象が確定しないため real-bug 集約は成立しない。
- haiku の high 2 件(空 multi-polygon の参照経度=0 デフォルト、`ringLonMean` の NaN/Inf 伝播)は seam.ts に対する指摘だが、**単一モデル・対象同定不確実**のため確定欠陥に昇格しない。→ 下記 §3 に「要追跡(同定後に再評価)」として記録。

---

## 3. 確定欠陥(bughunt2 後に修正すべき)一覧

**該当なし(確定欠陥 0 件)。**

複数モデル一致による確定欠陥は存在しないため、bughunt2 後に必須修正すべき項目はなし。

参考として、合議で「**要確認(単一モデル指摘)**」に分類され、bughunt2 後に **任意で検討**しうる候補を以下に記録する(必須ではない):

| 区分 | severity | 場所 | 内容 | 一致状況 |
|---|---|---|---|---|
| 要確認 | medium | `zoom-clamp-supply-stays-in-range.property.test.ts:68-70` | eps=1e-9 許容が `clampZoom` の厳密比較と不一致。`>= min` / `<= max` の厳密境界に変更してテスト強化(回帰検出力向上) | haiku=real-bug / sonnet=low / opus=low(=テスト品質、出荷バグではない) |
| 要追跡 | high | `seam.ts:357-363` referenceLonForMultiPolygon / `seam.ts:311-316` ringLonMean | 空 multi-polygon の参照経度=0 デフォルト、NaN/Inf 経度の伝播。**ただし対象コミット(a62eeff9)が不在で同定不確実** | haiku 単独。opus は別コミットを同定。→ 正しい SHA 確定後に再レビュー要 |
| 任意 | medium | `useConflictResolution.ts:cancel()` | Committed/Rejected 後の `cancel()` が無条件で phase を Resolving に巻き戻す(Committed を terminal にする guard 追加)。本番ではアンマウントで到達不能だが state machine の堅牢化として検討可 | sonnet 単独(2 ペルソナ)。haiku/opus は clean |

---

## 4. お墨付きコミット

複数モデル合議で `real-bug` 一致がなく、出荷コードの correctness/contract/regression 欠陥が確認されなかったコミット:

- **74a1c44** — 親包含+候補回避の統合チェック(slide.ts)。clean 2 / suspect 1、real-bug 0。指摘は全て既存契約ギャップの踏襲または UX/test 品質。**お墨付き。**
- **faec048** — `onConflictCommitted closure captures conflictState` 回帰修正。clean 2 / suspect 2、real-bug 0。本番挙動は phase ゲート + canApply + 同期アンマウントで多重に正しい。high 指摘は単一モデルかつ到達不能経路。**お墨付き(ただし回帰テストの退行検出力強化は推奨)。**
- **47b827e8** — zoom clamp の property test。本体 `clampZoom` の動作は 3 モデルとも正しいと評価。real-bug 1 件は test カバレッジ指摘のみで本体欠陥なし。**本体はお墨付き(テスト eps 厳密化は推奨)。**

> a62eeff9 はハッシュ不在のため評価対象として確定できず、お墨付き/欠陥のいずれにも分類しない(正しい SHA での再レビューを要する)。
