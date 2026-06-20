// HB-15 — live SelectionPort unit lens. The port drives U22's OWN reducer over the
// store selection truth (single source — 教訓 5.29), so a CLICK release applies the
// verbatim U22 semantics: 頂点→replace (Shift→toggle), 地物本体→active feature AND the
// vertex set cleared (Codex P1 regression-lock), 空→clear. A DRAG release selects
// nothing (the one click/drag verdict — 教訓 5.30).

import { describe, expect, it } from 'vitest';

import { createLiveSelectionPort } from './live-selection-port';
import { NO_MODIFIERS } from './ports';
import {
  EMPTY_SELECTION,
  featureBodyHit,
  replaceVertices,
  vertexHit,
  type SelectionState,
} from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';

/** A tiny in-memory store seam mirroring store.getSelection / restoreSelection. */
function makeSeam(initial: SelectionState = EMPTY_SELECTION) {
  let selection = initial;
  return {
    seam: {
      getSelection: () => selection,
      restoreSelection: (s: SelectionState) => {
        selection = s;
      },
    },
    current: () => selection,
  };
}

// Surface→world stub: identity (the reducer only uses world coords for click vs drag,
// and a click has origin === at regardless of the mapping).
const screenToWorld = (p: { x: number; y: number }) => ({ lon: p.x, lat: p.y });
const pt = { x: 10, y: 10 };

const fid = asFeatureId('f-1');
const vid = asVertexId('v-1');

describe('createLiveSelectionPort', () => {
  it('a CLICK on a vertex replaces the vertex selection with that vertex', () => {
    const { seam, current } = makeSeam();
    const port = createLiveSelectionPort(seam, screenToWorld);
    port.start(vertexHit(fid, vid), pt, NO_MODIFIERS);
    port.end(pt, false);
    expect(current().vertexOwner).toBe(fid);
    expect([...current().vertexIds]).toEqual([vid]);
  });

  it('a Shift+CLICK on a vertex TOGGLES it off when already selected (FR-80)', () => {
    const pre = replaceVertices(EMPTY_SELECTION, fid, new Set([vid]));
    const { seam, current } = makeSeam(pre);
    const port = createLiveSelectionPort(seam, screenToWorld);
    port.start(vertexHit(fid, vid), pt, { ...NO_MODIFIERS, shift: true });
    port.end(pt, false);
    // Toggling the only selected vertex off empties the set.
    expect(current().vertexIds.size).toBe(0);
  });

  it('a CLICK on a feature body promotes the active feature AND clears the vertex set', () => {
    // Pre-select a vertex so we can prove the body click CLEARS it (Codex P1).
    const pre = replaceVertices(EMPTY_SELECTION, fid, new Set([vid]));
    const { seam, current } = makeSeam(pre);
    const port = createLiveSelectionPort(seam, screenToWorld);
    const body = asFeatureId('f-2');
    port.start(featureBodyHit(body), pt, NO_MODIFIERS);
    port.end(pt, false);
    expect(current().activeFeature).toBe(body);
    expect(current().vertexIds.size).toBe(0);
    expect(current().vertexOwner).toBeNull();
  });

  it('a CLICK on empty space clears the selection', () => {
    const pre = replaceVertices(EMPTY_SELECTION, fid, new Set([vid]));
    const { seam, current } = makeSeam(pre);
    const port = createLiveSelectionPort(seam, screenToWorld);
    port.start({ kind: 'empty' } as const, pt, NO_MODIFIERS);
    port.end(pt, false);
    expect(current().vertexIds.size).toBe(0);
    expect(current().activeFeature).toBeNull();
  });

  it('a DRAG release selects NOTHING (it is a pan/edit gesture, not a select)', () => {
    const { seam, current } = makeSeam();
    const port = createLiveSelectionPort(seam, screenToWorld);
    port.start(featureBodyHit(fid), pt, NO_MODIFIERS);
    port.move({ x: 40, y: 40 });
    port.end({ x: 40, y: 40 }, true);
    expect(current()).toBe(EMPTY_SELECTION);
  });

  it('cancel drops the captured hit so a later end selects nothing (教訓 5.2)', () => {
    const { seam, current } = makeSeam();
    const port = createLiveSelectionPort(seam, screenToWorld);
    port.start(featureBodyHit(fid), pt, NO_MODIFIERS);
    port.cancel();
    port.end(pt, false);
    expect(current()).toBe(EMPTY_SELECTION);
  });
});
