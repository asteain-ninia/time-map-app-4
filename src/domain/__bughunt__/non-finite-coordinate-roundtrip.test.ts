// Bug-hunt regression: non-finite coordinate save→load asymmetry (NOW FIXED).
//
// FINDING (original defect): the domain value factories accepted non-finite
// numbers WITHOUT a guard — createCoordinate / moveVertexTo+shift
// (src/domain/editing/move.ts) all did raw arithmetic. But the persistence
// boundary cannot carry them:
//   - JSON.stringify(Infinity | NaN)  ===  "null"   (JSON has no Inf/NaN)
//   - the Zod schema's finiteNumber (.finite()) then REJECTS null
//     → parseManifest returned the Invalid outcome (the WHOLE file failed to load).
//
// So a project containing a non-finite coordinate (reachable upstream via a
// divide-by-zero in a projection / drag computation, or a corrupted import) was
// NOT round-trip-safe: it either differed in memory (NaN !== NaN) or silently
// corrupted to null on save and then made the ENTIRE manifest un-loadable —
// total data loss for that project, with no targeted error.
//
// FIX (root cause, single construction seam): `createCoordinate` now throws a
// RangeError on a non-finite scalar — the same fail-loud stance the downstream
// `quantizeCoordinate` already takes — so the bad value can never be born,
// persisted, or silently differ from itself. `editing/move.ts#shift` routes
// through that same seam, so a non-finite delta also fails at birth.
//
// These tests now ASSERT THE FIXED BEHAVIOUR and are the regression anchor.

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, withLat, withLon } from '../coordinate';
import { createPointFeature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asAnchorId, asFeatureId, asVertexId } from '../ids';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';
import { moveVertexSet } from '../editing/move';
import {
  PARSE_OUTCOME,
  manifestToProject,
  parseManifest,
  projectsEqual,
  serialize,
  type DomainProject,
} from '../persistence';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#1', '#2', '#3');

function projectWithCoord(lon: number, lat: number): DomainProject {
  const v = createVertex(asVertexId('v'), createCoordinate(lon, lat));
  const f = createPointFeature(asFeatureId('p'), createBasicAttributes('n', 0, 1), COLOR, v.id);
  const anchor = createAnchor(asAnchorId('a'), createAnchorSnapshot([f], createVertexStore([v])));
  return {
    histories: [
      {
        featureId: asFeatureId('p'),
        series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), null)], CAL),
      },
    ],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

describe('non-finite coordinate save→load asymmetry (fixed: finite-guard at the seam)', () => {
  it('createCoordinate rejects a NaN scalar at construction (fail loud, not silent)', () => {
    expect(() => createCoordinate(NaN, 0)).toThrow(RangeError);
    expect(() => createCoordinate(0, NaN)).toThrow(RangeError);
  });

  it('createCoordinate rejects a ±Infinity scalar at construction', () => {
    expect(() => createCoordinate(Infinity, 0)).toThrow(RangeError);
    expect(() => createCoordinate(0, -Infinity)).toThrow(RangeError);
  });

  it('the withXxx mutators inherit the guard (same seam)', () => {
    const base = createCoordinate(1, 2);
    expect(() => withLon(base, Infinity)).toThrow(RangeError);
    expect(() => withLat(base, NaN)).toThrow(RangeError);
  });

  it('a move delta that drives a vertex non-finite fails loudly (shift routes through the seam)', () => {
    const v = createVertex(asVertexId('v'), createCoordinate(0, 0));
    const store = createVertexStore([v]);
    // An Infinity dLon (e.g. from an upstream divide-by-zero) must not silently
    // produce a poisoned vertex body.
    expect(() => moveVertexSet([v.id], store, { dLon: Infinity, dLat: 0 })).toThrow(RangeError);
    expect(() => moveVertexSet([v.id], store, { dLon: NaN, dLat: 0 })).toThrow(RangeError);
  });

  it('a project can never be built with a non-finite coordinate, so the save→load identity always holds', () => {
    // Construction is now impossible — the data-loss scenario is unreachable.
    expect(() => projectWithCoord(NaN, 0)).toThrow(RangeError);
    expect(() => projectWithCoord(Infinity, 0)).toThrow(RangeError);
  });

  it('a finite project still round-trips through the real JSON+Zod boundary (the identity)', () => {
    const p = projectWithCoord(123.456, -7.89);
    // real save (JSON) then load through the Zod parse boundary (R8) succeeds and
    // reconstructs the identical project — the data-loss path is gone for finite
    // coords and unreachable for non-finite ones (they cannot be constructed).
    const json = JSON.parse(JSON.stringify(serialize(p))) as unknown;
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      expect(projectsEqual(p, manifestToProject(parsed.manifest))).toBe(true);
    }
  });
});
