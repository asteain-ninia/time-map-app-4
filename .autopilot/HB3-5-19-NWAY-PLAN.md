# HB3-5/19 ナイフ n-way 分割 実装プラン（ultracode 判定パネルで確定 / 2026-06-22）

ユーザー訂正: 1本の開分断線が境界を **2k回横断 → k+1片**（4回横断=3片）。余計な小片を出さず、内部で止まる線は不正分断しない。現 `openLineToClip` 半平面押し出しは2-way固定なので再設計が必要。

判定パネル（4アプローチ→3判定→統合）の結論。**実装は別ユニット（大物）**。

## 採用: iterative-per-chord（最小 blast radius）
開分断線を「内部チョード（境界ノード→内部→境界ノード）」へ分解し、**各チョードで既存の 2-way 機構（openLineToClip + U06 intersection/difference）を1本ずつ適用**。k チョード→k+1片。新しい DCEL カーネルは作らない（planar-arrangement 案は次点）。

## 必須グラフト（全判定合意）
- **G1**: 期待片数は boolean 出力の**実連結成分数**から導出。`pieces.length===k+1` は**テスト専用オラクル/床**であり実行時 assert にしない（穴跨ぎ/接触過剰計数/自己交差で k+1 にならない）。
- **G2**: 「両端点 outside」ゲートを緩和。チョード分解が dangling 頭/尾を自然に落とすので端点が外でなくてよい。「内部で止まる線は分割しない」はチョード0本→DoesNotPierce で担保（≥1チョード必須）。
- **G3**: `SPLIT_REJECT.SelfIntersectingCut`（＋日本語文言）を追加。チョード同士の交差／per-chord boolean が !isOk or 空side のとき**正直に reject**（figure-eight を黙って誤処理しない）。
- **G4**: `segmentsIntersect` の Collinear（点なし, predicates.ts:209）を明示処理。境界辺に沿う cut は、両端が既存境界頂点なら entry/exit 扱い、さもなくば DoesNotPierce。専用テストで固定。
- **G5**: 内部判定はチョード上の**複数内部点**を pointInPolygon でサンプル（単一中点でない）。find-piece-by-containment も量子化端点を避けた厳密内部点で。
- **G6**: `reparentByContainment`/`ringStrictlyContains` を単一真実源の containment として export。**実連結成分コレクタ**を新設（reparentByContainment は per-side のリング入れ子だけ＝成分分けはしない）。
- **G7**: CLOSED ナイフは従来の単一 intersection/difference のまま。OPEN だけ iterative 化。両者とも新 `pieces[]` コレクタを通し出力形を統一（closed は length 2）。
- **G8**: sliver-fold + per-piece `ringSelfIntersects`/`everyOuterRingHasMinVertices` ガード。量子化由来の near-zero 面は隣接片へ U06 union で畳み、スプリアス小片を出さない。

## 型変更（2-way → n-way）
- `SplitCheckResult.Splittable: { status; pieces: readonly SplitSide[] }`（was sideA/sideB）。pieces.length≥2。
- `SplitResult: { pieces: readonly SplitSide[]; edgeCuts }`。
- `smallestPieceIndex(result): number`（was smallerSide():'a'|'b'；FR-93 を smallest-of-n へ一般化、同点は最小index）。
- `InheritanceChoice { inheritIndex: number }`（was {inherit:'a'|'b'}）。inheritIndex の片が原 FeatureId/親/属性/錨を継承（形状のみ変化, FR-44）、他 (n-1) 片は新規 LeafFeature（fresh id, U23 props, 親継承）。
- `SPLIT_REJECT.SelfIntersectingCut`。

## 変更ファイル
- `src/domain/knife/split-geometry.ts`: splitIntoChords + detectChordCrossings + collectPieces + sliver-fold；OPEN 分岐を iterative へ。
- `src/domain/knife/proposal.ts`: inherit→inheritIndex；NonInheritedProperties を per-piece 配列へ；assemble を 1継承+(n-1)新規へ。
- `src/domain/editing/apply-proposal.ts`: applySplitProposal を newFeatures[] ループへ。
- `src/domain/knife/index.ts` / `session.ts`: 再export＋KnifeState を pieces[]+selectedIndex+per-piece props へ。
- `src/ui/knife/useKnifeTool.ts` / `InheritorModal.tsx`: n-way 片チューザ（per-piece preview+選択＋FR-93 最小片シード）。
- テスト一式: split-geometry/proposal/seam/property/apply-proposal を pieces[]/newFeatures[]/inheritIndex へ移行＋**4横断=3片**ケース追加。

## 要ユーザー確認（実装前）
- (n-1) 新規片の U23 属性入力 UX（各片フォームは多すぎ）＝共有デフォルト1回入力か、片ごとか。
- 自己交差 cut は **reject** 方針（真の面 arrangement は計算しない）で良いか。
- FR-93 シード: 継承先の既定は最小片か最大片か（現行 smallerSide は小さい方をシード）。

（設計のみ。実装は HB3 残作業＋E2E スイープ後に着手。）
