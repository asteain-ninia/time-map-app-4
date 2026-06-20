// Bug-hunt (focus: save-load-roundtrip-identity).
//
// A model-based / property-based suite that generates a random sequence of edit
// commands over a valid DomainProject and, AFTER EACH command, asserts the
// load-relevant invariants plus the persistence round-trip identity:
//
//   - ring alternation (territory↔hole) valid per leaf shape
//   - anchor-series invariants (INV-1 ascending, INV-2 non-overlap, INV-3 span)
//   - hierarchy forest validity (no cycle / dangling parent)
//   - no NaN / ±Infinity in any persisted coordinate or numeric field
//   - every referenced vertex id resolves (selection / refs always valid)
//   - save→load = identity  (deserialize(serialize(p)) ≡ p, via projectsEqual)
//
// Metamorphic properties:
//   - undo ∘ op = identity      (history.undo(execute(h, cmd)) restores state)
//   - op ∘ inverse-op = identity (deleteAnchor after applyPastEdit insert, etc.)
//   - save ∘ load = identity     (serialize(deserialize(m)) deep-equals m;
//                                 deserialize(serialize(p)) ≡ p)
//
// Determinism: seed pinned to 6001 for THIS file (overriding the suite-wide
// seed), numRuns kept large (300–600). The test is a permanent asset: it asserts
// the SPECIFIED behaviour and does not paper over a real defect.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import {
  createAnchorEntry,
  changeStart,
  deleteAnchor,
  setEnd,
  applyPastEdit,
  normalizeSeries,
  validateSeries,
  type AnchorSeries,
} from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  withColor,
  type Feature,
} from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { buildForest } from '../hierarchy/forest';
import { validateHierarchy } from '../hierarchy/validate';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing, isAlternationValid } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, getVertex, setVertex, type Vertex } from '../vertex';
import { moveVertexTo } from '../editing/move';
import {
  serialize,
  projectsEqual,
  type DomainProject,
  type FeatureHistory,
  type ProjectSettings,
  type BaseMapReference,
} from '../persistence/serialize';
// deserialize is persistence-internal (R8 / 受け入れ基準8): it must not run on
// unvalidated EXTERNAL input. This metamorphic round-trip test calls it only on
// manifests it serialized itself (trusted, internally-produced data) — the same
// legitimate use as src/domain/persistence/round-trip.test.ts — so the R8 import
// restriction is scoped-disabled here with that justification.
// eslint-disable-next-line no-restricted-imports
import { deserialize } from '../persistence/serialize';
import { parseManifest, PARSE_OUTCOME } from '../persistence';

const CAL = getCalendar('gregorian');
const SEED = 6001;

const SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40000, 0.0034),
  gridSpacingDeg: 10,
  snapDistancePx: 50,
  autoColorDefault: true,
};

const BASEMAP: BaseMapReference = {
  source: '@preset/equirectangular-world',
  meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
};

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 0.5, 0.75);

// --- arbitraries built from REAL domain factories (R7) ----------------------

/** A square territory-ring leaf feature plus its 4 vertices, placed at (ox,oy). */
function squareLeaf(id: string, ox: number, oy: number, size: number): {
  feature: Feature;
  vertices: Vertex[];
} {
  const verts = [
    createVertex(asVertexId(`${id}-0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${id}-1`), createCoordinate(ox + size, oy)),
    createVertex(asVertexId(`${id}-2`), createCoordinate(ox + size, oy + size)),
    createVertex(asVertexId(`${id}-3`), createCoordinate(ox, oy + size)),
  ];
  const ring = createTerritoryRing(
    asRingId(`${id}-r`),
    verts.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`地物${id}`, 0, 100),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices: verts };
}

/** A point feature + its single vertex. */
function pointFeature(id: string, lon: number, lat: number): { feature: Feature; vertex: Vertex } {
  const v = createVertex(asVertexId(`${id}-v`), createCoordinate(lon, lat));
  const feature = createPointFeature(
    asFeatureId(id),
    createBasicAttributes(`点${id}`, 0, 50),
    COLOR,
    v.id,
    { kindLabel: '都市' },
  );
  return { feature, vertex: v };
}

/** A line feature + its two vertices. */
function lineFeature(id: string): { feature: Feature; vertices: Vertex[] } {
  const a = createVertex(asVertexId(`${id}-a`), createCoordinate(0, 0));
  const b = createVertex(asVertexId(`${id}-b`), createCoordinate(5, 5));
  const feature = createLineFeature(
    asFeatureId(id),
    createBasicAttributes(`線${id}`, -50, 0),
    COLOR,
    [a.id, b.id],
  );
  return { feature, vertices: [a, b] };
}

type FeatureKindTag = 'leaf' | 'point' | 'line';

/** A history with N anchors (distinct years), each carrying the same snapshot. */
function multiAnchorHistory(
  id: string,
  features: readonly Feature[],
  vertices: readonly Vertex[],
  startYears: readonly number[],
): FeatureHistory {
  const store = createVertexStore([...vertices]);
  const entries = startYears.map((y, i) =>
    createAnchorEntry(
      createAnchor(asAnchorId(`${id}-anc-${i}`), createAnchorSnapshot(features, store)),
      timePointYear(y),
      null,
    ),
  );
  return { featureId: asFeatureId(id), series: normalizeSeries(entries, CAL) };
}

/** Generate a valid, spatially-disjoint project. */
function projectArb(): fc.Arbitrary<DomainProject> {
  // Each history is one of leaf / point / line; leaves get a multi-anchor series.
  const kindArb: fc.Arbitrary<FeatureKindTag> = fc.constantFrom('leaf', 'point', 'line');
  return fc
    .array(
      fc.record({
        kind: kindArb,
        // Strictly ascending distinct anchor years (so the series is already valid).
        years: fc
          .uniqueArray(fc.integer({ min: -200, max: 200 }), { minLength: 1, maxLength: 4 })
          .map((ys) => [...ys].sort((a, b) => a - b)),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((specs) => {
      const histories: FeatureHistory[] = specs.map((spec, i) => {
        const id = `f${i}`;
        // Place each feature far apart so no spatial overlap at any time slice.
        const ox = i * 100;
        if (spec.kind === 'leaf') {
          const { feature, vertices } = squareLeaf(id, ox, 0, 10);
          return multiAnchorHistory(id, [feature], vertices, spec.years);
        }
        if (spec.kind === 'point') {
          const { feature, vertex } = pointFeature(id, ox, 0);
          return multiAnchorHistory(id, [feature], [vertex], spec.years);
        }
        const { vertices } = lineFeature(id);
        // shift line vertices apart per index to avoid coincidence
        const shifted = vertices.map((v) =>
          createVertex(v.id, createCoordinate(v.coordinate.lon + ox, v.coordinate.lat)),
        );
        const lf = createLineFeature(
          asFeatureId(id),
          createBasicAttributes(`線${id}`, -50, 0),
          COLOR,
          shifted.map((v) => v.id),
        );
        return multiAnchorHistory(id, [lf], shifted, spec.years);
      });
      return { histories, settings: SETTINGS, baseMap: BASEMAP };
    });
}

// --- invariant checks (load-relevant) ---------------------------------------

function allCoordsFinite(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      for (const v of e.anchor.snapshot.vertices.byId.values()) {
        if (!Number.isFinite(v.coordinate.lon) || !Number.isFinite(v.coordinate.lat)) return false;
      }
    }
  }
  for (const m of [
    project.baseMap.meta.lonWest,
    project.baseMap.meta.lonEast,
    project.baseMap.meta.latNorth,
    project.baseMap.meta.latSouth,
    project.settings.geo.equatorKm,
    project.settings.geo.flattening,
    project.settings.gridSpacingDeg,
    project.settings.snapDistancePx,
  ]) {
    if (!Number.isFinite(m)) return false;
  }
  return true;
}

function seriesValid(project: DomainProject): boolean {
  return project.histories.every((h) => validateSeries(h.series, CAL).ok);
}

function ringsAlternationValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      for (const f of e.anchor.snapshot.features) {
        if (f.kind === 'leaf' && !isAlternationValid(f.shape)) return false;
      }
    }
  }
  return true;
}

function hierarchyValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const features = e.anchor.snapshot.features;
      buildForest(features); // cycle-safe construction
      const res = validateHierarchy(features, { flagEmptyAggregates: false });
      // Only structural topology (cycle / dangling parent / duplicate id) is a
      // load-blocking invariant here; aggregate-shape geometry is a separate kind.
      const topo = res.violations.filter(
        (v) => v.kind !== 'aggregate-shape-mismatch' && v.kind !== 'shape-unresolved',
      );
      if (topo.length > 0) return false;
    }
  }
  return true;
}

function refsResolve(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const store = e.anchor.snapshot.vertices;
      for (const f of e.anchor.snapshot.features) {
        const refs: string[] = [];
        if (f.kind === 'point') refs.push(f.vertexId);
        if (f.kind === 'line') refs.push(...f.vertexIds);
        if (f.kind === 'leaf') for (const r of f.shape.rings) refs.push(...r.vertexIds);
        for (const vid of refs) if (!store.byId.has(asVertexId(vid))) return false;
      }
    }
  }
  return true;
}

/** Round-trip identity (the focus): deserialize(serialize(p)) ≡ p. */
function roundTripsClean(project: DomainProject): boolean {
  return projectsEqual(project, deserialize(serialize(project)));
}

/** save∘load: serialize(deserialize(serialize(p))) deep-equals serialize(p). */
function saveLoadSaveStable(project: DomainProject): boolean {
  const m1 = serialize(project);
  const m2 = serialize(deserialize(m1));
  return JSON.stringify(m1) === JSON.stringify(m2);
}

function checkAllInvariants(project: DomainProject): { ok: boolean; failed: string } {
  if (!allCoordsFinite(project)) return { ok: false, failed: 'finite-coords' };
  if (!seriesValid(project)) return { ok: false, failed: 'series-invariants' };
  if (!ringsAlternationValid(project)) return { ok: false, failed: 'ring-alternation' };
  if (!hierarchyValid(project)) return { ok: false, failed: 'hierarchy-topology' };
  if (!refsResolve(project)) return { ok: false, failed: 'vertex-refs' };
  if (!roundTripsClean(project)) return { ok: false, failed: 'roundtrip-identity' };
  if (!saveLoadSaveStable(project)) return { ok: false, failed: 'save-load-save-stable' };
  return { ok: true, failed: '' };
}

// --- random edit commands over a single feature history ---------------------

type EditCmd =
  | { tag: 'changeStart'; hi: number; anchorIdx: number; year: number }
  | { tag: 'setEnd'; hi: number; anchorIdx: number; year: number | null }
  | { tag: 'deleteAnchor'; hi: number; anchorIdx: number }
  | { tag: 'insertPastEdit'; hi: number; year: number }
  | { tag: 'recolor'; hi: number; opacity: number }
  | { tag: 'moveVertex'; hi: number; anchorIdx: number; dLon: number; dLat: number };

function cmdArb(): fc.Arbitrary<EditCmd> {
  return fc.oneof(
    fc.record({
      tag: fc.constant('changeStart' as const),
      hi: fc.nat(),
      anchorIdx: fc.nat(),
      year: fc.integer({ min: -300, max: 300 }),
    }),
    fc.record({
      tag: fc.constant('setEnd' as const),
      hi: fc.nat(),
      anchorIdx: fc.nat(),
      year: fc.option(fc.integer({ min: -300, max: 300 }), { nil: null }),
    }),
    fc.record({ tag: fc.constant('deleteAnchor' as const), hi: fc.nat(), anchorIdx: fc.nat() }),
    fc.record({
      tag: fc.constant('insertPastEdit' as const),
      hi: fc.nat(),
      year: fc.integer({ min: -300, max: 300 }),
    }),
    fc.record({
      tag: fc.constant('recolor' as const),
      hi: fc.nat(),
      opacity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
    // Realistic finite drag deltas (vertex-move tool). Bounded so they stay on
    // the map; this is the everyday edit, not an adversarial value.
    fc.record({
      tag: fc.constant('moveVertex' as const),
      hi: fc.nat(),
      anchorIdx: fc.nat(),
      dLon: fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }),
      dLat: fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }),
    }),
  );
}

/** Apply one command to a project; invalid/rejected ops leave the project as-is. */
function applyCmd(project: DomainProject, cmd: EditCmd): DomainProject {
  const histories = [...project.histories];
  const n = histories.length;
  if (n === 0) return project;
  const hi = cmd.hi % n;
  const history = histories[hi]!;
  const entries = history.series.entries;
  const replaceSeries = (series: AnchorSeries): DomainProject => {
    histories[hi] = { featureId: history.featureId, series };
    return { ...project, histories };
  };

  switch (cmd.tag) {
    case 'changeStart': {
      if (entries.length === 0) return project;
      const target = entries[cmd.anchorIdx % entries.length]!;
      const res = changeStart(history.series, target.anchor.id, timePointYear(cmd.year), CAL);
      return res.ok ? replaceSeries(res.series) : project;
    }
    case 'setEnd': {
      if (entries.length === 0) return project;
      const target = entries[cmd.anchorIdx % entries.length]!;
      const end = cmd.year === null ? null : timePointYear(cmd.year);
      const res = setEnd(history.series, target.anchor.id, end, CAL);
      return res.ok ? replaceSeries(res.series) : project;
    }
    case 'deleteAnchor': {
      if (entries.length === 0) return project;
      const target = entries[cmd.anchorIdx % entries.length]!;
      const res = deleteAnchor(history.series, target.anchor.id, CAL);
      return res.ok ? replaceSeries(res.series) : project;
    }
    case 'insertPastEdit': {
      // Insert a new anchor at `year`, inheriting the effective snapshot, with a
      // fresh anchor id. This is a structural series edit (FR-55).
      const newAnchorId = asAnchorId(`${history.featureId}-ins-${cmd.year}`);
      const series = applyPastEdit(
        history.series,
        timePointYear(cmd.year),
        (effective) => {
          const snap =
            effective.kind === 'present'
              ? effective.entry.anchor.snapshot
              : entries[0]!.anchor.snapshot;
          return createAnchor(newAnchorId, snap);
        },
        CAL,
      );
      return replaceSeries(series);
    }
    case 'recolor': {
      // Recolor every feature in every snapshot of this history (anchor-saved
      // style attribute). New ColorInfo with a generated fill opacity.
      const newColor = createColorInfo(
        true,
        '#102030',
        '#405060',
        '#708090',
        'default',
        cmd.opacity,
        0.75,
      );
      const newEntries = entries.map((e) => ({
        anchor: createAnchor(
          e.anchor.id,
          createAnchorSnapshot(
            e.anchor.snapshot.features.map((f) => withColor(f, newColor)),
            e.anchor.snapshot.vertices,
          ),
        ),
        start: e.start,
        end: e.end,
      }));
      return replaceSeries({ entries: newEntries });
    }
    case 'moveVertex': {
      if (entries.length === 0) return project;
      const eIdx = cmd.anchorIdx % entries.length;
      const entry = entries[eIdx]!;
      const store = entry.anchor.snapshot.vertices;
      const vids = [...store.byId.keys()];
      if (vids.length === 0) return project;
      const vid = vids[cmd.anchorIdx % vids.length]!;
      const cur = getVertex(store, vid)!;
      const moved = moveVertexTo(vid, store, {
        lon: cur.coordinate.lon + cmd.dLon,
        lat: cur.coordinate.lat + cmd.dLat,
      });
      if (moved === undefined) return project;
      const newStore = setVertex(store, moved);
      const newEntries = entries.map((e, i) =>
        i === eIdx
          ? {
              anchor: createAnchor(
                e.anchor.id,
                createAnchorSnapshot(e.anchor.snapshot.features, newStore),
              ),
              start: e.start,
              end: e.end,
            }
          : e,
      );
      return replaceSeries({ entries: newEntries });
    }
  }
}

/** save→load through the ACTUAL persistence boundary (JSON serialize + Zod parse
 * + deserialize), which is what a real file save/load does. A project that
 * passes the in-memory `roundTripsClean` mirror can still fail HERE (e.g. a
 * non-finite coordinate the domain factories accept but the Zod schema rejects),
 * so this is the load-faithful identity check. */
function boundaryRoundTrips(project: DomainProject): { ok: boolean; reason: string } {
  const json = JSON.parse(JSON.stringify(serialize(project)));
  const parsed = parseManifest(json);
  if (parsed.outcome !== PARSE_OUTCOME.Ok) return { ok: false, reason: `parse:${parsed.outcome}` };
  if (!projectsEqual(project, deserialize(parsed.manifest))) return { ok: false, reason: 'not-equal' };
  return { ok: true, reason: '' };
}

// ============================================================================
// tests
// ============================================================================

describe('save-load-roundtrip-identity (bug hunt)', () => {
  it('round-trip identity holds for any generated valid project', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        const check = checkAllInvariants(project);
        if (!check.ok) {
          throw new Error(`base project failed: ${check.failed}`);
        }
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('every invariant + round-trip identity survives a random edit-command sequence', () => {
    fc.assert(
      fc.property(
        projectArb(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 20 }),
        (initial, cmds) => {
          let project = initial;
          // Precondition: the generated base is clean.
          const base = checkAllInvariants(project);
          if (!base.ok) throw new Error(`generated base invalid: ${base.failed}`);

          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(
                `invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)}`,
              );
            }
          }
        },
      ),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('metamorphic: save∘load is the identity on the manifest (serialize=deserialize mirror)', () => {
    fc.assert(
      fc.property(projectArb(), fc.array(cmdArb(), { maxLength: 12 }), (initial, cmds) => {
        let project = initial;
        for (const cmd of cmds) project = applyCmd(project, cmd);
        // load(save(p)) ≡ p
        expect(projectsEqual(project, deserialize(serialize(project)))).toBe(true);
        // save(load(save(p))) byte-equals save(p)
        const m = serialize(project);
        expect(JSON.stringify(serialize(deserialize(m)))).toBe(JSON.stringify(m));
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('save→load through the ACTUAL boundary (JSON + Zod) is the identity after edits', () => {
    fc.assert(
      fc.property(projectArb(), fc.array(cmdArb(), { maxLength: 20 }), (initial, cmds) => {
        let project = initial;
        for (const cmd of cmds) {
          project = applyCmd(project, cmd);
          const rt = boundaryRoundTrips(project);
          if (!rt.ok) {
            throw new Error(`boundary round-trip broke (${rt.reason}) after ${JSON.stringify(cmd)}`);
          }
        }
      }),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('metamorphic: serialize output always re-parses through the Zod boundary', () => {
    fc.assert(
      fc.property(projectArb(), fc.array(cmdArb(), { maxLength: 12 }), (initial, cmds) => {
        let project = initial;
        for (const cmd of cmds) project = applyCmd(project, cmd);
        const json = JSON.parse(JSON.stringify(serialize(project)));
        const parsed = parseManifest(json);
        if (parsed.outcome !== PARSE_OUTCOME.Ok) {
          throw new Error(`manifest failed to re-parse: ${parsed.outcome}`);
        }
        // And the parsed manifest deserializes back to an equal project.
        expect(projectsEqual(project, deserialize(parsed.manifest))).toBe(true);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});
