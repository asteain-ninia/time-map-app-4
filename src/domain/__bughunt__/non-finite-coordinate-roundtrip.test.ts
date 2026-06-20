// Bug-hunt characterization: non-finite coordinate save→load asymmetry.
//
// FINDING (captured, not faked green): the domain value factories accept
// non-finite numbers WITHOUT a guard — createCoordinate / moveVertexTo+shift
// (src/domain/editing/move.ts) / the geo + base-map setters all do raw
// arithmetic. But the persistence boundary cannot carry them:
//   - JSON.stringify(Infinity | NaN)  ===  "null"   (JSON has no Inf/NaN)
//   - the Zod schema's finiteNumber (.finite()) then REJECTS null
//     → parseManifest returns the Invalid outcome (the WHOLE file fails to load).
//
// So a project containing a non-finite coordinate (reachable upstream via a
// divide-by-zero in a projection / drag computation, or a corrupted import) is
// NOT round-trip-safe: it either differs in memory (NaN !== NaN) or silently
// corrupts to null on save and then makes the ENTIRE manifest un-loadable.
//
// These tests ASSERT THE CURRENT BEHAVIOUR (the defect) so they stay green and
// document the gap. If the domain later adds a finite-guard at the value seam
// (or the boundary repairs non-finite to a sentinel), update these to the fixed
// expectation — they are the regression anchor for that decision.

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createPointFeature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asAnchorId, asFeatureId, asVertexId } from '../ids';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';
import { deserialize, projectsEqual, serialize, type DomainProject } from '../persistence/serialize';
import { PARSE_OUTCOME, parseManifest } from '../persistence';

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

describe('non-finite coordinate save→load asymmetry (captured defect)', () => {
  it('the domain factories accept a NaN / Infinity coordinate with no guard', () => {
    // No throw — the defect's root cause: there is no finite-guard at the seam.
    expect(() => projectWithCoord(NaN, 0)).not.toThrow();
    expect(() => projectWithCoord(Infinity, 0)).not.toThrow();
    const lon = projectWithCoord(Infinity, 0)
      .histories[0]!.series.entries[0]!.anchor.snapshot.vertices.byId.get(asVertexId('v'))!.coordinate
      .lon;
    expect(lon).toBe(Infinity);
  });

  it('NaN coordinate: even the in-memory mirror round-trip is NOT the identity (NaN !== NaN)', () => {
    const p = projectWithCoord(NaN, 0);
    // deserialize(serialize(p)) rebuilds the NaN, but projectsEqual uses === so a
    // NaN field is never equal to itself: the round-trip "identity" silently fails.
    expect(projectsEqual(p, deserialize(serialize(p)))).toBe(false);
  });

  it('Infinity coordinate: in-memory mirror passes, but the JSON+Zod boundary rejects the WHOLE file', () => {
    const p = projectWithCoord(Infinity, 0);
    // The persistence-internal mirror (no JSON, no Zod) is happy: Infinity === Infinity.
    expect(projectsEqual(p, deserialize(serialize(p)))).toBe(true);
    // But a REAL save (JSON) turns Infinity into null...
    // The persisted manifest flattens history → { featureId, entries } (no `series`).
    const json = JSON.parse(JSON.stringify(serialize(p))) as {
      histories: {
        entries: {
          anchor: { snapshot: { vertices: { coordinate: { lon: number | null } }[] } };
        }[];
      }[];
    };
    expect(json.histories[0]!.entries[0]!.anchor.snapshot.vertices[0]!.coordinate.lon).toBeNull();
    // ...and load then REJECTS the entire manifest (data loss, not a partial repair).
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Invalid);
  });
});
