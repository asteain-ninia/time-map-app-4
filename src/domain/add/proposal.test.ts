import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { FEATURE_KIND } from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import { timePointYearMonthDay } from '../time/time-point';

import {
  PARENT_TOP_LEVEL,
  PARENT_UNSET,
  parentSelection,
  placeVertex,
  startSession,
  ADD_TOOL_KIND,
} from './session';
import { CONFIRM_STATUS, confirmShape, type ShapeDraft } from './shape-draft';
import {
  assembleAddProposal,
  resolveParentId,
  type AddIdPorts,
} from './proposal';

const C = (lon: number, lat: number) => ({ lon, lat });
const attrs = createBasicAttributes('Newland', 1500, 1600);
const color = createColorInfo(true, '#fff', '#0ff', '#000');
const properties = { attributes: attrs, color };

function makeIds() {
  let v = 0;
  let f = 0;
  let r = 0;
  const ids: AddIdPorts = {
    nextFeatureId: () => asFeatureId(`f${++f}`) as FeatureId,
    nextVertexId: () => asVertexId(`v${++v}`) as VertexId,
  };
  const nextRingId = () => asRingId(`r${++r}`) as RingId;
  return { ids, nextRingId };
}

function draftOf(tool: Parameters<typeof startSession>[0], coords: ReadonlyArray<readonly [number, number]>, sharedAt?: { index: number; fid: FeatureId }): ShapeDraft {
  let s = startSession(tool);
  coords.forEach(([lon, lat], i) => {
    s = placeVertex(s, C(lon, lat), sharedAt && sharedAt.index === i ? sharedAt.fid : undefined);
  });
  const r = confirmShape(s);
  if (r.status !== CONFIRM_STATUS.Ok) throw new Error('test draft invalid');
  return r.draft;
}

const currentTime = timePointYearMonthDay(1500, 6, 20);

describe('resolveParentId (FR-39 同値)', () => {
  it('unset and top-level both map to no parent', () => {
    expect(resolveParentId(PARENT_UNSET)).toBeUndefined();
    expect(resolveParentId(PARENT_TOP_LEVEL)).toBeUndefined();
  });
  it('a chosen parent maps to its id', () => {
    const pid = asFeatureId('parent');
    expect(resolveParentId(parentSelection(pid))).toBe(pid);
  });
});

describe('assembleAddProposal (FR-76 / FR-59 / 教訓 5.15)', () => {
  it('point: builds a point feature, anchorTime = current time', () => {
    const { ids } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Point, [[1, 2]]),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect(p.anchorTime).toEqual(currentTime);
    expect(p.snapshot.feature.kind).toBe(FEATURE_KIND.Point);
    expect(p.snapshot.vertices).toHaveLength(1);
    expect(p.featureId).toBe(p.snapshot.feature.id);
  });

  it('line: builds a line feature with ordered vertex ids', () => {
    const { ids } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]]),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect(p.snapshot.feature.kind).toBe(FEATURE_KIND.Line);
    expect(p.snapshot.vertices).toHaveLength(2);
  });

  it('face: builds a leaf with one territory ring and a parent link (FR-77)', () => {
    const { ids, nextRingId } = makeIds();
    const pid = asFeatureId('cover');
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
      properties,
      parent: parentSelection(pid),
      currentTime,
      ids,
      nextRingId,
    });
    const f = p.snapshot.feature;
    expect(f.kind).toBe(FEATURE_KIND.Leaf);
    expect(f.parentId).toBe(pid);
    if (f.kind === FEATURE_KIND.Leaf) {
      expect(f.shape.rings).toHaveLength(1);
      expect(f.shape.rings[0]?.vertexIds).toHaveLength(3);
    }
  });

  it('face with 親なし has NO parentId (top-level, FR-39)', () => {
    const { ids, nextRingId } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime,
      ids,
      nextRingId,
    });
    expect(p.snapshot.feature.parentId).toBeUndefined();
  });

  it('records shared-vertex candidates in the snapshot (FR-30〜33)', () => {
    const { ids } = makeIds();
    const shareWith = asFeatureId('existing');
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]], { index: 0, fid: shareWith }),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect([...p.snapshot.sharedCandidateIds.values()]).toContain(shareWith);
  });

  it('throws an internal error if a face is assembled without a ring-id port', () => {
    const { ids } = makeIds();
    expect(() =>
      assembleAddProposal({
        draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
        properties,
        parent: PARENT_UNSET,
        currentTime,
        ids,
      }),
    ).toThrow();
  });
});
