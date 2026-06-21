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
// Determinism: seed pinned to 6004 for THIS file (overriding the suite-wide
// seed), numRuns kept large (300–1000). The test is a permanent asset: it asserts
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
  createAggregateFeature,
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
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
} from '../ring';
import { createHistory, execute, redo, undo } from '../command/history';
import { defineCommandKind, type Command } from '../command/command';
import { EMPTY_COMMAND_RESULT } from '../command/result';
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
import { resolveAt } from '../anchor-series';
import { EMPTY_SELECTION, withActiveFeature } from '../selection/state';
import { revalidateForTime, type ExistenceAtTime } from '../selection/reresolve';

const CAL = getCalendar('gregorian');
// Determinism: seed pinned to 6004 for THIS file (overriding the suite-wide seed)
// per the bug-hunt brief. numRuns kept large (300–1000).
const SEED = 6004;

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

// ============================================================================
// EXTENDED SURFACE (seed 6004): hole rings, derived aggregates (子の和), shared
// vertices, and a GENUINE undo through the U12 history module. These exercise
// invariant surfaces the disjoint-square generator above never reaches.
// ============================================================================

/**
 * A leaf with a territory ring AND a hole ring inside it (FR-24/25 alternation).
 * Outer square at (ox,oy) size 30; an inner hole square inset by `inset`.
 */
function holedLeaf(
  id: string,
  ox: number,
  oy: number,
): { feature: Feature; vertices: Vertex[] } {
  const size = 30;
  const inset = 10;
  const outer = [
    createVertex(asVertexId(`${id}-o0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${id}-o1`), createCoordinate(ox + size, oy)),
    createVertex(asVertexId(`${id}-o2`), createCoordinate(ox + size, oy + size)),
    createVertex(asVertexId(`${id}-o3`), createCoordinate(ox, oy + size)),
  ];
  const hole = [
    createVertex(asVertexId(`${id}-h0`), createCoordinate(ox + inset, oy + inset)),
    createVertex(asVertexId(`${id}-h1`), createCoordinate(ox + size - inset, oy + inset)),
    createVertex(asVertexId(`${id}-h2`), createCoordinate(ox + size - inset, oy + size - inset)),
    createVertex(asVertexId(`${id}-h3`), createCoordinate(ox + inset, oy + size - inset)),
  ];
  const terrId = asRingId(`${id}-tr`);
  const territory = createTerritoryRing(terrId, outer.map((v) => v.id));
  const holeRing = createHoleRing(
    asRingId(`${id}-hr`),
    hole.map((v) => v.id),
    terrId,
  );
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`穴地物${id}`, 0, 100),
    COLOR,
    createShape([territory, holeRing]),
  );
  return { feature, vertices: [...outer, ...hole] };
}

/**
 * A derived aggregate over two adjacent child leaves that TILE a rectangle with
 * no inter-child gap (派生集約 = 子の和, FR-35). Returns the parent aggregate +
 * its two children + their shared edge vertices. The two child squares share the
 * edge x = ox+10 (共有頂点): child A is [ox,ox+10], child B is [ox+10,ox+20].
 */
function aggregateWithChildren(
  id: string,
  ox: number,
): { features: Feature[]; vertices: Vertex[] } {
  const oy = 0;
  // Shared edge vertices (cited by BOTH children — genuine共有頂点).
  const sTop = createVertex(asVertexId(`${id}-sT`), createCoordinate(ox + 10, oy));
  const sBot = createVertex(asVertexId(`${id}-sB`), createCoordinate(ox + 10, oy + 10));
  // Child A outer corners (left square).
  const aTL = createVertex(asVertexId(`${id}-aTL`), createCoordinate(ox, oy));
  const aBL = createVertex(asVertexId(`${id}-aBL`), createCoordinate(ox, oy + 10));
  // Child B outer corners (right square).
  const bTR = createVertex(asVertexId(`${id}-bTR`), createCoordinate(ox + 20, oy));
  const bBR = createVertex(asVertexId(`${id}-bBR`), createCoordinate(ox + 20, oy + 10));

  const parentId = asFeatureId(`${id}-agg`);
  const childAId = asFeatureId(`${id}-cA`);
  const childBId = asFeatureId(`${id}-cB`);

  const ringA = createTerritoryRing(asRingId(`${id}-rA`), [aTL.id, sTop.id, sBot.id, aBL.id]);
  const ringB = createTerritoryRing(asRingId(`${id}-rB`), [sTop.id, bTR.id, bBR.id, sBot.id]);

  const childA = createLeafFeature(
    childAId,
    createBasicAttributes(`子A${id}`, 0, 100),
    COLOR,
    createShape([ringA]),
    { parentId },
  );
  const childB = createLeafFeature(
    childBId,
    createBasicAttributes(`子B${id}`, 0, 100),
    COLOR,
    createShape([ringB]),
    { parentId },
  );
  const aggregate = createAggregateFeature(
    parentId,
    createBasicAttributes(`集約${id}`, 0, 100),
    COLOR,
    [childAId, childBId],
  );
  return {
    features: [aggregate, childA, childB],
    vertices: [sTop, sBot, aTL, aBL, bTR, bBR],
  };
}

/** Project whose histories include a holed leaf and an aggregate-with-children. */
function richProjectArb(): fc.Arbitrary<DomainProject> {
  return fc
    .record({
      holes: fc.integer({ min: 0, max: 2 }),
      aggs: fc.integer({ min: 0, max: 2 }),
      plains: fc.integer({ min: 0, max: 2 }),
      years: fc
        .uniqueArray(fc.integer({ min: -150, max: 150 }), { minLength: 1, maxLength: 3 })
        .map((ys) => [...ys].sort((a, b) => a - b)),
    })
    .map((spec) => {
      const histories: FeatureHistory[] = [];
      let slot = 0;
      const place = (): number => 1000 + slot++ * 200; // far apart, never overlapping

      for (let i = 0; i < spec.holes; i += 1) {
        const id = `hole${i}`;
        const { feature, vertices } = holedLeaf(id, place(), 0);
        histories.push(multiAnchorHistory(id, [feature], vertices, spec.years));
      }
      for (let i = 0; i < spec.aggs; i += 1) {
        const id = `agg${i}`;
        const { features, vertices } = aggregateWithChildren(id, place());
        histories.push(multiAnchorHistory(id, features, vertices, spec.years));
      }
      for (let i = 0; i < spec.plains; i += 1) {
        const id = `plain${i}`;
        const { feature, vertices } = squareLeaf(id, place(), 0, 10);
        histories.push(multiAnchorHistory(id, [feature], vertices, spec.years));
      }
      // Guarantee at least one history.
      if (histories.length === 0) {
        const { feature, vertices } = squareLeaf('plain0', place(), 0, 10);
        histories.push(multiAnchorHistory('plain0', [feature], vertices, spec.years));
      }
      return { histories, settings: SETTINGS, baseMap: BASEMAP };
    });
}

/** The derived-aggregate invariant: every aggregate's area = union of its children
 * with no inter-child gap (FR-35 隙間なし). Checked WITH a vertex store so the
 * geometric union actually runs. */
function aggregateUnionValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const features = e.anchor.snapshot.features;
      const res = validateHierarchy(features, {
        flagEmptyAggregates: false,
        vertexStore: e.anchor.snapshot.vertices,
      });
      // Only the aggregate-shape (子の和) verdict matters for THIS invariant;
      // a genuine inter-child gap or an unresolved union is the bug we hunt.
      const aggViolations = res.violations.filter(
        (v) => v.kind === 'aggregate-shape-mismatch' || v.kind === 'shape-unresolved',
      );
      if (aggViolations.length > 0) return false;
    }
  }
  return true;
}

describe('save-load-roundtrip-identity — extended surface (holes / aggregates / shared vertices)', () => {
  it('rich base projects satisfy every load invariant + round-trip identity', () => {
    fc.assert(
      fc.property(richProjectArb(), (project) => {
        const check = checkAllInvariants(project);
        if (!check.ok) throw new Error(`rich base failed: ${check.failed}`);
        if (!aggregateUnionValid(project)) {
          throw new Error('aggregate union (子の和) invalid in base project');
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('all invariants + round-trip survive edits over rich (holed/aggregate) projects', () => {
    fc.assert(
      fc.property(
        richProjectArb(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 20 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkAllInvariants(project);
          if (!base.ok) throw new Error(`generated rich base invalid: ${base.failed}`);
          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(
                `invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)}`,
              );
            }
            // The derived-aggregate (子の和) invariant must also hold after every
            // edit. Vertex moves can in principle distort a tiling; this catches it.
            if (!aggregateUnionValid(project)) {
              throw new Error(`aggregate-union (子の和) broke after cmd ${JSON.stringify(cmd)}`);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 600 },
    );
  });

  it('save→load through the ACTUAL Zod boundary is identity on rich projects after edits', () => {
    fc.assert(
      fc.property(richProjectArb(), fc.array(cmdArb(), { maxLength: 20 }), (initial, cmds) => {
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
});

// ============================================================================
// Metamorphic: undo ∘ op = identity and op ∘ undo ∘ redo = op, driven through
// the REAL U12 history module. We wrap the pure `applyCmd` in a Command whose
// `undo` restores the captured pre-state (教訓5.20: undo data captured at
// execute time), then assert history.undo(execute(h, cmd)).state ≡ h.state and
// that the saved manifest of the redone state equals that of the executed state.
// ============================================================================

const EDIT_KIND = defineCommandKind('bughunt/edit');

/** A reversible command over a DomainProject that captures its prior state at
 * construction so `undo` restores it exactly — the U12 contract for an edit
 * command (pure, deterministic; undo data captured at execute time, 教訓5.20). */
function reversibleEdit(prior: DomainProject, cmd: EditCmd): Command<DomainProject> {
  const after = applyCmd(prior, cmd);
  return {
    kind: EDIT_KIND,
    label: `edit:${cmd.tag}`,
    execute() {
      return { state: after, result: EMPTY_COMMAND_RESULT };
    },
    undo() {
      return { state: prior, result: EMPTY_COMMAND_RESULT };
    },
    redo() {
      return { state: after, result: EMPTY_COMMAND_RESULT };
    },
  };
}

describe('save-load-roundtrip-identity — metamorphic undo/redo (via U12 history)', () => {
  it('undo ∘ op = identity: history.undo(execute(h, cmd)) restores the exact project', () => {
    fc.assert(
      fc.property(richProjectArb(), cmdArb(), (initial, cmd) => {
        const h0 = createHistory<DomainProject>(initial);
        const cmdObj = reversibleEdit(initial, cmd);
        const afterExec = execute(h0, cmdObj);
        const afterUndo = undo(afterExec.history);
        // The undone project must equal the original — round-trip identity of the
        // edit/undo pair, the metamorphic anchor for state restoration.
        expect(projectsEqual(afterUndo.history.state, initial)).toBe(true);
        // And it must still be a clean, save-loadable project.
        const check = checkAllInvariants(afterUndo.history.state);
        if (!check.ok) throw new Error(`undo produced invalid project: ${check.failed}`);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('redo ∘ undo ∘ op = op: redo restores the executed project byte-for-byte (save∘load stable)', () => {
    fc.assert(
      fc.property(richProjectArb(), cmdArb(), (initial, cmd) => {
        const h0 = createHistory<DomainProject>(initial);
        const cmdObj = reversibleEdit(initial, cmd);
        const afterExec = execute(h0, cmdObj);
        const executed = afterExec.history.state;
        const afterUndo = undo(afterExec.history);
        const afterRedo = redo(afterUndo.history);
        // redo(undo(execute)) ≡ execute.
        expect(projectsEqual(afterRedo.history.state, executed)).toBe(true);
        // The persisted manifest of the redone state equals that of the executed
        // state (save ∘ load = identity over the metamorphic redo path).
        expect(JSON.stringify(serialize(afterRedo.history.state))).toBe(
          JSON.stringify(serialize(executed)),
        );
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('op ∘ inverse-op = identity: deleteAnchor after insertPastEdit restores the series', () => {
    // An algebraic inverse pair on the anchor series: insert an anchor at a brand
    // new year, then delete that exact anchor → the series round-trips. This is a
    // domain-level metamorphic identity independent of the history stack.
    fc.assert(
      fc.property(
        richProjectArb(),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 500, max: 900 }),
        (initial, hiPick, newYear) => {
          const project = initial;
          const n = project.histories.length;
          if (n === 0) return;
          const hi = hiPick % n;
          const before = project.histories[hi]!;
          // Insert at a year guaranteed NOT to collide with any existing start
          // (existing years are within [-150,150]); newYear is in [500,900].
          const inserted = applyCmd(project, { tag: 'insertPastEdit', hi, year: newYear });
          const insSeries = inserted.histories[hi]!.series;
          // The insert must have added exactly one anchor with the new year.
          expect(insSeries.entries.length).toBe(before.series.entries.length + 1);
          const newAnchor = insSeries.entries.find(
            (e) => e.start.granularity === 'year' && e.start.year === newYear,
          );
          expect(newAnchor).toBeDefined();
          // Now delete that anchor → the series must equal the original series.
          const del = deleteAnchor(insSeries, newAnchor!.anchor.id, CAL);
          expect(del.ok).toBe(true);
          if (del.ok) {
            const restored: DomainProject = {
              ...inserted,
              histories: inserted.histories.map((h, i) =>
                i === hi ? { featureId: h.featureId, series: del.series } : h,
              ),
            };
            expect(projectsEqual(restored, project)).toBe(true);
          }
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });
});

// ============================================================================
// 選択が常に有効 (selection always valid). The brief lists "selection always
// valid" as a per-edit load invariant alongside the round-trip. We track a real
// SelectionState (an active feature) across the edit sequence and, after EACH
// edit, re-validate it through the REAL U22 `revalidateForTime` against U09
// existence (resolveAt). The invariant: a selection is NEVER left dangling —
// after re-validation the active feature is either (a) null (correctly dropped
// because the feature no longer exists at the probe time) or (b) a feature id
// that genuinely resolves to a present anchor at that time. A selection that
// "survives" pointing at a non-existent feature would be the bug.
// ============================================================================

/** All distinct feature ids that ever appear in a project's snapshots. */
function allFeatureIds(project: DomainProject): string[] {
  const ids = new Set<string>();
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      for (const f of e.anchor.snapshot.features) ids.add(f.id);
    }
  }
  return [...ids];
}

/**
 * Does `featureId` exist (resolve to a present anchor that still contains it) at
 * `year` anywhere in the project? Backed by the REAL U09 `resolveAt` — the same
 * existence logic the production selection re-resolution is wired to.
 */
function featureExistsAtYear(
  project: DomainProject,
  featureId: string,
  year: number,
): boolean {
  for (const h of project.histories) {
    const res = resolveAt(h.series, timePointYear(year), CAL);
    if (res.kind !== 'present') continue;
    if (res.entry.anchor.snapshot.features.some((f) => f.id === featureId)) return true;
  }
  return false;
}

/** An ExistenceAtTime backed by the project at a probe year (vertex existence
 * folds onto feature existence — a vertex exists iff its owner feature does at
 * the probe time, which is all the active-feature invariant needs). */
function existenceFor(project: DomainProject, year: number): ExistenceAtTime<number> {
  return {
    featureExistsAt: (fid) => featureExistsAtYear(project, fid, year),
    vertexExistsAt: (fid) => featureExistsAtYear(project, fid, year),
  };
}

describe('save-load-roundtrip-identity — selection always valid (via U22 revalidate)', () => {
  it('a tracked selection is never left dangling after a random edit sequence', () => {
    fc.assert(
      fc.property(
        richProjectArb(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: -200, max: 200 }),
        (initial, cmds, probeYear) => {
          let project = initial;
          // Seed a selection on a feature that exists at probeYear if one does,
          // else on an arbitrary feature id (the dangling case we then exercise).
          const ids = allFeatureIds(project);
          const seedId =
            ids.find((id) => featureExistsAtYear(project, id, probeYear)) ?? ids[0];
          let selection =
            seedId === undefined
              ? EMPTY_SELECTION
              : withActiveFeature(EMPTY_SELECTION, asFeatureId(seedId));

          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            // Re-validate the selection against the (edited) project at probeYear.
            selection = revalidateForTime(selection, probeYear, existenceFor(project, probeYear));
            // INVARIANT: the active feature is either dropped (null) or genuinely
            // resolves to a present anchor at probeYear. Never a dangling ref.
            if (selection.activeFeature !== null) {
              if (!featureExistsAtYear(project, selection.activeFeature, probeYear)) {
                throw new Error(
                  `selection points at non-existent feature ${selection.activeFeature} ` +
                    `at year ${probeYear} after cmd ${JSON.stringify(cmd)}`,
                );
              }
            }
            // And the underlying project is still a clean, save-loadable state.
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(`invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)}`);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });
});
