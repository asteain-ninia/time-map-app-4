---
paths:
  - "src/render/**"
  - "src/domain/display/**"
  - "src/ui/map/**"
---

# 描画の教訓

番号は変えない。コードや文書が「開発ガイド §5.N」として参照している。

### 5.29 派生形状は単一の解決判定で全経路を動かす
- 正しい道: 子の和として導出する形状では、描画・ヒットテスト・派生サービス・選択を同じ形状解決判定で動かし（`resolveDisplayShapes`。`display-pipeline.ts`、`committed-features.ts`、`live-hit-test.ts` が使う）、規約を単体テストで固定する。
- 誤った道の兆候: 「描画されているのに選択できない」「ラベル位置が描画と違う」。集約かどうかの判定を各経路に書き写している。
- 確かめ方: `src/domain/display/resolve-display-shapes.test.ts`（両側の契約）、`src/domain/display/depth-focus.test.ts`。
