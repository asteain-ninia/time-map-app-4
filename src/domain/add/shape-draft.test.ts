import { describe, expect, it } from 'vitest';

import {
  ADD_TOOL_KIND,
  placeVertex,
  startSession,
} from './session';
import {
  CONFIRM_STATUS,
  SHAPE_REJECT,
  confirmShape,
  draftCoordinates,
} from './shape-draft';

const C = (lon: number, lat: number) => ({ lon, lat });

function withVertices(tool: Parameters<typeof startSession>[0], coords: ReadonlyArray<readonly [number, number]>) {
  let s = startSession(tool);
  for (const [lon, lat] of coords) s = placeVertex(s, C(lon, lat));
  return s;
}

describe('confirmShape (FR-76 minimum vertices)', () => {
  it('point: 1 vertex confirms', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Point, [[0, 0]]));
    expect(r.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('point: 0 vertices rejected as too few', () => {
    const r = confirmShape(startSession(ADD_TOOL_KIND.Point));
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.TooFewVertices);
    }
  });

  it('line: <2 rejected, ≥2 ok', () => {
    expect(confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0]])).status).toBe(
      CONFIRM_STATUS.Rejected,
    );
    const ok = confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]]));
    expect(ok.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('face: <3 rejected, ≥3 ok', () => {
    expect(
      confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [1, 0]])).status,
    ).toBe(CONFIRM_STATUS.Rejected);
    const ok = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]));
    expect(ok.status).toBe(CONFIRM_STATUS.Ok);
  });

  it('too-few rejection carries required/actual for the message (FR-115)', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Face, [[0, 0]]));
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.required).toBe(3);
      expect(r.rejection.actual).toBe(1);
    }
  });

  it('face: a self-intersecting ring is rejected (FR-25)', () => {
    // Bowtie: (0,0)-(2,2)-(2,0)-(0,2) self-intersects.
    const r = confirmShape(
      withVertices(ADD_TOOL_KIND.Face, [[0, 0], [2, 2], [2, 0], [0, 2]]),
    );
    expect(r.status).toBe(CONFIRM_STATUS.Rejected);
    if (r.status === CONFIRM_STATUS.Rejected) {
      expect(r.rejection.kind).toBe(SHAPE_REJECT.SelfIntersecting);
    }
  });

  it('produces a draft whose coordinates match the placed vertices', () => {
    const r = confirmShape(withVertices(ADD_TOOL_KIND.Line, [[0, 0], [3, 4]]));
    if (r.status === CONFIRM_STATUS.Ok) {
      expect(draftCoordinates(r.draft)).toEqual([C(0, 0), C(3, 4)]);
    }
  });
});
