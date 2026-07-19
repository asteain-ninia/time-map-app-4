// U36 — dispatch tests (受け入れ基準 6, 7, 9, 12).
//
// Each chosen item maps to ONE flow launch intent for the existing flow
// (U11/U26/U28/U30/U31) or "open property editor", with the correct target —
// the same flow the UI button uses (教訓 5.6). Disabled items never fire (教訓
// 5.13). Stale / mismatched items block instead of dispatching.

import { describe, expect, it } from 'vitest';

import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { FEATURE_KIND } from '../feature';

import { FLOW_KIND } from './contracts';
import { MENU_ITEM_KIND } from './items';
import {
  MENU_TARGET_KIND,
  type ContextMenuModel,
  type MenuTarget,
} from './compose';
import {
  DISPATCH_BLOCKED_KIND,
  dispatchMenuItem,
  isBlocked,
} from './dispatch';
import { enabledItem, disabledItem } from './items';
import { DISABLE_REASON } from './items';

const fid = (s: string): FeatureId => asFeatureId(s);
const vid = (s: string): VertexId => asVertexId(s);
const POS = { x: 0, y: 0 };

function leafModel(extra: Partial<ContextMenuModel> = {}): ContextMenuModel {
  const target: MenuTarget = {
    kind: MENU_TARGET_KIND.Feature,
    featureId: fid('a'),
    featureKind: FEATURE_KIND.Leaf,
    vertexIds: new Set([vid('v1')]),
    sharedVertexIds: new Set([vid('v1')]),
  };
  return {
    kind: 'menu',
    target,
    position: POS,
    items: [
      enabledItem(MENU_ITEM_KIND.Delete),
      enabledItem(MENU_ITEM_KIND.EditProperties),
      enabledItem(MENU_ITEM_KIND.Split),
      enabledItem(MENU_ITEM_KIND.ChangeAffiliation),
      disabledItem(MENU_ITEM_KIND.Merge, DISABLE_REASON.MergeNeedsMoreTargets),
      enabledItem(MENU_ITEM_KIND.Unshare),
    ],
    ...extra,
  };
}

describe('dispatchMenuItem — FR-113 個別非表示 (HideFeature)', () => {
  it('この地物を非表示 → HideFeature 意図 (対象 feature id)', () => {
    const model = leafModel({ items: [enabledItem(MENU_ITEM_KIND.HideFeature)] });
    const r = dispatchMenuItem(MENU_ITEM_KIND.HideFeature, model);
    expect(r).toEqual({ kind: FLOW_KIND.HideFeature, featureId: fid('a') });
  });

  it('対象 feature が解決できなければブロック (multi/unknown owner の VertexOnly)', () => {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.VertexOnly,
      ownerFeatureId: null,
      ownerFeatureKind: null,
      vertexIds: new Set([vid('v1')]),
      sharedVertexIds: new Set(),
    };
    const model: ContextMenuModel = {
      kind: 'menu',
      target,
      position: POS,
      items: [enabledItem(MENU_ITEM_KIND.HideFeature)],
    };
    const r = dispatchMenuItem(MENU_ITEM_KIND.HideFeature, model);
    expect(isBlocked(r)).toBe(true);
    if (isBlocked(r)) expect(r.blocked).toBe(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
  });
});

describe('dispatchMenuItem — 受け入れ基準 6: 既存フローへのディスパッチ', () => {
  it('削除 → U31 削除フロー (対象 feature + kind)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Delete, leafModel());
    expect(r).toEqual({
      kind: FLOW_KIND.Delete,
      featureId: fid('a'),
      featureKind: FEATURE_KIND.Leaf,
    });
  });

  it('プロパティ編集 → 当該対象のプロパティ編集 UI 意図', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.EditProperties, leafModel());
    expect(r).toMatchObject({ kind: FLOW_KIND.EditProperties, featureId: fid('a') });
  });

  it('分割 → U26 (対象末端地物 id)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Split, leafModel());
    expect(r).toEqual({ kind: FLOW_KIND.Split, featureId: fid('a') });
  });

  it('所属変更 → U28 (対象)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.ChangeAffiliation, leafModel());
    expect(r).toMatchObject({ kind: FLOW_KIND.ChangeAffiliation, featureId: fid('a') });
  });

  it('共有解除 → U11 (対象共有頂点集合 + 所有地物)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Unshare, leafModel());
    expect(isBlocked(r)).toBe(false);
    if (!isBlocked(r) && r.kind === FLOW_KIND.Unshare) {
      expect(r.vertexIds).toEqual(new Set([vid('v1')]));
      expect(r.ownerFeatureId).toBe(fid('a'));
    }
  });

  it('結合 → U30 (当該面情報を結合起点) — 有効時のみ', () => {
    // 有効な結合項目を持つモデルで起点ディスパッチを確認。
    const model = leafModel({
      items: [enabledItem(MENU_ITEM_KIND.Merge)],
    });
    const r = dispatchMenuItem(MENU_ITEM_KIND.Merge, model);
    expect(r).toEqual({ kind: FLOW_KIND.Merge, seedFeatureId: fid('a') });
  });
});

describe('dispatchMenuItem — 受け入れ基準 7/13: 無効項目は発火しない (教訓 5.13)', () => {
  it('グレーアウトの結合は BLOCKED (右クリック経路でも発火しない)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Merge, leafModel());
    expect(isBlocked(r)).toBe(true);
    if (isBlocked(r)) expect(r.blocked).toBe(DISPATCH_BLOCKED_KIND.ItemDisabled);
  });

  it('モデルに無い項目は BLOCKED (古いモデルのドリフト防止)', () => {
    const model = leafModel({ items: [enabledItem(MENU_ITEM_KIND.Delete)] });
    const r = dispatchMenuItem(MENU_ITEM_KIND.Split, model);
    expect(isBlocked(r)).toBe(true);
    if (isBlocked(r)) expect(r.blocked).toBe(DISPATCH_BLOCKED_KIND.ItemNotInModel);
  });
});

describe('dispatchMenuItem — 受け入れ基準 6/8: 単一所有 VertexOnly の地物項目は発火する', () => {
  // 出す=発火できる (教訓 5.6): composer が single-owner VertexOnly で削除/分割等を
  // enabled で出したら、純粋ディスパッチでもその地物へ発火する。owner kind は
  // target に解決済みなので NoFeatureTarget でブロックされない。
  function singleOwnerVertexModel(kind = FEATURE_KIND.Leaf): ContextMenuModel {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.VertexOnly,
      ownerFeatureId: fid('a'),
      ownerFeatureKind: kind,
      vertexIds: new Set([vid('v1')]),
      sharedVertexIds: new Set([vid('v1')]),
    };
    return {
      kind: 'menu',
      target,
      position: POS,
      items: [
        enabledItem(MENU_ITEM_KIND.Delete),
        enabledItem(MENU_ITEM_KIND.EditProperties),
        enabledItem(MENU_ITEM_KIND.Split),
        enabledItem(MENU_ITEM_KIND.ChangeAffiliation),
        enabledItem(MENU_ITEM_KIND.Unshare),
      ],
    };
  }

  it('削除 → U31 (所有地物 + 解決済み kind)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Delete, singleOwnerVertexModel());
    expect(r).toEqual({
      kind: FLOW_KIND.Delete,
      featureId: fid('a'),
      featureKind: FEATURE_KIND.Leaf,
    });
  });

  it('プロパティ編集 → 当該所有地物', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.EditProperties, singleOwnerVertexModel());
    expect(r).toMatchObject({ kind: FLOW_KIND.EditProperties, featureId: fid('a') });
  });

  it('分割 → U26 (所有末端地物)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.Split, singleOwnerVertexModel());
    expect(r).toEqual({ kind: FLOW_KIND.Split, featureId: fid('a') });
  });

  it('所属変更 → U28 (所有地物)', () => {
    const r = dispatchMenuItem(MENU_ITEM_KIND.ChangeAffiliation, singleOwnerVertexModel());
    expect(r).toMatchObject({ kind: FLOW_KIND.ChangeAffiliation, featureId: fid('a') });
  });
});

describe('dispatchMenuItem — 受け入れ基準 8: 多所有/所有者不明では地物項目がブロック', () => {
  // owner kind が解決できない (multi/unknown) ときだけ NoFeatureTarget。これは
  // composer がそれらの地物項目を出さない条件と一致する (drift なし)。
  it('多所有 (owner=null, kind=null) の削除は NoFeatureTarget でブロック', () => {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.VertexOnly,
      ownerFeatureId: null,
      ownerFeatureKind: null,
      vertexIds: new Set([vid('v1'), vid('v2')]),
      sharedVertexIds: new Set([vid('v1')]),
    };
    const model: ContextMenuModel = {
      kind: 'menu',
      target,
      position: POS,
      // multi/unknown の本物のメニューは Unshare のみ。Delete を強制注入して
      // 「万一出ても発火しない」純粋層の防御を固定する (古いモデルのドリフト防止)。
      items: [enabledItem(MENU_ITEM_KIND.Delete), enabledItem(MENU_ITEM_KIND.Unshare)],
    };
    const del = dispatchMenuItem(MENU_ITEM_KIND.Delete, model);
    expect(isBlocked(del)).toBe(true);
    if (isBlocked(del)) expect(del.blocked).toBe(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
  });
});

describe('dispatchMenuItem — 受け入れ基準 3: 共有解除は所有者一意性に依存しない', () => {
  function unshareModel(
    ownerFeatureId: FeatureId | null,
    selected: ReadonlySet<VertexId>,
    shared: ReadonlySet<VertexId>,
  ): ContextMenuModel {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.VertexOnly,
      ownerFeatureId,
      ownerFeatureKind: null,
      vertexIds: new Set(selected),
      sharedVertexIds: new Set(shared),
    };
    return {
      kind: 'menu',
      target,
      position: POS,
      items: [enabledItem(MENU_ITEM_KIND.Unshare)],
    };
  }

  it('多所有 (owner=null) でも共有解除が発火し、共有頂点のみを渡す', () => {
    const r = dispatchMenuItem(
      MENU_ITEM_KIND.Unshare,
      // 選択 = {v1,v2,v3}, 共有 = {v1,v3} (v2 は非共有)。
      unshareModel(null, new Set([vid('v1'), vid('v2'), vid('v3')]), new Set([vid('v1'), vid('v3')])),
    );
    expect(isBlocked(r)).toBe(false);
    if (!isBlocked(r) && r.kind === FLOW_KIND.Unshare) {
      // 共有部分集合のみ (非共有 v2 を含まない)。
      expect(r.vertexIds).toEqual(new Set([vid('v1'), vid('v3')]));
      expect(r.ownerFeatureId).toBeNull();
    }
  });

  it('所有者不明 (owner=null) でも共有解除が発火する', () => {
    const r = dispatchMenuItem(
      MENU_ITEM_KIND.Unshare,
      unshareModel(null, new Set([vid('v1')]), new Set([vid('v1')])),
    );
    expect(isBlocked(r)).toBe(false);
    if (!isBlocked(r) && r.kind === FLOW_KIND.Unshare) {
      expect(r.vertexIds).toEqual(new Set([vid('v1')]));
    }
  });

  it('共有頂点が無ければ共有解除は NoSharedVertices でブロック', () => {
    const r = dispatchMenuItem(
      MENU_ITEM_KIND.Unshare,
      unshareModel(fid('a'), new Set([vid('v1')]), new Set()),
    );
    expect(isBlocked(r)).toBe(true);
    if (isBlocked(r)) expect(r.blocked).toBe(DISPATCH_BLOCKED_KIND.NoSharedVertices);
  });
});

describe('dispatchMenuItem — 頂点を削除 (FR-88, 地物削除との乖離解消)', () => {
  it('Feature 対象 + 頂点選択 → DeleteVertex (所有 + 選択頂点)', () => {
    // leafModel の Feature 対象は vertexIds {v1} を持つ。
    const model = leafModel({ items: [enabledItem(MENU_ITEM_KIND.DeleteVertex)] });
    const r = dispatchMenuItem(MENU_ITEM_KIND.DeleteVertex, model);
    expect(r).toEqual({
      kind: FLOW_KIND.DeleteVertex,
      ownerFeatureId: fid('a'),
      vertexIds: new Set([vid('v1')]),
    });
  });

  it('VertexOnly 単一所有 → DeleteVertex (所有 + 選択頂点)', () => {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.VertexOnly,
      ownerFeatureId: fid('a'),
      ownerFeatureKind: FEATURE_KIND.Leaf,
      vertexIds: new Set([vid('v1'), vid('v2')]),
      sharedVertexIds: new Set(),
    };
    const model: ContextMenuModel = {
      kind: 'menu',
      target,
      position: POS,
      items: [enabledItem(MENU_ITEM_KIND.DeleteVertex)],
    };
    const r = dispatchMenuItem(MENU_ITEM_KIND.DeleteVertex, model);
    expect(r).toEqual({
      kind: FLOW_KIND.DeleteVertex,
      ownerFeatureId: fid('a'),
      vertexIds: new Set([vid('v1'), vid('v2')]),
    });
  });

  it('頂点選択が無い Feature の DeleteVertex はブロック (削除=地物 が出る条件)', () => {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.Feature,
      featureId: fid('a'),
      featureKind: FEATURE_KIND.Leaf,
      vertexIds: new Set(),
      sharedVertexIds: new Set(),
    };
    const model: ContextMenuModel = {
      kind: 'menu',
      target,
      position: POS,
      items: [enabledItem(MENU_ITEM_KIND.DeleteVertex)],
    };
    const r = dispatchMenuItem(MENU_ITEM_KIND.DeleteVertex, model);
    expect(isBlocked(r)).toBe(true);
    if (isBlocked(r)) expect(r.blocked).toBe(DISPATCH_BLOCKED_KIND.NoFeatureTarget);
  });
});

describe('dispatchMenuItem — 共有解除は選択全体でなく共有部分集合のみを渡す', () => {
  it('Feature 対象でも非共有頂点は U11 へ渡さない', () => {
    const target: MenuTarget = {
      kind: MENU_TARGET_KIND.Feature,
      featureId: fid('a'),
      featureKind: FEATURE_KIND.Leaf,
      vertexIds: new Set([vid('v1'), vid('v2'), vid('v3')]),
      sharedVertexIds: new Set([vid('v2')]),
    };
    const model: ContextMenuModel = {
      kind: 'menu',
      target,
      position: POS,
      items: [enabledItem(MENU_ITEM_KIND.Unshare)],
    };
    const r = dispatchMenuItem(MENU_ITEM_KIND.Unshare, model);
    expect(isBlocked(r)).toBe(false);
    if (!isBlocked(r) && r.kind === FLOW_KIND.Unshare) {
      expect(r.vertexIds).toEqual(new Set([vid('v2')]));
      expect(r.ownerFeatureId).toBe(fid('a'));
    }
  });
});
