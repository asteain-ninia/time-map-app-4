// U31 deletion — unit tests (FR-41 / FR-85, 受け入れ基準 1〜3 / 5〜7).

import { describe, expect, it } from 'vitest';

import { withParentId, type Feature } from '../feature';
import { asFeatureId, type FeatureId } from '../ids';
import { buildForest } from '../hierarchy/forest';
import { checkDanglingParents, validateHierarchy } from '../hierarchy/validate';

import {
  shouldAutoDisappear,
  emptyAggregateIds,
} from './auto-disappear';
import {
  sweepAndPruneAnchor,
  sweepChildLinksOnly,
} from './sweep';
import {
  DELETE_REJECT,
  DELETE_VERDICT,
  hasReferencesInAnchor,
  isDeletable,
  judgeDeletion,
  referencesInAnchor,
} from './eligibility';
import {
  createDeleteFeatureCommand,
  isNoOpDeletion,
} from './command';
import { DELETE_TARGET_KIND, resolveDeleteTarget } from './target';
import { deleteRejectMessage } from './messages';
import {
  aggregate,
  aggregateOfTwoLeaves,
  aggregateRingWithCenter,
  anchorOf,
  fid,
  leafTile,
  stateOf,
} from './fixtures';
import { CONTEXT_KIND, type VertexContext } from '../selection/context';

function idsOf(features: readonly Feature[]): Set<FeatureId> {
  return new Set(features.map((f) => f.id));
}

// --- auto-disappear (FR-35 / 教訓 5.6, 受け入れ基準 3) -----------------------

describe('shouldAutoDisappear / emptyAggregateIds (結果状態判定, 教訓 5.6)', () => {
  it('a declared aggregate with 0 children auto-disappears', () => {
    const empty = aggregate('agg', []);
    const forest = buildForest([empty]);
    expect(shouldAutoDisappear(forest, empty)).toBe(true);
    expect(emptyAggregateIds([empty])).toEqual([fid('agg')]);
  });

  it('an aggregate with >= 1 child does NOT auto-disappear', () => {
    const { features } = aggregateOfTwoLeaves();
    const forest = buildForest(features);
    const agg = features.find((f) => f.id === fid('agg'));
    expect(agg).toBeDefined();
    if (agg !== undefined) expect(shouldAutoDisappear(forest, agg)).toBe(false);
    expect(emptyAggregateIds(features)).toEqual([]);
  });

  it('a leaf with no children never auto-disappears (it owns its shape)', () => {
    const leaf = leafTile('a', 0, 0, 10, 10).feature;
    const forest = buildForest([leaf]);
    expect(shouldAutoDisappear(forest, leaf)).toBe(false);
  });

  it('the same 0-child result state triggers disappearance regardless of HOW it arose (教訓 5.6)', () => {
    // Build a state where an aggregate already has 0 children WITHOUT going via a
    // delete command — the detector still flags it (no path gate).
    const orphanAgg = aggregate('agg', []);
    expect(emptyAggregateIds([orphanAgg])).toContain(fid('agg'));
  });
});

// --- reference sweep (双方向, 教訓 5.21, 受け入れ基準 2) ----------------------

describe('sweepAndPruneAnchor (双方向掃除 + 連鎖剪定, 教訓 5.21)', () => {
  it('removes the target and clears children parentId AND parent childIds (双方向)', () => {
    // agg -> {a, b}. Delete leaf a: a is removed, agg.childIds drops a.
    const { features, vertices } = aggregateOfTwoLeaves();
    const result = sweepAndPruneAnchor(features, new Set([fid('a')]));

    expect(result.removedIds.has(fid('a'))).toBe(true);
    const agg = result.features.find((f) => f.id === fid('agg'));
    expect(agg?.kind).toBe('aggregate');
    if (agg?.kind === 'aggregate') expect(agg.childIds).toEqual([fid('b')]);
    expect(result.editedIds.has(fid('agg'))).toBe(true);
    // No dangling parent anywhere (双方向掃除の証).
    expect(checkDanglingParents(buildForest(result.features))).toEqual([]);
    void vertices;
  });

  it('clears a child parentId when the PARENT is deleted (上位領域参照の掃除)', () => {
    // agg -> {a, b}. Delete agg: a, b lose their parent and become top-level.
    const { features } = aggregateOfTwoLeaves();
    const result = sweepAndPruneAnchor(features, new Set([fid('agg')]));
    expect(result.removedIds.has(fid('agg'))).toBe(true);
    const a = result.features.find((f) => f.id === fid('a'));
    const b = result.features.find((f) => f.id === fid('b'));
    expect(a?.parentId).toBeUndefined();
    expect(b?.parentId).toBeUndefined();
    expect(checkDanglingParents(buildForest(result.features))).toEqual([]);
  });

  it('chain-prunes empty aggregates to a fixpoint (multi-stage, 受け入れ基準 2)', () => {
    // top -> mid -> {a}. Delete a: mid empties -> mid disappears -> top empties ->
    // top disappears. All three removed in one operation.
    const a = leafTile('a', 0, 0, 10, 10, 'mid');
    const mid = aggregate('mid', ['a'], 'top');
    const top = aggregate('top', ['mid']);
    const features = [top, mid, a.feature];

    const result = sweepAndPruneAnchor(features, new Set([fid('a')]));
    expect(result.removedIds).toEqual(new Set([fid('a'), fid('mid'), fid('top')]));
    expect(result.features).toEqual([]);
  });

  it('handles飛び地 (multiple child pieces) without片落とし (教訓 5.1)', () => {
    // agg -> {a, b, c}; delete a and c (two separate pieces) -> only b remains.
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 100, 0, 10, 10, 'agg');
    const c = leafTile('c', 200, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a', 'b', 'c']);
    const features = [agg, a.feature, b.feature, c.feature];

    const result = sweepAndPruneAnchor(features, new Set([fid('a'), fid('c')]));
    const out = result.features.find((f) => f.id === fid('agg'));
    if (out?.kind === 'aggregate') expect(out.childIds).toEqual([fid('b')]);
  });

  it('terminates on cyclic / broken data (教訓 5.28)', () => {
    // a <-> b parent cycle, plus a real leaf c under a. Delete c. Must not loop.
    let a = leafTile('a', 0, 0, 10, 10).feature;
    let b = leafTile('b', 0, 0, 10, 10).feature;
    a = withParentId(a, fid('b'));
    b = withParentId(b, fid('a'));
    const c = leafTile('c', 0, 0, 10, 10, 'a').feature;
    const result = sweepAndPruneAnchor([a, b, c], new Set([fid('c')]));
    expect(result.removedIds.has(fid('c'))).toBe(true);
    // finite result returned (no hang).
    expect(result.features.length).toBeGreaterThanOrEqual(2);
  });

  it('targets absent from the anchor contribute nothing', () => {
    const { features } = aggregateOfTwoLeaves();
    const result = sweepAndPruneAnchor(features, new Set([fid('ghost')]));
    expect(result.removedIds.size).toBe(0);
    expect(idsOf(result.features)).toEqual(idsOf(features));
  });
});

// --- 反証テスト: one-directional sweep leaves dangling refs (受け入れ基準 5) --

describe('片方向掃除は dangling 参照を残す (反証, 受け入れ基準 5)', () => {
  it('child-links-only sweep leaves a dangling parentId that U08 flags', () => {
    // agg -> {a, b}. Delete agg with the WRONG one-directional sweep: childIds
    // dropped but a/b keep parentId=agg -> dangling.
    const { features, vertices } = aggregateOfTwoLeaves();
    const broken = sweepChildLinksOnly(features, new Set([fid('agg')]));
    const danglers = checkDanglingParents(buildForest(broken));
    expect(danglers.length).toBeGreaterThan(0);
    void vertices;
  });

  it('the正規 bidirectional sweep leaves NO dangling reference (対の確認)', () => {
    const { features } = aggregateOfTwoLeaves();
    const correct = sweepAndPruneAnchor(features, new Set([fid('agg')]));
    expect(checkDanglingParents(buildForest(correct.features))).toEqual([]);
  });
});

// --- eligibility (全錨横断, FR-41, 受け入れ基準 1) ----------------------------

describe('judgeDeletion (削除可否, 全錨横断, FR-41)', () => {
  it('a face referenced by no other feature in any anchor is deletable unconditionally', () => {
    const t = leafTile('solo', 0, 0, 10, 10);
    const st = stateOf(anchorOf('an1', [t.feature], t.vertices));
    const verdict = judgeDeletion(st, fid('solo'));
    expect(isDeletable(verdict)).toBe(true);
  });

  it('a referenced face is deletable when sweep + prune keeps invariants (再編許容)', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const verdict = judgeDeletion(st, fid('a'));
    expect(isDeletable(verdict)).toBe(true);
  });

  it('NotFound when the target exists in no anchor (教訓 5.24)', () => {
    const t = leafTile('solo', 0, 0, 10, 10);
    const st = stateOf(anchorOf('an1', [t.feature], t.vertices));
    const verdict = judgeDeletion(st, fid('ghost'));
    expect(verdict.kind).toBe(DELETE_VERDICT.Rejected);
    if (verdict.kind === DELETE_VERDICT.Rejected) {
      expect(verdict.reason).toBe(DELETE_REJECT.NotFound);
      expect(deleteRejectMessage(verdict.reason)).toContain('見つかりません');
    }
  });

  it('judges ACROSS all anchors: a reference in only ONE anchor still drives再編 (受け入れ基準 1)', () => {
    // Anchor 1: solo with no refs. Anchor 2: solo is a child of agg2.
    const solo1 = leafTile('solo', 0, 0, 10, 10);
    const solo2 = leafTile('solo', 0, 0, 10, 10, 'agg2');
    const other2 = leafTile('other', 100, 0, 10, 10, 'agg2');
    const agg2 = aggregate('agg2', ['solo', 'other']);
    const st = stateOf(
      anchorOf('an1', [solo1.feature], solo1.vertices),
      anchorOf('an2', [agg2, solo2.feature, other2.feature], [...solo2.vertices, ...other2.vertices]),
    );
    // Referenced in anchor 2 -> the simulation path runs (not the unconditional path).
    expect(hasReferencesInAnchor([agg2, solo2.feature, other2.feature], fid('solo'))).toBe(true);
    expect(hasReferencesInAnchor([solo1.feature], fid('solo'))).toBe(false);
    const verdict = judgeDeletion(st, fid('solo'));
    expect(isDeletable(verdict)).toBe(true);
  });

  it('rejects with ReorganizationImpossible when sweep leaves an inter-child gap (受け入れ基準 1, 拒否経路)', () => {
    // agg owns a 3x3 tiling; deleting the CENTER tile leaves the 8 border tiles
    // enclosing an empty hole -> checkAggregateShapes flags AggregateShapeMismatch
    // -> U08 cannot restore the invariant -> 再編不能 -> Rejected.
    const { features, vertices, aggId, centerId } = aggregateRingWithCenter();
    const st = stateOf(anchorOf('an1', features, vertices));

    // Sanity: the target is referenced (it is a child of agg), so the simulation
    // path (step 3) runs rather than the unconditional path.
    expect(hasReferencesInAnchor(features, centerId)).toBe(true);

    const verdict = judgeDeletion(st, centerId);
    expect(isDeletable(verdict)).toBe(false);
    expect(verdict.kind).toBe(DELETE_VERDICT.Rejected);
    if (verdict.kind === DELETE_VERDICT.Rejected) {
      // 機械可読フィールド: reason kind is the reorganization-impossible code.
      expect(verdict.reason).toBe(DELETE_REJECT.ReorganizationImpossible);
      // 関与地物 ID: the target itself plus the violating aggregate are present.
      expect(verdict.featureIds).toContain(centerId);
      expect(verdict.featureIds).toContain(aggId);
      // 日本語通知文言: the same reason maps to a Japanese notice (対の確認, FR-115).
      const message = deleteRejectMessage(verdict.reason);
      expect(message).toContain('削除できません');
      expect(message).toContain('整合性');
    }
  });

  it('referencesInAnchor lists BOTH directions (双方向列挙)', () => {
    const { features } = aggregateOfTwoLeaves();
    const refsToA = referencesInAnchor(features, fid('a'));
    expect(refsToA.parentRefs).toEqual([fid('agg')]); // agg lists a as child.
    const refsToAgg = referencesInAnchor(features, fid('agg'));
    expect(new Set(refsToAgg.childRefs)).toEqual(new Set([fid('a'), fid('b')])); // a,b parented to agg.
  });
});

// --- command: single undo unit, symmetric notify, ID stability ----------------

describe('createDeleteFeatureCommand (FR-73 / FR-94, 教訓 5.20 / 5.23, 受け入れ基準 6)', () => {
  it('execute sweeps全錨 and reports deleted (target + chain) + survived', () => {
    // top -> mid -> {a}; delete a -> a, mid, top all gone (chain).
    const a = leafTile('a', 0, 0, 10, 10, 'mid');
    const mid = aggregate('mid', ['a'], 'top');
    const top = aggregate('top', ['mid']);
    const keep = leafTile('keep', 500, 0, 10, 10);
    const st = stateOf(
      anchorOf('an1', [top, mid, a.feature, keep.feature], [...a.vertices, ...keep.vertices]),
    );
    const cmd = createDeleteFeatureCommand(st, fid('a'));
    const out = cmd.execute(st);

    expect(out.result.deleted).toEqual(new Set([fid('a'), fid('mid'), fid('top')]));
    expect(out.result.survived.has(fid('keep'))).toBe(true);
    expect(out.result.created.size).toBe(0);
    // touched includes everything deleted (symmetric notify base).
    for (const id of out.result.deleted) expect(out.result.touched.has(id)).toBe(true);
    // after-state has only keep.
    expect(idsOf(out.state.anchors[0]!.snapshot.features)).toEqual(new Set([fid('keep')]));
  });

  it('undo restores the EXACT prior state and redo re-applies (ID 不変, 教訓 5.20)', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const cmd = createDeleteFeatureCommand(st, fid('a'));

    const afterExec = cmd.execute(st);
    const afterUndo = cmd.undo(afterExec.state);
    // 完全復元: undo state equals original anchors (same ids, structure).
    expect(idsOf(afterUndo.state.anchors[0]!.snapshot.features)).toEqual(idsOf(features));
    const restoredA = afterUndo.state.anchors[0]!.snapshot.features.find((f) => f.id === fid('a'));
    expect(restoredA?.id).toBe(fid('a')); // same first-generation id, not re-minted.

    const afterRedo = cmd.redo(afterUndo.state);
    expect(idsOf(afterRedo.state.anchors[0]!.snapshot.features)).toEqual(
      idsOf(afterExec.state.anchors[0]!.snapshot.features),
    );
  });

  it('execute / undo / redo notify on the SAME touched set (教訓 5.23 厳密一致)', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const cmd = createDeleteFeatureCommand(st, fid('a'));
    const e = cmd.execute(st);
    const u = cmd.undo(e.state);
    const r = cmd.redo(u.state);
    expect(u.result.touched).toEqual(e.result.touched);
    expect(r.result.touched).toEqual(e.result.touched);
  });

  it('undo carries created = the deleted ids so selection re-resolution can restore (教訓 5.11)', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const cmd = createDeleteFeatureCommand(st, fid('a'));
    const e = cmd.execute(st);
    const u = cmd.undo(e.state);
    expect(u.result.created).toEqual(e.result.deleted);
  });

  it('purity: execute does not mutate the input state', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const before = idsOf(st.anchors[0]!.snapshot.features);
    createDeleteFeatureCommand(st, fid('a')).execute(st);
    expect(idsOf(st.anchors[0]!.snapshot.features)).toEqual(before);
  });

  it('isNoOpDeletion guards a target absent everywhere (教訓 5.24)', () => {
    const t = leafTile('solo', 0, 0, 10, 10);
    const st = stateOf(anchorOf('an1', [t.feature], t.vertices));
    expect(isNoOpDeletion(st, fid('ghost'))).toBe(true);
    expect(isNoOpDeletion(st, fid('solo'))).toBe(false);
  });

  it('post-deletion state satisfies U08 invariants (再編後の整合)', () => {
    const { features, vertices } = aggregateOfTwoLeaves();
    const st = stateOf(anchorOf('an1', features, vertices));
    const out = createDeleteFeatureCommand(st, fid('a')).execute(st);
    const validation = validateHierarchy(out.state.anchors[0]!.snapshot.features, {
      vertexStore: out.state.anchors[0]!.snapshot.vertices,
    });
    expect(validation.ok).toBe(true);
    void vertices;
  });
});

// --- delete-target resolution (FR-85, 教訓 5.4, 受け入れ基準 4) --------------

describe('resolveDeleteTarget (アクティブ→頂点文脈, 教訓 5.4)', () => {
  const singleContext: VertexContext = {
    kind: CONTEXT_KIND.Single,
    ownerFeatureId: asFeatureId('ctx'),
    vertexIds: new Set(),
  };

  it('active feature wins (第一候補)', () => {
    const t = resolveDeleteTarget(asFeatureId('active'), singleContext);
    expect(t.kind).toBe(DELETE_TARGET_KIND.ActiveFeature);
    if (t.kind === DELETE_TARGET_KIND.ActiveFeature) expect(t.featureId).toBe(asFeatureId('active'));
  });

  it('falls back to single-owner vertex context when no active feature', () => {
    const t = resolveDeleteTarget(null, singleContext);
    expect(t.kind).toBe(DELETE_TARGET_KIND.ContextFeature);
    if (t.kind === DELETE_TARGET_KIND.ContextFeature) expect(t.featureId).toBe(asFeatureId('ctx'));
  });

  it('None when no active feature and context is empty/multi/unknown', () => {
    expect(resolveDeleteTarget(null, { kind: CONTEXT_KIND.Empty }).kind).toBe(DELETE_TARGET_KIND.None);
    expect(
      resolveDeleteTarget(null, { kind: CONTEXT_KIND.Multi, ownerFeatureIds: new Set() }).kind,
    ).toBe(DELETE_TARGET_KIND.None);
    expect(resolveDeleteTarget(null, { kind: CONTEXT_KIND.Unknown }).kind).toBe(
      DELETE_TARGET_KIND.None,
    );
  });
});
