// U28 — useReparentTool 単体テスト (bughunt: 所属変更ツールの欠落配線 回帰防止).
//
// Locks the three confirmed bughunt fixes at the hook seam:
//   A. parentNone (最上位化 / detach) had NO UI entry point — only parentExisting was
//      reachable. confirmNone + canConfirmNone are the missing entry point. Asserts a
//      target-only confirmNone builds a parentNone proposal (the target ends up 親なし).
//   B. buildAffiliationProposal was called WITHOUT a vertexStore, so the post-reparent
//      形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) was silently
//      skipped. Asserts a gap-creating reparent is now CAUGHT (Rejected) WHEN resolveStore
//      is wired, and slips through (proposal built → startProcess called) when it is NOT.
//   C. pick() captured a stale targetId in the Rejected / ConflictPaused state, so the
//      first click after a rejection was mistreated as a NEW-PARENT pick. Asserts the
//      post-rejection click is a FRESH TARGET pick.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../../domain/ids';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { AffiliationSnapshot } from '../../domain/editing/apply-proposal';

import { REPARENT_FLOW, useReparentTool, type StartAffiliationProcess } from './useReparentTool';

const COLOR = createColorInfo(true, '#111', '#222', '#333');
const ANCHOR = timePointYear(50);
const fid = (s: string): FeatureId => asFeatureId(s);

/** A unit-square leaf at (ox,oy)..(ox+1,oy+1) + its 4 vertices (real geometry for 形状検査). */
function squareLeaf(
  id: string,
  ox: number,
  oy: number,
  parent?: string,
): { feature: Feature; vertices: Vertex[] } {
  const vids = [0, 1, 2, 3].map((i) => asVertexId(`${id}-v${i}`));
  const coords = [
    createCoordinate(ox, oy),
    createCoordinate(ox + 1, oy),
    createCoordinate(ox + 1, oy + 1),
    createCoordinate(ox, oy + 1),
  ];
  const vertices = vids.map((vid, i) => createVertex(vid, coords[i]!));
  const ring = createTerritoryRing(asRingId(`${id}-r`), vids);
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  const feature = createLeafFeature(fid(id), createBasicAttributes(id, 0, 100), COLOR, createShape([ring]), optional);
  return { feature, vertices };
}

function agg(id: string, parent?: string): Feature {
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  return createAggregateFeature(fid(id), createBasicAttributes(id, 0, 100), COLOR, [], optional);
}

interface CommitProbe {
  readonly startProcess: StartAffiliationProcess<unknown>;
  /** The last EditProposal startProcess received (null if it was never called). */
  readonly lastProposal: () => EditProposal<AffiliationSnapshot> | null;
  readonly callCount: () => number;
}

/** A startProcess stub that records the proposal and returns a scripted result. */
function commitProbe(result: ProcessResult<unknown>): CommitProbe {
  let last: EditProposal<AffiliationSnapshot> | null = null;
  let calls = 0;
  const startProcess: StartAffiliationProcess<unknown> = (proposal) => {
    last = proposal;
    calls += 1;
    return result;
  };
  return { startProcess, lastProposal: () => last, callCount: () => calls };
}

const COMMITTED: ProcessResult<unknown> = {
  status: PROCESS_STATUS.Committed,
  state: {},
  command: { label: 'noop', execute: (s: unknown) => ({ state: s, result: undefined }) } as never,
};

const REJECTED: ProcessResult<unknown> = {
  status: PROCESS_STATUS.Rejected,
  kind: 'constraint' as never,
  message: 'U13 が拒否しました',
};

function mount(opts: {
  features: readonly Feature[];
  startProcess: StartAffiliationProcess<unknown>;
  resolveStore?: VertexStore;
}) {
  return renderHook(() =>
    useReparentTool<unknown>({
      resolveFeatures: () => opts.features,
      anchorTime: () => ANCHOR,
      startProcess: opts.startProcess,
      ...(opts.resolveStore ? { resolveStore: () => opts.resolveStore! } : {}),
    }),
  );
}

describe('useReparentTool — bughunt 欠落配線', () => {
  // --- BUG A: parentNone (最上位化 / detach) UI entry point ------------------
  describe('A. confirmNone (最上位化 / parentNone)', () => {
    it('canConfirmNone is true once a target is picked (no new parent needed)', () => {
      const child = squareLeaf('child', 0, 0, 'A'); // child of aggregate A
      const sib = squareLeaf('sib', 2, 0, 'A'); // keep A from being an empty aggregate
      const { result } = mount({
        features: [agg('A'), child.feature, sib.feature],
        startProcess: commitProbe(COMMITTED).startProcess,
      });
      act(() => result.current.start());
      expect(result.current.canConfirmNone).toBe(false); // no target yet
      act(() => result.current.pick(fid('child')));
      expect(result.current.canConfirmNone).toBe(true); // target alone is enough
    });

    it('confirmNone builds a parentNone proposal — the target is detached to 親なし', () => {
      const child = squareLeaf('child', 0, 0, 'P');
      const sib = squareLeaf('sib', 2, 0, 'P'); // keep P alive after child detaches
      const probe = commitProbe(COMMITTED);
      const { result } = mount({
        features: [agg('P'), child.feature, sib.feature],
        startProcess: probe.startProcess,
      });
      act(() => result.current.start());
      act(() => result.current.pick(fid('child')));
      act(() => result.current.confirmNone());

      expect(probe.callCount()).toBe(1);
      const proposal = probe.lastProposal();
      expect(proposal).not.toBeNull();
      // The committed snapshot's next features place `child` at top level (parentId gone).
      const moved = proposal!.snapshot.nextFeatures.find((f) => f.id === fid('child'));
      expect(moved?.parentId).toBeUndefined();
    });

    it('confirmNone with no target is a no-op (does not drive U13)', () => {
      const probe = commitProbe(COMMITTED);
      const { result } = mount({ features: [agg('P')], startProcess: probe.startProcess });
      act(() => result.current.start());
      act(() => result.current.confirmNone());
      expect(probe.callCount()).toBe(0);
    });
  });

  // --- BUG B: vertexStore threads the post-reparent 形状=和 check ------------
  describe('B. vertexStore enables the post-reparent 形状=和・隙間なし check', () => {
    // Mirror the domain test (affiliation.test.ts「形状解決不能 (頂点欠落)」): reparent leaf
    // `c` under aggregate `B`, but with an EMPTY vertexStore (c's vertices missing). The
    // 形状=和 check then fails to resolve c's shape (ShapeUnresolved) → 'hierarchy' reject —
    // but ONLY when a vertexStore is threaded. Without it the check is skipped and the same
    // reparent commits. This proves the hook actually wires resolveStore → buildAffiliation-
    // Proposal's vertexStore (the bughunt wiring gap).
    function shapeScenario(): { features: Feature[]; emptyStore: VertexStore } {
      const c = squareLeaf('c', 5, 5, 'A'); // c starts under A; we move it to B
      const features = [agg('A'), agg('B'), c.feature];
      const emptyStore = createVertexStore([]); // c's vertices are NOT in the store
      return { features, emptyStore };
    }

    it('WITH resolveStore: a reparent whose shape cannot resolve is REJECTED (check runs)', () => {
      const { features, emptyStore } = shapeScenario();
      const probe = commitProbe(COMMITTED);
      const { result } = mount({ features, startProcess: probe.startProcess, resolveStore: emptyStore });
      act(() => result.current.start());
      act(() => result.current.pick(fid('c'))); // target
      act(() => result.current.pick(fid('B'))); // new parent (aggregate)
      act(() => result.current.confirm());
      // The 形状=和 check ran, failed to resolve, and rejected BEFORE U13.
      expect(result.current.flow).toBe(REPARENT_FLOW.Rejected);
      expect(result.current.message).not.toBeNull();
      expect(probe.callCount()).toBe(0);
    });

    it('WITHOUT resolveStore: the SAME reparent slips through (shape check skipped)', () => {
      const { features } = shapeScenario();
      const probe = commitProbe(COMMITTED);
      const { result } = mount({ features, startProcess: probe.startProcess });
      act(() => result.current.start());
      act(() => result.current.pick(fid('c')));
      act(() => result.current.pick(fid('B')));
      act(() => result.current.confirm());
      // No vertexStore → topological-only check passes → proposal built → U13 driven.
      expect(probe.callCount()).toBe(1);
    });
  });

  // --- BUG C: post-rejection pick is a FRESH target pick --------------------
  describe('C. pick() after a rejection / paused conflict is a fresh target pick', () => {
    it('the first click after a Rejected confirm becomes the TARGET (not a new parent)', () => {
      // Two disjoint top-level leaves; the live binding stub rejects the first confirm so the
      // flow lands in Rejected with a STALE target/newParent still held.
      const a = squareLeaf('A', 0, 0);
      const b = squareLeaf('B', 3, 0);
      const c = squareLeaf('C', 6, 0);
      const probe = commitProbe(REJECTED);
      const { result } = mount({
        features: [a.feature, b.feature, c.feature],
        startProcess: probe.startProcess,
      });
      act(() => result.current.start());
      act(() => result.current.pick(fid('A'))); // target = A
      act(() => result.current.pick(fid('B'))); // new parent = B
      act(() => result.current.confirm()); // U13 stub rejects
      expect(result.current.flow).toBe(REPARENT_FLOW.Rejected);
      expect(result.current.targetId).toBe(fid('A')); // stale selection still held

      // Next click after the rejection: it MUST start a fresh target pick on C, NOT be read
      // as a new parent against the stale target A.
      act(() => result.current.pick(fid('C')));
      expect(result.current.targetId).toBe(fid('C'));
      expect(result.current.newParentId).toBeNull();
      expect(result.current.flow).toBe(REPARENT_FLOW.PickParent);
    });

    it('a fresh post-rejection pick of the SAME id still re-targets it (not a toggle-off)', () => {
      const a = squareLeaf('A', 0, 0);
      const b = squareLeaf('B', 3, 0);
      const probe = commitProbe(REJECTED);
      const { result } = mount({ features: [a.feature, b.feature], startProcess: probe.startProcess });
      act(() => result.current.start());
      act(() => result.current.pick(fid('A')));
      act(() => result.current.pick(fid('B')));
      act(() => result.current.confirm());
      expect(result.current.flow).toBe(REPARENT_FLOW.Rejected);
      // Click A again after rejection: A becomes the fresh target (it is NOT toggled off via
      // the stale-target same-id rule, which was the bug).
      act(() => result.current.pick(fid('A')));
      expect(result.current.targetId).toBe(fid('A'));
      expect(result.current.newParentId).toBeNull();
      expect(result.current.flow).toBe(REPARENT_FLOW.PickParent);
    });
  });
});
