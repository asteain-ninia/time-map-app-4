// U25 — ring-edit render-batch builder tests (FR-22 仮表示 / クロージング線半透明 /
// FR-17). Mirrors add-batch's coverage: a null draft is an empty frame; placed
// vertices draw markers + edges; the closing line appears only at ≥3 vertices; the
// preview follows the cursor; the accent colour switches by hole/enclave mode.

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../domain/coordinate';
import { asFeatureId } from '../domain/ids';
import { RING_ADD_MODE, type RingAddDraft } from '../domain/ring-edit/index';

import { buildRingEditPrimitives, DEFAULT_RING_EDIT_STYLE } from './ring-edit-batch';

const FID = asFeatureId('f');

function draft(partial: Partial<RingAddDraft>): RingAddDraft {
  return {
    targetFeatureId: FID,
    mode: RING_ADD_MODE.Hole,
    vertices: [],
    preview: null,
    gridSnap: false,
    ...partial,
  };
}

describe('buildRingEditPrimitives', () => {
  it('a null draft yields an empty frame (教訓 5.18)', () => {
    expect(buildRingEditPrimitives(null)).toEqual([]);
  });

  it('one placed vertex draws a single marker, no edge / closing line', () => {
    const prims = buildRingEditPrimitives(draft({ vertices: [createCoordinate(1, 1)] }));
    expect(prims.filter((p) => p.kind === 'point')).toHaveLength(1);
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(0);
  });

  it('two vertices draw an edge but no closing line (< 3, 教訓 5.18)', () => {
    const prims = buildRingEditPrimitives(
      draft({ vertices: [createCoordinate(0, 0), createCoordinate(2, 0)] }),
    );
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(1);
    expect(prims.filter((p) => p.kind === 'point')).toHaveLength(2);
  });

  it('three vertices add a translucent closing line (spec §クロージング線半透明)', () => {
    const prims = buildRingEditPrimitives(
      draft({
        vertices: [createCoordinate(0, 0), createCoordinate(2, 0), createCoordinate(1, 2)],
      }),
    );
    const lines = prims.filter((p) => p.kind === 'line');
    // placed polyline + closing line.
    expect(lines).toHaveLength(2);
    // The closing line uses a translucent (alpha-suffixed) stroke.
    const strokes = lines.map((l) => (l.kind === 'line' ? l.stroke : ''));
    expect(strokes.some((s) => s.length > 7)).toBe(true);
  });

  it('a preview point adds a preview edge + marker when ≥1 vertex placed', () => {
    const withPreview = buildRingEditPrimitives(
      draft({ vertices: [createCoordinate(0, 0)], preview: createCoordinate(3, 3) }),
    );
    // placed marker + preview marker = 2 points; preview edge = 1 line.
    expect(withPreview.filter((p) => p.kind === 'point')).toHaveLength(2);
    expect(withPreview.filter((p) => p.kind === 'line')).toHaveLength(1);
  });

  it('hole vs enclave modes use different accent strokes (対概念; 教訓 2.10)', () => {
    const vs = [createCoordinate(0, 0), createCoordinate(2, 0)];
    const holeLine = buildRingEditPrimitives(draft({ mode: RING_ADD_MODE.Hole, vertices: vs }))
      .find((p) => p.kind === 'line');
    const enclaveLine = buildRingEditPrimitives(
      draft({ mode: RING_ADD_MODE.Enclave, vertices: vs }),
    ).find((p) => p.kind === 'line');
    const holeStroke = holeLine?.kind === 'line' ? holeLine.stroke : '';
    const enclaveStroke = enclaveLine?.kind === 'line' ? enclaveLine.stroke : '';
    expect(holeStroke).toBe(DEFAULT_RING_EDIT_STYLE.holeStroke);
    expect(enclaveStroke).toBe(DEFAULT_RING_EDIT_STYLE.enclaveStroke);
    expect(holeStroke).not.toBe(enclaveStroke);
  });
});
