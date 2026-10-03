// 読み込み・保存・修復の利用者向けの文（FR-115 / 技術方針 5.5）。
//
// 文言の表（開発ガイド §5.99）。`boundary.ts`（読み込みの入口の断り）・`pre-save.ts`
// （保存の前の点検）・`repair.ts`（修復の選択肢）がここを引く。この表は何も読み込まない
// （読み込む側との import の輪を作らないため）。
//
// 名前や年を埋め込む文は、組み立てをここに置いた小さな関数にしてある。数や名前の
// 計算（`String(...)`・件数の数え上げ）は呼ぶ側に残し、ここでは埋め込むだけにする。

export const PERSISTENCE_MESSAGES = {
  // --- 読み込みの入口（boundary.ts） ---
  versionMissing:
    'ファイル形式のバージョン情報が見つかりません。対応していない、または壊れたファイルの可能性があります。',
  versionIncompatible:
    'このファイルは現在のバージョンでは対応していない形式です。読み込みを中止しました。',
  invalid: 'ファイルの内容が壊れているか、形式が正しくありません。読み込みできませんでした。',

  // --- 保存を止める文（pre-save.ts の preSaveBlockMessage） ---
  preSaveOrphanOne: (name: string): string => `持ち主の居ない歴史が 1 件あります（${name}）`,
  preSaveOrphanMany: (count: number, name: string): string =>
    `持ち主の居ない歴史が ${count} 件あります（${name} ほか）`,
  preSaveDanglingOne: (name: string): string =>
    `消えた上位領域を指している地物が 1 件あります（${name}）`,
  preSaveDanglingMany: (count: number, name: string): string =>
    `消えた上位領域を指している地物が ${count} 件あります（${name} ほか）`,
  /** 止める理由を 1 文に繋ぐときの区切り。 */
  preSaveHeadSeparator: '。',
  preSaveBlocked: (heads: string): string =>
    `保存を中止しました: ${heads}。このまま保存すると、開き直したときに地物が失われます。直前の操作を Ctrl+Z で取り消してから保存してください。`,

  // --- 保存の前に聞く板の 1 行（pre-save.ts の preSaveConfirmLines） ---
  preSaveParentAbsent: (name: string, year: string, parentName: string): string =>
    `「${name}」は${year}に、その年には居ない上位領域「${parentName}」を指しています`,
  preSaveParentAbsentRepair: ' → 次に開くと、上位領域が居ない年の間だけ最上位にします',
  /** 食い違っている下位領域の名前を並べるときの区切り。 */
  preSaveRelatedSeparator: '・',
  preSaveChildListMismatch: (name: string, year: string): string =>
    `「${name}」の下位領域の一覧が、${year}の実際の所属と食い違っています`,
  preSaveChildListMismatchWithRelated: (name: string, year: string, related: string): string =>
    `「${name}」の下位領域の一覧が、${year}の実際の所属と食い違っています（${related}）`,
  preSaveChildListMismatchRepair: ' → 次に開くと、一覧を各年の実際の所属に合わせます',
  preSaveEmptyAggregate: (name: string, year: string): string =>
    `まとめ役「${name}」には、${year}に下位領域が 1 件もありません`,
  preSaveEmptyAggregateRepairable: (name: string): string =>
    ` → 次に開くと、下位領域の居ない年の間だけ「${name}」を無くします（ほかの年の記録は残ります）`,
  preSaveEmptyAggregateAsk:
    ' → 次に開くと、どうするかを聞かれます（このまとめ役には下位領域の居る年が無いため、読み込みから外すことになります）',
  preSaveTopologyOther: (name: string, year: string): string =>
    `「${name}」の上位領域のつながりが、${year}に食い違っています → 次に開くと直し方を聞かれます`,

  // --- 修復の選択肢（repair.ts の LABELS） ---
  repairDropFeatureWithMissingVertex: '存在しない頂点を参照している地物を読み込みから除外します。',
  repairDetachToTopLevel: '親参照を解除して、この地物を最上位に変更します（全部の年で）。',
  repairDetachToTopLevelWithin:
    '上位領域が居ない年の間だけ、この地物を最上位にします（ほかの年の所属と記録はそのまま残ります）。',
  repairRemoveEmptyAggregateIntervals:
    '下位領域が 1 件も居ない年の間だけ、このまとめ役を無くします（下位領域の居る年の記録はそのまま残ります）。',
  repairDropTopologyFeature: '階層が壊れている地物を読み込みから除外します。',
  repairReconcileChildIds:
    '集約地物の下位領域一覧（childIds）を、各地物の親参照（parentId）に合わせて再構築します。',
  repairDropShapeRoleFeature: '形状の規則に違反している地物を読み込みから除外します。',
  repairMaterializeDirectDomain:
    '直轄領（元の形状から下位領域を除いた領域）を生成して集約化し、元の領域を保持したまま修復します（地物は削除しません）。',
  repairKeepLeafWithChildren:
    'この地物をそのまま残して読み込みます（記録は何も変えません。下位領域と重なって見えるので、あとで整えてください）。',
  repairKeepOverlap: 'そのまま残して読み込みます（重なりは残ります。記録は何も変えません）。',
  repairDropRingHierarchyFeature:
    'リング階層（領土と穴の入れ子関係・包含）が壊れている地物を読み込みから除外します。',
  repairDropOverlappingFeature: '重なっている地物の一方を読み込みから除外します。',
  repairDropAggregateFeature: '下位領域と一致しない集約地物を除外し、下位を最上位化します。',
  repairNormalizeSeries: '錨を時間順に整列し、重複・矛盾を解消します。',
  // 「空のタイムライン」と呼んでいたが、持ち主が居ないだけで中には地物の記録が残っている
  // （中身のある歴史を「空」と言うのは事実と違う）。本体の取り込みで言い直した。
  repairDropOrphanHistory:
    '持ち主の居ない歴史を、中に残っている地物の記録ごと読み込みから除外します（中の地物も消えます）。',
  repairMaterializeOrphanHistory:
    '持ち主の居ない歴史の中に残っている地物を、全部の年ぶん地物ごとの歴史へ移します（地物は削除しません）。',
  repairDropDuplicateOwnerHistories:
    '同一地物を所有する歴史が複数あるとき、先頭の歴史のみを残して重複分を読み込みから除外します。',
  repairReconcileVertexCoordinate:
    '同一の頂点が歴史間で異なる座標を持つとき、最初に現れた座標へすべて揃えます。',
} as const;
