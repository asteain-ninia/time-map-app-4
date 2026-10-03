// U36 右クリックの項目の名前と、出したまま無効にする理由の文（FR-115）。
//
// 文言の表（開発ガイド §5.99）。`items.ts` の `MENU_ITEM_LABEL` / `DISABLE_REASON_MESSAGE` が
// ここを引く。`messages.ts` は `items.ts` を読み込んでいるので、そこへ足すと import が輪に
// なる ―― だからこの表は何も読み込まない。
//
// 画面側の `ui/discovery/strings.ts` にも同じ文が書いてある所がある（中核は画面側を読み込め
// ない）。両者の一字一句の一致は `ui/discovery/strings.test.ts` が見ている。

export const CONTEXT_MENU_ITEM_MESSAGES = {
  // 素性欄のボタン（「この地物を全部の年から消す」）と **同じことを言う**（用語の統一）。
  delete: '全部の年から消す',
  deleteVertex: '頂点を削除',
  editProperties: 'プロパティ編集',
  createAnchorHere: 'この年に錨を作る',
  unshare: '共有解除',
  split: '分割',
  // 用語集 §H.1 の第一表記は「所属を変える」（「所属変更」は説明文の中の名詞としてだけ使う）。
  changeAffiliation: '所属を変える',
  merge: '結合',
  hideFeature: 'この地物を非表示',
  emphasizeFeature: 'この地物を強調',
  unemphasizeFeature: '強調を解除',
  markTarget: '対象に加える',
  unmarkTarget: '対象から外す',
  markSubtree: 'その全下位領域を対象にする',
  reparentMarked: '選んだものの所属をまとめて変える',
  bulkKindLabel: 'まとめて種別を付ける',
  endHere: 'この年に終わったことにする',

  disabledMergeNeedsMoreTargets:
    '結合には2つ以上の対象が必要です。結合する相手を追加してください。',
  disabledEmphasisFromOtherAxis:
    'この地物は種別または深さの強調で既に目立たせているため、個別の強調/解除では見た目が変わりません。表示 ▾ の「強調をすべて解除」で解除してください。',
  disabledAnchorAlreadyAtThisYear:
    'すでにこの年に錨があります。いまの年の姿はその錨が記録しているので、新しく作る必要はありません。',
  disabledEndHereNoOwnSeries:
    'この地物の歴史は上位領域が持っているので、ここからは終わりを打てません。先に所属を変えるか、上位領域の側で記録してください。',
} as const;
