// UI layer (U21 / 時刻レール): **レールの右クリックの中身**（設計書 §I.3 の「時刻レールの
// 錨の印」「時刻レールの空白」。増分 7 の申し送り §10 の 1 つ目）。
//
// **中身の操作はどれも既存の経路を呼ぶだけ**で、新しい操作は作らない（依頼書の条件）:
//   - 移動 … レールの `jumpTo`（クリックと同じ 1 本）
//   - 開始年を変える … 素性欄の錨表の「存続期間」の欄を開いて開始の欄へ焦点を置く
//   - 消す … 素性欄の錨表と同じ影響の板 → 同じ `buildDeleteAnchorIntent`
//   - この年に錨を作る … その年へ移動してから `edit.createAnchorHere`（Ctrl+K と同じ）
//   - 左端にする … レールの横スクロール（Shift＋ホイールと同じ `scrollByPixels`）
//   - 全体表示 … 操作列の［全体］と同じ `fitAll`
//
// 「この錨から後を切る」は **載せていない**（実装係 2 の判断。進捗 増分7.md §12.6）。
// 既存の操作 1 つに写せない ―― 存続期間の終わりは次の錨の手前までしか打てず
// （U09 `setEnd` の `endBeyondNextEnd`）、「後を切る」は後ろの錨を全部消す合成になる。
// 何を切るのか（後ろの錨を消すのか、その年で終わらせるのか）を所有者に聞いてから足す。
//
// 組み立ては純粋で、可否と理由をここ 1 か所で決める（出す=起きる、教訓 5.6）。

import { RAIL_STRINGS } from './rail-strings';

export const RAIL_MENU_ITEM = {
  JumpToAnchor: 'jumpToAnchor',
  ChangeAnchorStart: 'changeAnchorStart',
  DeleteAnchor: 'deleteAnchor',
  JumpHere: 'jumpHere',
  CreateAnchorHere: 'createAnchorHere',
  MakeLeftEdge: 'makeLeftEdge',
  FitAll: 'fitAll',
} as const;

export type RailMenuItemId = (typeof RAIL_MENU_ITEM)[keyof typeof RAIL_MENU_ITEM];

export interface RailMenuItem {
  readonly id: RailMenuItemId;
  readonly label: string;
  readonly enabled: boolean;
  /** 押せない理由（押せるなら null）。 */
  readonly reason: string | null;
}

/** 右クリックした場所の種類と、そこで判断に要る事実。 */
export type RailMenuInput =
  | {
      readonly kind: 'anchor';
      /** 直せるか（鍵が開いているか）。 */
      readonly editable: boolean;
      /** 親の系列から借りた印なら、その持ち主の名前。自分の系列なら null。 */
      readonly inheritedOwner: string | null;
      /** 系列の最後の 1 本か。 */
      readonly soleAnchor: boolean;
    }
  | {
      readonly kind: 'empty';
      readonly editable: boolean;
      /** 地物を選んでいるか。 */
      readonly hasSelection: boolean;
      /** 押した年に、選んでいる地物の錨が既にあるか。 */
      readonly anchorAtYear: boolean;
    };

function item(id: RailMenuItemId, label: string, reason: string | null): RailMenuItem {
  return { id, label, enabled: reason === null, reason };
}

export function composeRailMenu(input: RailMenuInput): readonly RailMenuItem[] {
  if (input.kind === 'anchor') {
    // 直す 2 項目の可否は同じ順で見る: 読むだけ → 借りた印 → 最後の 1 本（消すだけ）。
    const editReason = !input.editable
      ? RAIL_STRINGS.menuReasonViewOnly
      : input.inheritedOwner !== null
        ? RAIL_STRINGS.menuReasonInherited(input.inheritedOwner)
        : null;
    return [
      item(RAIL_MENU_ITEM.JumpToAnchor, RAIL_STRINGS.menuJumpToAnchor, null),
      item(RAIL_MENU_ITEM.ChangeAnchorStart, RAIL_STRINGS.menuChangeAnchorStart, editReason),
      item(
        RAIL_MENU_ITEM.DeleteAnchor,
        RAIL_STRINGS.menuDeleteAnchor,
        editReason ?? (input.soleAnchor ? RAIL_STRINGS.menuReasonSoleAnchor : null),
      ),
    ];
  }
  const createReason = !input.editable
    ? RAIL_STRINGS.menuReasonViewOnly
    : !input.hasSelection
      ? RAIL_STRINGS.menuReasonNoSelection
      : input.anchorAtYear
        ? RAIL_STRINGS.menuReasonAnchorExists
        : null;
  return [
    item(RAIL_MENU_ITEM.JumpHere, RAIL_STRINGS.menuJumpHere, null),
    item(RAIL_MENU_ITEM.CreateAnchorHere, RAIL_STRINGS.menuCreateAnchorHere, createReason),
    item(RAIL_MENU_ITEM.MakeLeftEdge, RAIL_STRINGS.menuMakeLeftEdge, null),
    item(RAIL_MENU_ITEM.FitAll, RAIL_STRINGS.menuFitAll, null),
  ];
}
