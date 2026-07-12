// U36 context menu — item-kind identifiers, Japanese labels, disabled reasons
// (FR-96 / FR-115, 教訓 5.19).
//
// Every menu item is identified by a CONSTANT item kind, never a display string
// (教訓 5.19): composition, rendering, dispatch and tests all key on the same
// `MENU_ITEM_KIND.*` value, so the offered-set never drifts from the dispatch
// routing. Each kind maps to ONE flow ({@link FLOW_KIND}) so an item cannot be
// shown for delete but dispatched to merge by accident.
//
// LAYER: pure `domain`. Labels are the Japanese user-facing strings (FR-115);
// the UI shell renders them verbatim and does not synthesize its own copy
// (single source of truth for labels).

import { FLOW_KIND, type FlowKind } from './contracts';

export const MENU_ITEM_KIND = {
  /** 共通: 削除 (地物全体) → U31. Offered only when NO vertex is selected. */
  Delete: 'delete',
  /** 頂点削除 (選択頂点) → FR-88 vertex-delete. Offered when a vertex selection exists. */
  DeleteVertex: 'deleteVertex',
  /** 共通: プロパティ編集 → open property editor. */
  EditProperties: 'editProperties',
  /** 共有頂点: 共有解除 → U11. */
  Unshare: 'unshare',
  /** 面情報(末端): 分割 → U26. */
  Split: 'split',
  /** 面情報: 所属変更 → U28. */
  ChangeAffiliation: 'changeAffiliation',
  /** 面情報: 結合 → U30. */
  Merge: 'merge',
} as const;

export type MenuItemKind = (typeof MENU_ITEM_KIND)[keyof typeof MENU_ITEM_KIND];

/** The flow each item kind dispatches to (one-to-one; 教訓 5.19). */
export const ITEM_FLOW: Readonly<Record<MenuItemKind, FlowKind>> = {
  [MENU_ITEM_KIND.Delete]: FLOW_KIND.Delete,
  [MENU_ITEM_KIND.DeleteVertex]: FLOW_KIND.DeleteVertex,
  [MENU_ITEM_KIND.EditProperties]: FLOW_KIND.EditProperties,
  [MENU_ITEM_KIND.Unshare]: FLOW_KIND.Unshare,
  [MENU_ITEM_KIND.Split]: FLOW_KIND.Split,
  [MENU_ITEM_KIND.ChangeAffiliation]: FLOW_KIND.ChangeAffiliation,
  [MENU_ITEM_KIND.Merge]: FLOW_KIND.Merge,
};

/** Japanese user-facing label per item kind (FR-115). */
export const MENU_ITEM_LABEL: Readonly<Record<MenuItemKind, string>> = {
  [MENU_ITEM_KIND.Delete]: '削除',
  [MENU_ITEM_KIND.DeleteVertex]: '頂点を削除',
  [MENU_ITEM_KIND.EditProperties]: 'プロパティ編集',
  [MENU_ITEM_KIND.Unshare]: '共有解除',
  [MENU_ITEM_KIND.Split]: '分割',
  [MENU_ITEM_KIND.ChangeAffiliation]: '所属変更',
  [MENU_ITEM_KIND.Merge]: '結合',
};

// --- Disabled reasons (出るが無効=グレーアウト, spec §2.1 / §4.4) ------------
//
// An item can be SHOWN-BUT-DISABLED with a reason (FR-115 Japanese), distinct
// from being OMITTED. The composer uses these for the "面情報だが今は不可" cases
// the spec fixes in acceptance (e.g. merge needs ≥2 targets, FR-52).

export const DISABLE_REASON = {
  /** 結合は2つ以上の対象が必要 (FR-52). Seeded with one → disabled with this reason. */
  MergeNeedsMoreTargets: 'mergeNeedsMoreTargets',
} as const;

export type DisableReason =
  (typeof DISABLE_REASON)[keyof typeof DISABLE_REASON];

/** Japanese message per disable reason (FR-115). */
export const DISABLE_REASON_MESSAGE: Readonly<Record<DisableReason, string>> = {
  [DISABLE_REASON.MergeNeedsMoreTargets]:
    '結合には2つ以上の対象が必要です。結合する相手を追加してください。',
};

/**
 * One composed menu item (ContextMenuItem, spec §4.8). An immutable value with
 * the constant kind, its Japanese label, enabled/disabled state + reason, and
 * the flow it dispatches to. The `enabled: false` branch carries a reason so
 * the UI can show it grayed-out with a tooltip (FR-115); the `enabled: true`
 * branch carries none.
 */
export type ContextMenuItem =
  | {
      readonly kind: MenuItemKind;
      readonly label: string;
      readonly flow: FlowKind;
      readonly enabled: true;
    }
  | {
      readonly kind: MenuItemKind;
      readonly label: string;
      readonly flow: FlowKind;
      readonly enabled: false;
      readonly disableReason: DisableReason;
    };

/** Build an enabled item from its kind (label + flow looked up by kind). */
export function enabledItem(kind: MenuItemKind): ContextMenuItem {
  return {
    kind,
    label: MENU_ITEM_LABEL[kind],
    flow: ITEM_FLOW[kind],
    enabled: true,
  };
}

/** Build a shown-but-disabled item from its kind + reason. */
export function disabledItem(
  kind: MenuItemKind,
  disableReason: DisableReason,
): ContextMenuItem {
  return {
    kind,
    label: MENU_ITEM_LABEL[kind],
    flow: ITEM_FLOW[kind],
    enabled: false,
    disableReason,
  };
}
