# FR-113 表示制御フィルタ — 結線設計ノート(次セッション判断用)

作成: 2026-07-19 夜間自律セッション。**未実装**。ドメイン/解決層は完成・テスト済だが store/描画/ヒット/検索/UI が完全未結線(教訓5.7 の典型)。大規模かつ FR-42 との合成に設計判断が要るため、実装せず本ノート化してユーザー判断を仰ぐ。

## 現状(実装済みの資産)
- `src/ui/discovery/filter-state.ts` — `FilterState`(kindVisible 点/線/面・depthThreshold・individual 上書き[hidden/emphasized]・opacity・emphasizedKinds/Depth/Ids)+ 純粋 immutable 更新関数群 + `reconcileToLiveFeatures`(削除された id を individual/emphasized から剪定=dangling 防止)+ `emphasisActive`。**単体テスト済**。
- `src/ui/discovery/visibility.ts` — **単一解決判定** `resolveFeatureDisplay(state, meta, presentAtTime) → {visible, opacity, emphasized}` + `resolveVisible`/`visibleIdSet`。**単体テスト済**。
- `src/ui/discovery/adapters.ts` — `toDisplayMeta(FeatureReadModel) → FeatureDisplayMeta`(id/kind/depth)。
- 消費者は discovery/ 内のみ = **描画パイプライン・ヒットテストからは未消費**(検索 search.ts は visibleIdSet を使う設計だが要確認)。

## 単一解決の鉄則(visibility.ts 冒頭に明記)
`resolveFeatureDisplay` の `visible` を**描画・ヒットテスト・検索ハイライトが同一判定として共有**し、「描画されているのに選択/検索できない」対概念矛盾を作らない。→ 部分結線(描画だけフィルタしてヒットはフィルタしない等)は禁止。draw+hit+search を一括で結線するのが最小の一貫ユニット。

## 結線が必要な箇所
1. **store スライス**(session 限り・非永続): FilterState 保持 + 各アクション(filter-state.ts の純関数へ委譲)+ **構造変更の全経路で reconcileToLiveFeatures**(selection-heal / search reevaluate と同じ規律 = add/delete/undo/redo/merge/knife/drill/reparent)。
2. **描画パイプライン**: `src/render/display-pipeline.ts` の `presentationFor`(地物ごとに style/opacity/emphasized を供給)+ cull(visible=false は描かない)に `resolveFeatureDisplay` を合成。**perf 必須**: 既存の世代キー付き `DisplayShapeCache`(display-resolution-cache)と統合し、FilterState を新たなキャッシュ入力に。722地物で毎フレーム未キャッシュの per-feature 呼びを増やさない(過去の 127ms cold を退行させない)。
3. **ヒットテスト**: `src/ui/map/live-hit-test.ts` を visibleIdSet でフィルタ(非表示地物は選択不可)。
4. **検索**: `search.ts` が visibleIdSet を真実として使うか確認・結線。
5. **操作 UI**: フィルタパネル(種別トグル・不透明度スライダ・強調・個別非表示)。サイドバー or topBar。topBar 占有不変量(a4f6be9)を壊さない。

## 🔴設計判断が要る点: FR-113 depthThreshold と FR-42 globalDepth の重複
- FR-42 `globalDepth` N = **集約のロールアップ深度**(深度 N で集約表示、子を畳む)。display-pipeline の `DisplayControlInput` 軸。
- FR-113 `depthThreshold` = **表示地物を深度で絞る**フィルタ軸。filter-state.ts の軸。
- 両者は概念的に近く、素朴に両方効かせると二重適用や矛盾(N で畳んだ上にさらに深度フィルタ)になり得る。**合成規則の決定が必要**(filter-state.ts コメントも「別軸」と言うが合成順は未定義、現状.md に保留と記録あり)。
  - 案A: depthThreshold は FR-42 と冗長 → 結線しない(FilterState から実質除外)。
  - 案B: 合成する(FR-42 が集約母集合を決め、FR-113 がさらに絞る)→ 適用順を明文化。
- **ユーザー判断推奨**: 編集中に「深度で絞る」操作を FR-42 スライダと別に持ちたいか。

## 推奨フェーズ分け(次セッション)
- **Phase 1(曖昧さなし・高価値・低リスク)**: kindVisible(点/線/面 表示切替)+ individual hidden(個別非表示)+ opacity。FR-42 と直交、合成問題なし。722地物ナビゲーションの中核。draw+hit+search+store+reconcile+UI を一括結線。
- **Phase 2**: emphasis(emphasizedKinds/Ids + dim others、DIM_OPACITY_FACTOR=0.25)。resolution は実装済なので機械的。「dim others」UX を確認。
- **Phase 3**: depthThreshold。上記の FR-42 合成判断が済んでから。

## 実装体制メモ
大規模なので study 先行(描画シーム+perf キャッシュ+hit/search 消費点の実測マップ)→ Phase 1 実装 → Codex 敵対レビュー(perf 退行・単一解決の一貫性=描画とヒットの母集合一致)を強めに。
