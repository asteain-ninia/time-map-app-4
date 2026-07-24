// U36 context menu — the PURE composition function (FR-96, 教訓 5.10 / 5.13 /
// 5.19 / 5.25 / 5.27).
//
// `composeContextMenu(input) → ContextMenuModel | NO_MENU` is the single source
// of truth for "which items, in which state, for the current selection" (spec
// §4.1). It is副作用なしの純粋関数 so Vitest runs it alone (技術方針 2.5). The
// shell calls it on right-click and renders the resulting model; the SAME
// composition feeds any future shortcut-availability hints (spec §4.1 単一の真
// 実源, drift防止).
//
// 出し分け規約 (FR-96):
//   共通 (点/線/面いずれでも): 削除・プロパティ編集
//   共有頂点を1つ以上含む    : 共有解除
//   面情報(末端=leaf)        : 分割・所属変更・結合
//
// CRITICAL discipline:
//   - 教訓 5.13: a SINGLE permission flag (`canEdit`) gates the WHOLE function —
//     view-only returns NO_MENU, generating zero edit items. No per-item check.
//   - 教訓 5.10: the RAW selection (active 0/1, vertex set 空/単一/複数/所有者
//     不明) is evaluated to the raw values; each state maps one-to-one to an
//     offered set. 空選択 → NO_MENU.
//   - 教訓 5.25: 分割 is leaf-ONLY. An aggregate never gets分割 "for symmetry".
//   - 教訓 5.27: 結合(U30) and 所属変更(U28) are separate items / separate flows.
//   - 教訓 5.18: emptiness (vertex set size, owners) is decided by length, not a
//     falsy short-circuit.
//
// LAYER: pure `domain`. No React / Electron import.

import { assertNever } from '../assert-never';
import { CONTEXT_KIND, type VertexContext } from '../selection/context';
import type { FeatureId, VertexId } from '../ids';

import {
  FEATURE_KIND,
  MENU_TOOL_KIND,
  type AxisEmphasisLookup,
  type FeatureKind,
  type FeatureKindLookup,
  type MenuToolKind,
  type SharedVertexLookup,
} from './contracts';
import {
  DISABLE_REASON,
  MENU_ITEM_KIND,
  type ContextMenuItem,
  disabledItem,
  enabledItem,
} from './items';

// --- Screen position (a local plain {x,y}; no render/ui import) --------------
//
// The menu's display position is screen pixels. We keep a minimal local type so
// the domain layer stays free of any render/ui import (技術方針 2.13 内向き依存).
export interface MenuPosition {
  readonly x: number;
  readonly y: number;
}

// --- Composition input -------------------------------------------------------
//
// The whole input the composer needs (spec §4.1). RAW selection values (教訓
// 5.10) plus the analyzed vertex context (U22 truth), the right-click position,
// the optionally-hit element, the tool kind, the permission flag, and the two
// injected lookups (kind / shared) that are the single sources for feature kind
// and shared判定 (教訓 5.29).

export interface ComposeInput {
  /** Active feature (FR-79): exactly 0 or 1. */
  readonly activeFeature: FeatureId | null;
  /** RAW vertex-selection set (FR-80). Evaluated to its raw size (教訓 5.10). */
  readonly vertexIds: ReadonlySet<VertexId>;
  /** U22's analyzed vertex context (FR-81) — single/multi/unknown/empty. */
  readonly vertexContext: VertexContext;
  /** The vertex the right-click hit, if any (the unshare first候補, §4.3). */
  readonly hitVertexId: VertexId | null;
  /** Where the menu should open (screen pixels). */
  readonly position: MenuPosition;
  /** Current tool kind (FR-96 input). */
  readonly toolKind: MenuToolKind;
  /** The ONE permission gate (教訓 5.13). false ⇒ NO_MENU. */
  readonly canEdit: boolean;
  /** Single source for the target feature's kind (教訓 5.19). */
  readonly featureKindLookup: FeatureKindLookup;
  /** Single source for "is this vertex shared" (FR-33, 教訓 5.29). */
  readonly sharedLookup: SharedVertexLookup;
  /**
   * The session's PER-FEATURE 強調集合 (FR-113 Phase 2 — the store's
   * `filter.emphasizedIds`, handed in verbatim: this is a VALUE, not a re-derivation).
   * It decides WHICH of the mutually-exclusive 強調 / 強調解除 items is offered — the exact
   * channel the item writes, so the LABEL always names the membership it will flip.
   *
   * It does NOT decide whether that item is ENABLED: the PAINTED emphasis is the union of
   * this set with the 種別/深度 axes, so a target already emphasized by an axis would not
   * change appearance either way. {@link ComposeInput.axisEmphasisLookup} is the second
   * axis of that 3-state出し分け (see it for the full rule).
   */
  readonly emphasizedFeatureIds: ReadonlySet<FeatureId>;
  /**
   * "Is this feature emphasized by a channel OTHER than {@link emphasizedFeatureIds}?"
   * (FR-113 Phase 2 — the 種別/深度 強調軸, derived by the caller from the SAME resolution
   * the map paints, 教訓 5.29).
   *
   * WHY: the 強調/強調解除 item writes the PER-FEATURE channel only, while what the user
   * SEES is the union. With 面 種別強調 ON, adding an area to (or removing it from) the
   * per-feature set dims/undims nothing — the label would promise an effect that never
   * happens (出す≠起きる, 教訓 5.6). So the pair is offered in THREE states, not two:
   *   - not axis-emphasized, not in the set → 「この地物を強調」 ENABLED;
   *   - not axis-emphasized, in the set     → 「強調を解除」 ENABLED;
   *   - axis-emphasized (either membership) → the same label, SHOWN-BUT-DISABLED with
   *     {@link DISABLE_REASON.EmphasisFromOtherAxis} pointing at the panel's
   *     「強調をすべて解除」— the ONE action that does clear the 種別/深度 axis.
   */
  readonly axisEmphasisLookup: AxisEmphasisLookup;
}

// --- Resolved menu target (UI 文脈優先, 教訓 5.3 / 5.4) ----------------------
//
// The操作対象 is "what is selected now" — active feature first, else a SINGLE
// owner vertex context (§4.2). A multi/unknown owner cannot name one feature, so
// feature-wide items (分割/所属変更/結合) are omitted there (受け入れ基準 8).

export const MENU_TARGET_KIND = {
  /** Active feature is the target (FR-79 priority). */
  Feature: 'feature',
  /** No active feature; only a vertex selection (possible shared頂点 only). */
  VertexOnly: 'vertexOnly',
  /** Nothing actionable selected → no menu. */
  None: 'none',
} as const;

export type MenuTargetKind =
  (typeof MENU_TARGET_KIND)[keyof typeof MENU_TARGET_KIND];

/**
 * The resolved target. `Feature` carries the feature id + kind (feature-wide
 * items可); `VertexOnly` carries the owner (if single) WITH its resolved kind so
 * the SAME feature-wide items the composer offered can also dispatch (出す=発火
 * できる, 受け入れ基準 6/8, 教訓 5.6); `None` carries nothing.
 *
 * BOTH actionable variants carry `sharedVertexIds` — the共有頂点部分集合 of the
 * selection (NOT the whole set). The composer computes it once from the injected
 * lookup; the dispatch hands EXACTLY this subset to U11 so non-shared vertices
 * are never sent as unshare targets (contracts.ts payload semantics「≥1 shared」,
 * 教訓 5.29 単一の真実源).
 */
export type MenuTarget =
  | {
      readonly kind: typeof MENU_TARGET_KIND.Feature;
      readonly featureId: FeatureId;
      readonly featureKind: FeatureKind;
      readonly vertexIds: ReadonlySet<VertexId>;
      /** The shared subset of `vertexIds` (the unshare対象, §4.3). */
      readonly sharedVertexIds: ReadonlySet<VertexId>;
    }
  | {
      readonly kind: typeof MENU_TARGET_KIND.VertexOnly;
      /** Single owner of the vertex set, or null (multi/unknown). */
      readonly ownerFeatureId: FeatureId | null;
      /**
       * The single owner's resolved kind, or null when there is no single owner
       * (multi/unknown) OR the owner's kind cannot be resolved. Carried so the
       * dispatch can fire the feature-wide items the composer offered without the
       * shell re-resolving the kind (受け入れ基準 6/8, 教訓 5.19).
       */
      readonly ownerFeatureKind: FeatureKind | null;
      readonly vertexIds: ReadonlySet<VertexId>;
      /** The shared subset of `vertexIds` (the unshare対象, §4.3). */
      readonly sharedVertexIds: ReadonlySet<VertexId>;
    }
  | { readonly kind: typeof MENU_TARGET_KIND.None };

/**
 * Resolve the menu target from the RAW selection (教訓 5.3 / 5.4 / 5.10). Active
 * feature wins; else a non-empty vertex set yields VertexOnly (with the single
 * owner if the context resolves to one); else None. The data source is never
 * scanned for a default (教訓 5.4).
 */
export function resolveMenuTarget(input: ComposeInput): MenuTarget {
  // The共有頂点部分集合 is computed ONCE here from the injected lookup (教訓 5.29
  // 単一の真実源) and carried on the target so dispatch hands U11 exactly the
  // shared vertices — never the whole selection (contracts payload「≥1 shared」).
  const shared = sharedVerticesIn(input.vertexIds, input.sharedLookup);

  // Active feature first (UI 文脈優先, 教訓 5.3).
  if (input.activeFeature !== null) {
    const fk = input.featureKindLookup.kindOf(input.activeFeature);
    // Unresolvable active feature → no actionable target (no default fallback).
    if (fk === null) {
      return { kind: MENU_TARGET_KIND.None };
    }
    return {
      kind: MENU_TARGET_KIND.Feature,
      featureId: input.activeFeature,
      featureKind: fk,
      vertexIds: new Set(input.vertexIds),
      sharedVertexIds: shared,
    };
  }

  // No active feature: a non-empty vertex set is the only other actionable case
  // (教訓 5.18: decide on the set's size, not a falsy short-circuit).
  if (input.vertexIds.size === 0) {
    return { kind: MENU_TARGET_KIND.None };
  }

  // A single-owner vertex context can name a feature → that feature's kind lets
  // feature-wide items be offered AND dispatched (§4.2, 受け入れ基準 6/8). Resolve
  // the kind HERE (the single source, 教訓 5.19) and carry it so the dispatch
  // does not depend on the shell re-resolving it. Multi/Unknown name no single
  // feature → both owner id and kind are null (feature-wide items omitted).
  const ctx = input.vertexContext;
  const ownerFeatureId = ctx.kind === CONTEXT_KIND.Single ? ctx.ownerFeatureId : null;
  const ownerFeatureKind =
    ownerFeatureId === null ? null : input.featureKindLookup.kindOf(ownerFeatureId);
  return {
    kind: MENU_TARGET_KIND.VertexOnly,
    ownerFeatureId,
    ownerFeatureKind,
    vertexIds: new Set(input.vertexIds),
    sharedVertexIds: shared,
  };
}

// --- The composed model ------------------------------------------------------

export const NO_MENU = { kind: 'noMenu' } as const;
export type NoMenu = typeof NO_MENU;

/**
 * The composed menu (ContextMenuModel, spec §4.8): the resolved target, the
 * ordered item list, and the screen position. Immutable value. The empty-
 * selection / view-only cases are the SEPARATE {@link NO_MENU} value rather than
 * a model with zero items, so "no menu at all" and "menu with disabled items"
 * are distinct states (教訓 5.18).
 */
export interface ContextMenuModel {
  readonly kind: 'menu';
  readonly target: MenuTarget;
  readonly items: readonly ContextMenuItem[];
  readonly position: MenuPosition;
}

// --- Shared-vertex detection over the RAW set (FR-33, 教訓 5.10 / 5.29) ------

/** The shared vertices within the selection set (the unshare对象, §4.3). */
function sharedVerticesIn(
  vertexIds: ReadonlySet<VertexId>,
  lookup: SharedVertexLookup,
): Set<VertexId> {
  const shared = new Set<VertexId>();
  for (const vid of vertexIds) {
    if (lookup.isShared(vid)) shared.add(vid);
  }
  return shared;
}

// --- Item-set builders (出し分け規約, FR-96) ---------------------------------

/** 面情報項目 for a LEAF target: 分割(末端限定)・所属変更・結合 (§4.4). */
function leafFeatureItems(): ContextMenuItem[] {
  return [
    // 分割: leaf-only (FR-44, 教訓 5.25). Reached only on the leaf branch.
    enabledItem(MENU_ITEM_KIND.Split),
    // 所属変更 (U28) — distinct concept/flow from結合 (教訓 5.27).
    enabledItem(MENU_ITEM_KIND.ChangeAffiliation),
    // 結合 (U30) — seeded with one target; needs ≥2 (FR-52). Shown DISABLED with
    // a reason so the user knows追加対象が要る (spec §4.4 受け入れ基準で固定).
    disabledItem(MENU_ITEM_KIND.Merge, DISABLE_REASON.MergeNeedsMoreTargets),
  ];
}

/**
 * The削除 item, granularity chosen to MATCH what the live delete funnel
 * (COMMAND_ID.EditDelete → runEditDelete) will actually do given the selection (教訓
 * 5.6, 出す=起きる):
 *   - a vertex selection is present → 頂点を削除 (FR-88 頂点削除, reshapes the feature);
 *   - no vertex selection → 削除 (地物全体, FR-85 全錨削除).
 * This is the Delete×VertexOnly / vertex-hit 乖離解消: 削除 never shows「地物削除」when the
 * user has vertices selected (would be data loss), and 頂点を削除 never shows when the
 * whole feature is the target.
 */
function deleteItemFor(hasVertexSelection: boolean): ContextMenuItem {
  return hasVertexSelection
    ? enabledItem(MENU_ITEM_KIND.DeleteVertex)
    : enabledItem(MENU_ITEM_KIND.Delete);
}

/**
 * The feature a 表示制御 item (個別非表示 / 強調 / 強調解除) can target: a Feature target's
 * own id, or a single-owner VertexOnly target's resolved owner. Returns null for a
 * multi/unknown owner or a None target — the SAME condition {@link dispatchMenuItem}'s
 * `featureTargetOf` resolves, so 出す=発火できる (教訓 5.6). These ops are display-only,
 * so they do NOT depend on the owner KIND (unlike 分割/所属変更); but keeping the
 * condition aligned with featureTargetOf (owner id AND kind) keeps compose/dispatch in
 * lock-step and avoids offering an item the dispatch would block.
 */
function displayControlFeatureId(target: MenuTarget): FeatureId | null {
  switch (target.kind) {
    case MENU_TARGET_KIND.Feature:
      return target.featureId;
    case MENU_TARGET_KIND.VertexOnly:
      return target.ownerFeatureId !== null && target.ownerFeatureKind !== null
        ? target.ownerFeatureId
        : null;
    case MENU_TARGET_KIND.None:
      return null;
    default:
      return assertNever(target);
  }
}

/**
 * Compose the context menu (FR-96 / FR-113). Returns {@link NO_MENU} when nothing
 * actionable is selected (教訓 5.10 / 5.18); otherwise a model with the offered items
 * in a stable order.
 *
 * EDIT items (削除・プロパティ編集・面情報・共有解除) require editing permission — in
 * 表示専用モード (canEdit=false) they are ALL suppressed (教訓 5.13 一括無効化). The
 * DISPLAY-only 表示制御 items (FR-113 個別非表示 + Phase 2 強調/強調解除) are session display
 * ops, not edits, so they are offered even in View mode for any resolvable single-feature
 * target — the items that survive the view-only gate (ユーザー裁定: View モードでも可).
 *
 * Order: common (削除・プロパティ編集) → 面情報 (分割・所属変更・結合, leaf only)
 * → 共有解除 (when shared vertices present) → 表示制御 (個別非表示 → 強調/強調解除, last). The tool kind
 * is part of the input (FR-96): the knife tool, already in a split session, omits the
 * redundant 分割 item (受け入れ基準 4: 項目集合がツール種類で変わる).
 */
export function composeContextMenu(input: ComposeInput): ContextMenuModel | NoMenu {
  const target = resolveMenuTarget(input);
  if (target.kind === MENU_TARGET_KIND.None) {
    return NO_MENU; // 空選択: メニューを構成しない (受け入れ基準 1).
  }

  const items: ContextMenuItem[] = [];

  // 編集項目: 教訓 5.13 — 表示専用モード (canEdit=false) では一括無効化 (0 件). Only the
  // display-only 個別非表示 below survives view-only.
  if (input.canEdit) {
    switch (target.kind) {
      case MENU_TARGET_KIND.Feature: {
        // 共通項目 (点/線/面いずれでも): 削除 vs 頂点を削除 by whether vertices are selected.
        items.push(deleteItemFor(target.vertexIds.size > 0));
        items.push(enabledItem(MENU_ITEM_KIND.EditProperties));
        // 面情報項目: leaf(末端) ONLY (教訓 5.25). Aggregate gets NO 分割; its
        // affiliation/merge出し分けは U28/U30 契約に委ねるため、ここでは leaf に限
        // って面情報項目を出す (受け入れ基準 2).
        if (target.featureKind === FEATURE_KIND.Leaf) {
          items.push(...filterByTool(leafFeatureItems(), input.toolKind));
        }
        // 共有解除: a Feature target ALWAYS names a resolvable owner (the active feature),
        // so unshare is owner-qualified — offered whenever a shared頂点 is in the selection.
        if (target.sharedVertexIds.size > 0) {
          items.push(enabledItem(MENU_ITEM_KIND.Unshare));
        }
        break;
      }
      case MENU_TARGET_KIND.VertexOnly: {
        // A VertexOnly target only acts when a SINGLE owner resolves (受け入れ基準 8):
        //   - owner unknown/multi → NO feature-wide items AND NO 共有解除. 共有解除 is
        //     OWNER-QUALIFIED (右クリック「共有解除」= この所有者の参照を剥がす): without a
        //     confirmed owner the reresolve cannot remap the selection (owner-null dangling
        //     guard), so it is not offered at all.
        //   - single owner → 頂点を削除 (a VertexOnly always has a vertex selection) +
        //     プロパティ編集 + (leaf面情報) + 共有解除(if shared). The owner kind was resolved
        //     once on the target (教訓 5.19); the dispatch reads the SAME owner/kind so every
        //     offered item fires (出す=発火できる, 受け入れ基準 6/8, 教訓 5.6).
        if (target.ownerFeatureId !== null && target.ownerFeatureKind !== null) {
          items.push(enabledItem(MENU_ITEM_KIND.DeleteVertex));
          items.push(enabledItem(MENU_ITEM_KIND.EditProperties));
          if (target.ownerFeatureKind === FEATURE_KIND.Leaf) {
            items.push(...filterByTool(leafFeatureItems(), input.toolKind));
          }
          if (target.sharedVertexIds.size > 0) {
            items.push(enabledItem(MENU_ITEM_KIND.Unshare));
          }
        }
        break;
      }
      default:
        // None was returned before the switch; the residual union is never here.
        return assertNever(target);
    }
  }

  // 表示制御項目 (FR-113) — display-only, offered REGARDLESS of canEdit for any resolvable
  // single-feature target. Placed LAST so the edit item order is unchanged. 個別非表示 first,
  // then the 強調 pair: exactly ONE of 「この地物を強調」/「強調を解除」 is offered, its LABEL
  // chosen by the target's CURRENT membership in the per-feature 強調集合 (the channel the
  // item writes) and its ENABLED state by whether the 種別/深度軸 already emphasizes it —
  // an axis-emphasized target would not change appearance either way, so the item is shown
  // DISABLED with the reason instead of firing a no-op (出す=起きる, 教訓 5.6).
  const displayTargetId = displayControlFeatureId(target);
  if (displayTargetId !== null) {
    items.push(enabledItem(MENU_ITEM_KIND.HideFeature));
    const emphasisItemKind = input.emphasizedFeatureIds.has(displayTargetId)
      ? MENU_ITEM_KIND.UnemphasizeFeature
      : MENU_ITEM_KIND.EmphasizeFeature;
    items.push(
      input.axisEmphasisLookup.isEmphasizedByOtherAxis(displayTargetId)
        ? disabledItem(emphasisItemKind, DISABLE_REASON.EmphasisFromOtherAxis)
        : enabledItem(emphasisItemKind),
    );
  }

  // メニュー項目 0 件 (例: view-only + owner 不確定, または vertex-only + multi-owner +
  // 共有頂点なし) は出さない (教訓 5.18: 件数で判定). 何も操作できない右クリックではメニュー
  // を開かない.
  if (items.length === 0) {
    return NO_MENU;
  }

  return {
    kind: 'menu',
    target,
    items,
    position: input.position,
  };
}

/**
 * Tool-kind出し分け (FR-96 受け入れ基準 4). When the knife tool is already
 * active the user is mid-split, so the redundant 分割 launch item is dropped —
 * the offered set changes with the tool kind. Other tools keep the full leaf set.
 */
function filterByTool(
  leafItems: readonly ContextMenuItem[],
  toolKind: MenuToolKind,
): ContextMenuItem[] {
  if (toolKind === MENU_TOOL_KIND.Knife) {
    return leafItems.filter((it) => it.kind !== MENU_ITEM_KIND.Split);
  }
  return [...leafItems];
}
