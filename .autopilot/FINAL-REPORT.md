# time-map-app-4 自走ビルド 総括レポート（STABLE）2026-06-22

## 結論
クリーンルーム再設計からの v4 を全力自走で構築。**HEAD `e471781` / 196 commits（ローカルのみ・未 push）/ 作業ツリー clean**。
フルゲート全緑（**typecheck=0 / lint=0 / vitest 245 files・2860 tests passed・skip 0 / Playwright e2e 65 passed**）。`npm run dev` で手動検証可能な安定版。

## 採用スタック（クリーンルーム再選定）
TypeScript(strict) + Electron + React18(UIシェル) + 自前 Canvas2D レンダラ（MapRenderer 抽象・WebGL フォールバック）+ Zustand + 純粋ドメインコア(DDD) + Immer コマンド履歴 + RBush + polygon-clipping + Zod + markdown-it/DOMPurify + .tmap ZIP(fflate) + Vite/electron-vite + Vitest/fast-check/Playwright。

## フェーズ履歴
1. **設計（クリーンルーム）**: 要件再読・技術再選定（v3 の Svelte5/XState から刷新）。
2. **実装**: 43ユニット + U44 を自走エンジンで実装。世界地図描画・地物作成・パン/ズーム/編集/競合解決/undo が機能。
3. **CONVERGE**: 実際に動くアプリへ収束（描画・操作・履歴）。
4. **QUALITY**: 約36件の細部修正。
5. **人間バグ HB-1..16**: behavioral E2E（実ドラッグ/ホイール/クリックで結果をアサート）+ 視覚回帰 + 観測フックで修正・回帰ロック。
6. **撤去**: FR-66 時刻ブックマーク撤去 / HB-16 左ツールバーのモード切替ツールチップのみ撤去。
7. **座標系修正**: ユーザー報告（スクロールバー多発・ズーム中心がカーソルにならない・頂点追加位置ずれ・拡大で地物消失・編集モードで頂点選択不可・ツール/ヘルプのグレーアウト・redo を Ctrl+Y へ）等をリサイズ/集約/ズームカリング/編集選択クラスタで対応。
8. **シーム監査**: 反子午線/東西継ぎ目の C1–C15 を監査、2根本原因を特定→修正→横展開（property テスト17本）。
9. **バグハント（property/fuzz/metamorphic + 多様レビュー + e2e エクスプローラ）**: **累計138件修正** = #1:67 / #2:46 / #3:25。誤検出は「修正せず」と正しく判定。
10. **Codex レート上限対応**: 法医学監査＝被害ゼロ（fail-open 機能・詐称/捏造なし・独立ゲート未通過 fix ゼロ）、フラグ4コミットの多様Claude再レビュー＝確定欠陥ゼロ。Codex 復帰まで「多様 Claude パネル（Sonnet/Haiku/Fable+Opus×ペルソナ）+ モデル非依存の property/fuzz」をクロスモデルレビューの代替に。

## テスト資産
- 単体/プロパティ: 245 files・2860 tests（fast-check stateful/property + メタモルフィック oracle: undo∘op=恒等 / op∘逆=恒等 / save∘load=恒等）。
- E2E: 65（behavioral + 視覚回帰 + 人間バグ毎の回帰テスト + バグハント探索）。
- 観測フック（data-testid: app-active-feature / data-pan-x,y / data-zoom / app-mode / app-active-vertex）。

## 既知の残課題・宿題（DECISIONS / TODO 参照）
- **T1**: bughunt #1/#2 のコミット件名が旧テンプレの slice で切れている → transcript から再構成して amend（low priority・ユーザー承認済）。
- **T2**: bughunt #3 round3 で **サーバ過負荷(529)により fix エージェント約11本+discovery6本+perf監査1本が失敗** → 拾えたが直せなかった round3 の指摘が数件あり得る。サーバ回復後に短いバグハント1ラウンドで再surface+修正。
- シーム C5/C11–C15: 病理的/仕様合意ケースとして据置（非欠陥評価）。
- Codex: ~2026-06-26 まで使用不可（or クレジット投入で復帰）。
- バグハントは各パスとも dry=0（形式的未収束）= ファズ空間は実質無限。138件の実バグ修正済みで逓減域。**ここからは人間の手動検証が最も価値の高い発見器**。

## 手動検証の入口
- `npm run dev`（electron 開発起動）。
- 確認候補: パン/ズーム中心がカーソル追従するか、追加モードの頂点位置、拡大時に地物が消えないか、編集モードで頂点選択できるか、`所属変更`/`結合(merge)` ツールが動くか（bughunt3 で死にボタン結線）、ツール/ヘルプメニュー活性、redo=Ctrl+Y。
