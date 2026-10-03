// 画面側の、ディレクトリに属さないファイル（`ring-hierarchy-gate.ts`・`consistency-binding.ts`）の
// 利用者向けの文（文言の表、開発ガイド §5.99）。`RING_HIERARCHY_GATE_STRINGS` は
// `ring-hierarchy-gate.ts` に置いていた表を一字一句そのまま移したもので、元のファイルから
// 同じ名前で再び公開している。この表は何も読み込まない。

/** 画面に出す文（何が起きたか → なぜか → 次に何をするか。設計書 §H.5）。 */
export const RING_HIERARCHY_GATE_STRINGS = {
  /** 記録の中身が読めないとき（通常は起きない）の文。 */
  refused:
    '動かした形を確定しませんでした。穴・飛び地が外周や別の穴・飛び地と交わる形になるためです。交わらない位置まで動かしてください。',
  /** どの面のどの年の形か（「（「アルラーク国」の1500年の形）」）。 */
  where: (featureName: string, atLabel: string): string => `（「${featureName}」の${atLabel}の形）`,
  refusedMove: (phrase: string, where: string): string =>
    `動かした形を確定しませんでした。${phrase}形になるためです${where}。交わらない位置まで動かしてください。`,
  refusedDeleteOne: (phrase: string, where: string): string =>
    `この頂点を消すと${phrase}ので消せません${where}。頂点は消していません。`,
  refusedDeleteMany: (phrase: string, where: string): string =>
    `選んだ頂点を消すと${phrase}ので消せません${where}。頂点は消していません。`,
} as const;

/** 輪郭の壊れ方ごとの言い方（「〜形になるためです」「〜ので」の〜の部分。`ring-hierarchy-gate.ts`）。 */
export const RING_BREAK_PHRASE_TEXT = {
  holesCross: '穴と穴が交わる',
  enclavesCross: '飛び地と飛び地が交わる',
  holeLeavesOuter: '穴が外周からはみ出す',
  enclaveLeavesHole: '穴の中の飛び地が穴からはみ出す',
  other: '穴・飛び地が外周や別の穴・飛び地と交わる',
} as const;

/** その時刻に見つからない地物を呼ぶ語（「名前のない地物」。`consistency-binding.ts`）。 */
export const CONSISTENCY_BINDING_TEXT = {
  unknownFeatureWord: '地物',
} as const;
