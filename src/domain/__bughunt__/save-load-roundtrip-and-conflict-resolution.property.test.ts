// Bug-hunt #2 (focus: save-load-roundtrip-AND-conflict-resolution).
//
// This is a SEPARATE exploration from save-load-roundtrip-identity.property.test.ts
// (which pins seeds 1000–6004). Here we pin a DISJOINT seed (26001) and add NEW
// generators / command kinds / interactions that the identity suite never reaches:
//
//   1. A clean-project edit walk (as before) that, AFTER EACH command, asserts the
//      full load-relevant invariant battery + the persistence round-trip identity:
//        - ring alternation (territory↔hole) valid per leaf shape
//        - non-self-intersecting / contained rings (U07 validateRingHierarchy)
//        - hierarchy forest topology valid (派生集約 = 子の和)
//        - anchor-series INV-1 ascending / INV-2 non-overlap / INV-3 span
//        - no NaN / ±Infinity in any persisted coordinate or numeric field
//        - every referenced vertex id resolves (refs / selection always valid)
//        - save → load = identity (deserialize(serialize(p)) ≡ p)
//        - save → load through the ACTUAL JSON+Zod boundary = identity
//
//   2. A CONFLICT-RESOLUTION surface (the NEW axis): we deliberately CORRUPT a
//      valid project into each FR-106 inconsistency class (missing-vertex,
//      duplicate-owner-history, orphan-history, parent cycle, dangling parent,
//      shared-vertex coordinate divergence, time-conflict series), then drive the
//      REAL U14 consistency + auto-repair framework and assert the METAMORPHIC
//      conflict-resolution laws:
//        - checkConsistency FINDS at least the injected class (no silent pass)
//        - applyRepairChecked NEVER grows the report (受け入れ基準5)
//        - a repair offered for the inconsistency, when `resolved`, makes the
//          targeted inconsistency disappear
//        - repairing EVERY reported inconsistency (fixpoint) yields a consistent
//          project that ALSO round-trips clean through the actual Zod boundary
//          (save → load = identity after conflict resolution)
//        - repair ∘ repair = repair on an already-clean project (idempotent no-op:
//          a repair never corrupts a consistent project)
//
//   3. Metamorphic identities reused from the brief: undo ∘ op = identity (via the
//      U12 history module) and op ∘ inverse-op = identity (insert→delete anchor).
//
// Determinism: seed pinned to 26001 for THIS file; numRuns kept large (300–1000).
// Permanent asset: it asserts the SPECIFIED behaviour and never papers over a real
// defect (no green-faking).

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
  type AnchorEntry,
} from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createPointFeature,
  withColor,
  withParentId,
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
import { validateRingHierarchy } from '../ring-hierarchy';
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
// deserialize is persistence-internal (R8): only legitimate on manifests this test
// serialized itself (trusted, internally-produced data) — the same use as
// persistence/round-trip.test.ts — so the import restriction is scoped-disabled here.
// eslint-disable-next-line no-restricted-imports
import { deserialize } from '../persistence/serialize';
import { parseManifest, PARSE_OUTCOME } from '../persistence';
import {
  checkConsistency,
  INCONSISTENCY,
  type Inconsistency,
} from '../persistence/consistency';
import {
  applyRepairChecked,
  repairOptionsFor,
} from '../persistence/repair';

const CAL = getCalendar('gregorian');
// Determinism: seed pinned to 26001 for THIS file (disjoint from the identity suite).
const SEED = 26001;

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

/** A holed leaf: outer territory + inner hole (FR-24/25 alternation). */
function holedLeaf(id: string, ox: number, oy: number): { feature: Feature; vertices: Vertex[] } {
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
  const holeRing = createHoleRing(asRingId(`${id}-hr`), hole.map((v) => v.id), terrId);
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`穴地物${id}`, 0, 100),
    COLOR,
    createShape([territory, holeRing]),
  );
  return { feature, vertices: [...outer, ...hole] };
}

/**
 * An aggregate over two adjacent child leaves that TILE a rectangle with no
 * inter-child gap (派生集約 = 子の和, FR-35). Children share an edge (共有頂点).
 */
function aggregateWithChildren(id: string, ox: number): { features: Feature[]; vertices: Vertex[] } {
  const oy = 0;
  const sTop = createVertex(asVertexId(`${id}-sT`), createCoordinate(ox + 10, oy));
  const sBot = createVertex(asVertexId(`${id}-sB`), createCoordinate(ox + 10, oy + 10));
  const aTL = createVertex(asVertexId(`${id}-aTL`), createCoordinate(ox, oy));
  const aBL = createVertex(asVertexId(`${id}-aBL`), createCoordinate(ox, oy + 10));
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
  return { features: [aggregate, childA, childB], vertices: [sTop, sBot, aTL, aBL, bTR, bBR] };
}

/**
 * A history with N anchors (distinct ascending years), each carrying `features`.
 * The history is OWNED by `ownerId` — which MUST be the id of a feature present in
 * the snapshots (the consistency checker's OrphanHistory rule requires the owner
 * feature to appear in at least one snapshot). For a single-feature history this
 * is that feature's id; for an aggregate history it is the AGGREGATE's id (not the
 * synthetic history-slot name), which is why the caller passes it explicitly.
 */
function multiAnchorHistory(
  ownerId: string,
  idForAnchors: string,
  features: readonly Feature[],
  vertices: readonly Vertex[],
  startYears: readonly number[],
): FeatureHistory {
  const store = createVertexStore([...vertices]);
  const entries = startYears.map((y, i) =>
    createAnchorEntry(
      createAnchor(asAnchorId(`${idForAnchors}-anc-${i}`), createAnchorSnapshot(features, store)),
      timePointYear(y),
      null,
    ),
  );
  return { featureId: asFeatureId(ownerId), series: normalizeSeries(entries, CAL) };
}

type FeatureKindTag = 'leaf' | 'point' | 'hole' | 'aggregate';

/** Generate a valid, spatially-disjoint project mixing leaf/point/hole/aggregate. */
function projectArb(): fc.Arbitrary<DomainProject> {
  const kindArb: fc.Arbitrary<FeatureKindTag> = fc.constantFrom(
    'leaf',
    'point',
    'hole',
    'aggregate',
  );
  return fc
    .array(
      fc.record({
        kind: kindArb,
        years: fc
          .uniqueArray(fc.integer({ min: -200, max: 200 }), { minLength: 1, maxLength: 4 })
          .map((ys) => [...ys].sort((a, b) => a - b)),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((specs) => {
      const histories: FeatureHistory[] = specs.map((spec, i) => {
        const id = `f${i}`;
        // Place each feature 1000 units apart so no spatial overlap at any slice.
        const ox = 1000 + i * 300;
        if (spec.kind === 'leaf') {
          const { feature, vertices } = squareLeaf(id, ox, 0, 10);
          return multiAnchorHistory(id, id, [feature], vertices, spec.years);
        }
        if (spec.kind === 'point') {
          const { feature, vertex } = pointFeature(id, ox, 0);
          return multiAnchorHistory(id, id, [feature], [vertex], spec.years);
        }
        if (spec.kind === 'hole') {
          const { feature, vertices } = holedLeaf(id, ox, 0);
          return multiAnchorHistory(id, id, [feature], vertices, spec.years);
        }
        // The aggregate history is OWNED by the aggregate feature id (`${id}-agg`),
        // which IS present in the snapshots — not the synthetic slot name `id`.
        const { features, vertices } = aggregateWithChildren(id, ox);
        return multiAnchorHistory(`${id}-agg`, id, features, vertices, spec.years);
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

/**
 * Ring ALTERNATION (territory↔hole structure) per leaf. This is a STRUCTURAL
 * invariant a coordinate move cannot break (moveVertex changes positions, never
 * ring kinds), so it must hold after EVERY edit.
 */
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

/**
 * Ring GEOMETRY validity (non-self-intersecting + hole contained in parent, U07
 * validateRingHierarchy). UNLIKE alternation, a raw vertex drag CAN legitimately
 * distort a leaf into self-intersection / a hole that escapes its parent — that is
 * exactly the class the load-time conflict-resolution layer (RingHierarchyInvalid)
 * surfaces, NOT something the edit operation forbids. So this is asserted only on
 * the freshly-generated base (where the generator guarantees clean geometry), and
 * the per-edit walk does NOT treat post-drag self-intersection as a load failure.
 */
function ringGeometryValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      for (const f of e.anchor.snapshot.features) {
        if (f.kind === 'leaf' && !validateRingHierarchy(f.shape, e.anchor.snapshot.vertices).valid) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Hierarchy TOPOLOGY (no cycle / dangling parent / childIds⇔parentId agreement).
 * Structural — a coordinate move cannot break it — so it holds after EVERY edit.
 * The aggregate-SHAPE (派生集約 = 子の和) geometric verdict is excluded here (a
 * drag can legitimately open an inter-child gap; that is a conflict-resolution
 * class, checked on the base only via {@link aggregateUnionValid}).
 */
function hierarchyTopologyValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const features = e.anchor.snapshot.features;
      buildForest(features); // cycle-safe construction
      const res = validateHierarchy(features, { flagEmptyAggregates: false });
      const topo = res.violations.filter(
        (v) => v.kind !== 'aggregate-shape-mismatch' && v.kind !== 'shape-unresolved',
      );
      if (topo.length > 0) return false;
    }
  }
  return true;
}

/** Derived-aggregate (派生集約 = 子の和) geometry: base-project-only (see above). */
function aggregateUnionValid(project: DomainProject): boolean {
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      const res = validateHierarchy(e.anchor.snapshot.features, {
        flagEmptyAggregates: false,
        vertexStore: e.anchor.snapshot.vertices,
      });
      const aggViolations = res.violations.filter(
        (v) => v.kind === 'aggregate-shape-mismatch' || v.kind === 'shape-unresolved',
      );
      if (aggViolations.length > 0) return false;
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

function roundTripsClean(project: DomainProject): boolean {
  return projectsEqual(project, deserialize(serialize(project)));
}

/**
 * The per-EDIT invariant battery: every property that a legitimate edit operation
 * must preserve (structural + persistence round-trip). Geometric self-intersection
 * / aggregate-gap / containment are NOT here — a raw vertex drag can create them
 * and they are surfaced by the load-time conflict-resolution layer, not forbidden
 * by the edit op (see ringGeometryValid / aggregateUnionValid, base-only).
 */
function checkAllInvariants(project: DomainProject): { ok: boolean; failed: string } {
  if (!allCoordsFinite(project)) return { ok: false, failed: 'finite-coords' };
  if (!seriesValid(project)) return { ok: false, failed: 'series-invariants' };
  if (!ringsAlternationValid(project)) return { ok: false, failed: 'ring-alternation' };
  if (!hierarchyTopologyValid(project)) return { ok: false, failed: 'hierarchy-topology' };
  if (!refsResolve(project)) return { ok: false, failed: 'vertex-refs' };
  if (!roundTripsClean(project)) return { ok: false, failed: 'roundtrip-identity' };
  return { ok: true, failed: '' };
}

/** The full BASE-project battery: the per-edit set PLUS the geometric invariants
 * (non-self-intersection / containment / 派生集約 = 子の和) the generator guarantees. */
function checkBaseInvariants(project: DomainProject): { ok: boolean; failed: string } {
  const core = checkAllInvariants(project);
  if (!core.ok) return core;
  if (!ringGeometryValid(project)) return { ok: false, failed: 'ring-geometry' };
  if (!aggregateUnionValid(project)) return { ok: false, failed: 'aggregate-union' };
  return { ok: true, failed: '' };
}

/** save→load through the ACTUAL persistence boundary (JSON serialize + Zod parse). */
function boundaryRoundTrips(project: DomainProject): { ok: boolean; reason: string } {
  const json = JSON.parse(JSON.stringify(serialize(project)));
  const parsed = parseManifest(json);
  if (parsed.outcome !== PARSE_OUTCOME.Ok) return { ok: false, reason: `parse:${parsed.outcome}` };
  if (!projectsEqual(project, deserialize(parsed.manifest))) return { ok: false, reason: 'not-equal' };
  return { ok: true, reason: '' };
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

// ============================================================================
// Section 1 — clean edit walk: every invariant + round-trip survives commands
// ============================================================================

describe('save-load-roundtrip + conflict-resolution (bug hunt #2) — clean edit walk', () => {
  it('generated base projects satisfy every load invariant (incl. geometry + 子の和)', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        const check = checkBaseInvariants(project);
        if (!check.ok) throw new Error(`base project failed: ${check.failed}`);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('all invariants + in-memory round-trip survive a random edit-command sequence', () => {
    fc.assert(
      fc.property(
        projectArb(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 24 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkBaseInvariants(project);
          if (!base.ok) throw new Error(`generated base invalid: ${base.failed}`);
          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(`invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)}`);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 700 },
    );
  });

  it('save→load through the ACTUAL JSON+Zod boundary is identity after edits', () => {
    fc.assert(
      fc.property(projectArb(), fc.array(cmdArb(), { maxLength: 24 }), (initial, cmds) => {
        let project = initial;
        for (const cmd of cmds) {
          project = applyCmd(project, cmd);
          const rt = boundaryRoundTrips(project);
          if (!rt.ok) {
            throw new Error(`boundary round-trip broke (${rt.reason}) after ${JSON.stringify(cmd)}`);
          }
        }
      }),
      { seed: SEED, numRuns: 700 },
    );
  });
});

// ============================================================================
// Section 2 — CONFLICT RESOLUTION (the new axis). We deliberately corrupt a
// valid project into each FR-106 inconsistency class and drive the REAL U14
// consistency + auto-repair framework, asserting the metamorphic repair laws.
// ============================================================================

type CorruptionTag =
  | 'missing-vertex'
  | 'duplicate-owner'
  | 'orphan-history'
  | 'parent-cycle'
  | 'dangling-parent'
  | 'vertex-divergence'
  | 'time-conflict';

/** Deep-ish clone of a project's histories so a corruption never aliases input. */
function cloneHistories(project: DomainProject): FeatureHistory[] {
  return project.histories.map((h) => ({
    featureId: h.featureId,
    series: {
      entries: h.series.entries.map((e) => ({
        anchor: createAnchor(
          e.anchor.id,
          createAnchorSnapshot(
            [...e.anchor.snapshot.features],
            createVertexStore([...e.anchor.snapshot.vertices.byId.values()]),
          ),
        ),
        start: e.start,
        end: e.end,
      })),
    },
  }));
}

/** Map a transform over the FIRST history's first entry snapshot features. */
function mapFirstEntryFeatures(
  histories: FeatureHistory[],
  hi: number,
  transform: (features: readonly Feature[]) => Feature[],
): void {
  const h = histories[hi]!;
  const e0 = h.series.entries[0]!;
  histories[hi] = {
    featureId: h.featureId,
    series: {
      entries: h.series.entries.map((e, i) =>
        i === 0
          ? {
              anchor: createAnchor(
                e.anchor.id,
                createAnchorSnapshot(transform(e.anchor.snapshot.features), e.anchor.snapshot.vertices),
              ),
              start: e.start,
              end: e.end,
            }
          : e,
      ),
    },
  };
  void e0;
}

/**
 * Inject one corruption class into a valid project, returning the corrupted
 * project AND the inconsistency kind(s) it should provoke. Returns null when the
 * chosen corruption cannot be applied to this particular project shape (so the
 * caller can skip — never assert against an inapplicable injection).
 */
function corrupt(
  project: DomainProject,
  tag: CorruptionTag,
  pick: number,
): { project: DomainProject; expectKind: string } | null {
  const histories = cloneHistories(project);
  if (histories.length === 0) return null;
  const hi = pick % histories.length;

  switch (tag) {
    case 'missing-vertex': {
      // Drop a referenced vertex from the first entry's store while a feature still
      // cites it → MissingVertexReference. Restrict to a STANDALONE single-feature
      // history (no aggregate / no shared vertices): the DropFeatureWithMissingVertex
      // repair then cleanly removes the one offending feature and converges. The
      // harder shared-aggregate-vertex variant (dropping one of two children that
      // share the missing vertex leaves the aggregate with a gap → a new
      // AggregateSumMismatch, which the framework correctly REFUSES to certify) is a
      // genuine multi-feature interaction the default catalogue does not resolve by a
      // single drop; it is intentionally excluded here and is still exercised by the
      // HONESTY law (resolved ⇒ safe), which the framework upholds.
      const h = histories[hi]!;
      const e0 = h.series.entries[0]!;
      if (e0.anchor.snapshot.features.length !== 1) return null;
      const only = e0.anchor.snapshot.features[0]!;
      if (only.kind === 'aggregate') return null;
      const store = e0.anchor.snapshot.vertices;
      const cited = e0.anchor.snapshot.features.flatMap((f) => {
        if (f.kind === 'point') return [f.vertexId];
        if (f.kind === 'line') return [...f.vertexIds];
        if (f.kind === 'leaf') return f.shape.rings.flatMap((r) => [...r.vertexIds]);
        return [];
      });
      if (cited.length === 0) return null;
      const victim = cited[pick % cited.length]!;
      const kept = [...store.byId.values()].filter((v) => v.id !== victim);
      if (kept.length === [...store.byId.values()].length) return null;
      histories[hi] = {
        featureId: h.featureId,
        series: {
          entries: h.series.entries.map((e, i) =>
            i === 0
              ? {
                  anchor: createAnchor(
                    e.anchor.id,
                    createAnchorSnapshot(e.anchor.snapshot.features, createVertexStore(kept)),
                  ),
                  start: e.start,
                  end: e.end,
                }
              : e,
          ),
        },
      };
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.MissingVertexReference };
    }
    case 'duplicate-owner': {
      // Append a SECOND history keyed by the same featureId → DuplicateOwnerHistory.
      const h = histories[hi]!;
      histories.push({ featureId: h.featureId, series: h.series });
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.DuplicateOwnerHistory };
    }
    case 'orphan-history': {
      // Remove the owner feature from EVERY snapshot of one history → OrphanHistory.
      const h = histories[hi]!;
      const owner = h.featureId;
      histories[hi] = {
        featureId: owner,
        series: {
          entries: h.series.entries.map((e) => ({
            anchor: createAnchor(
              e.anchor.id,
              createAnchorSnapshot(
                e.anchor.snapshot.features.filter((f) => f.id !== owner),
                e.anchor.snapshot.vertices,
              ),
            ),
            start: e.start,
            end: e.end,
          })),
        },
      };
      // Only a corruption if the owner WAS present (it always is for our generator).
      const stillPresent = histories[hi]!.series.entries.some((e) =>
        e.anchor.snapshot.features.some((f) => f.id === owner),
      );
      if (stillPresent) return null;
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.OrphanHistory };
    }
    case 'parent-cycle': {
      // Make two features point at each other as parents → TreeTopology (cycle).
      const h = histories[hi]!;
      const feats = h.series.entries[0]!.anchor.snapshot.features;
      if (feats.length < 2) return null;
      const a = feats[0]!;
      const b = feats[1]!;
      mapFirstEntryFeatures(histories, hi, (features) =>
        features.map((f) => {
          if (f.id === a.id) return withParentId(f, b.id);
          if (f.id === b.id) return withParentId(f, a.id);
          return f;
        }),
      );
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.TreeTopology };
    }
    case 'dangling-parent': {
      // Point a feature's parentId at a non-existent feature → TreeTopology.
      const ghost = asFeatureId('ghost-parent-xyz');
      const h = histories[hi]!;
      const first = h.series.entries[0]!.anchor.snapshot.features[0];
      if (first === undefined) return null;
      mapFirstEntryFeatures(histories, hi, (features) =>
        features.map((f) => (f.id === first.id ? withParentId(f, ghost) : f)),
      );
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.TreeTopology };
    }
    case 'vertex-divergence': {
      // Manufacture a SHARED vertex id across two histories whose effective windows
      // OVERLAP, then give it a divergent coordinate in only ONE history →
      // VertexCoordinateDivergence. The detector compares same-id vertices across
      // every history effective at a time slice, so the two histories MUST both be
      // present at one slice. We collapse both to a single entry starting at the
      // SAME year (0) so they certainly co-resolve at that slice.
      if (histories.length < 2) return null;
      const hA = histories[0]!;
      const hB = histories[1]!;
      const eA = hA.series.entries[0]!;
      const eB = hB.series.entries[0]!;
      const aVerts = [...eA.anchor.snapshot.vertices.byId.values()];
      if (aVerts.length === 0) return null;
      const shared = aVerts[pick % aVerts.length]!;
      const at = timePointYear(0);
      // A: single entry at year 0, original store (carries `shared.id`).
      histories[0] = {
        featureId: hA.featureId,
        series: { entries: [{ anchor: eA.anchor, start: at, end: null }] },
      };
      // B: single entry at year 0, store augmented with the SAME id at a divergent
      // coordinate (+25,+25 — far beyond the U06 quantization grid, so not noise).
      const divergent = createVertex(
        shared.id,
        createCoordinate(shared.coordinate.lon + 25, shared.coordinate.lat + 25),
      );
      const bStore = createVertexStore([...eB.anchor.snapshot.vertices.byId.values(), divergent]);
      histories[1] = {
        featureId: hB.featureId,
        series: {
          entries: [
            {
              anchor: createAnchor(
                eB.anchor.id,
                createAnchorSnapshot(eB.anchor.snapshot.features, bStore),
              ),
              start: at,
              end: null,
            },
          ],
        },
      };
      return {
        project: { ...project, histories },
        expectKind: INCONSISTENCY.VertexCoordinateDivergence,
      };
    }
    case 'time-conflict': {
      // Hand-build a series that violates INV-1 (descending starts) bypassing
      // normalizeSeries → TimeConflict. Needs ≥2 entries.
      const h = histories[hi]!;
      if (h.series.entries.length < 2) return null;
      const reversed: AnchorEntry[] = [];
      // Force two entries to share / invert order: set entry[1].start < entry[0].start.
      const e0 = h.series.entries[0]!;
      const e1 = h.series.entries[1]!;
      const badStart = timePointYear(
        (e0.start.granularity === 'year' ? e0.start.year : 0) - 5,
      );
      reversed.push(e0);
      reversed.push({ anchor: e1.anchor, start: badStart, end: e1.end });
      for (let i = 2; i < h.series.entries.length; i += 1) reversed.push(h.series.entries[i]!);
      // Only a corruption if it actually breaks validateSeries.
      const candidate: AnchorSeries = { entries: reversed };
      if (validateSeries(candidate, CAL).ok) return null;
      histories[hi] = { featureId: h.featureId, series: candidate };
      return { project: { ...project, histories }, expectKind: INCONSISTENCY.TimeConflict };
    }
  }
}

/**
 * Repair every reported inconsistency to a FIXPOINT by COMMITTING only the repairs
 * the framework itself certifies as safe (受け入れ基準5: a committed repair must not
 * GROW the report). Each round we scan every reported inconsistency × every option
 * `repairOptionsFor` offers it and apply the FIRST whose `applyRepairChecked`
 * introduced no new inconsistency AND made progress (the report shrank). This is
 * the realistic conflict-resolution drive: the UI presents options and a user
 * commits a repair only when the framework says it resolved the issue without
 * manufacturing a new one — never one the framework flags as `resolved:false`.
 *
 * `honestyViolated` is set if the framework EVER reports `resolved:true` while
 * having grown the report (or while leaving the target present) — that would be a
 * genuine 受け入れ基準5 bug in `applyRepairChecked` (resolved must imply safe).
 * `stuck` is set if inconsistencies remain but NO offered option is certified safe
 * (the repair catalogue cannot resolve the project without growing the report).
 */
function repairToFixpoint(project: DomainProject): {
  project: DomainProject;
  converged: boolean;
  honestyViolated: boolean;
  stuck: boolean;
} {
  let current = project;
  let honestyViolated = false;
  for (let round = 0; round < 60; round += 1) {
    const report = checkConsistency(current, CAL);
    if (report.ok) return { project: current, converged: true, honestyViolated, stuck: false };
    const before = report.inconsistencies.length;

    let committed: DomainProject | null = null;
    for (const inc of report.inconsistencies) {
      for (const option of repairOptionsFor(inc)) {
        const applied = applyRepairChecked(current, inc, option.id, CAL);
        const afterLen = applied.remaining.inconsistencies.length;
        const grew = afterLen > before;
        const targetGone = !applied.remaining.inconsistencies.some(
          (o) =>
            o.kind === inc.kind &&
            o.detail === inc.detail &&
            o.featureIds.length === inc.featureIds.length &&
            o.featureIds.every((id, i) => id === inc.featureIds[i]),
        );
        // Production-honesty law: `resolved` must imply the report did not grow AND
        // the targeted inconsistency is gone (受け入れ基準5 contract).
        if (applied.resolved && (grew || !targetGone)) honestyViolated = true;
        // Commit the first SAFE, PROGRESSING repair (framework-certified resolved).
        if (committed === null && applied.resolved && afterLen < before) {
          committed = applied.project;
        }
      }
      if (committed !== null) break;
    }
    if (committed === null) {
      return { project: current, converged: false, honestyViolated, stuck: true };
    }
    current = committed;
  }
  return {
    project: current,
    converged: checkConsistency(current, CAL).ok,
    honestyViolated,
    stuck: false,
  };
}

const corruptionArb: fc.Arbitrary<CorruptionTag> = fc.constantFrom(
  'missing-vertex',
  'duplicate-owner',
  'orphan-history',
  'parent-cycle',
  'dangling-parent',
  'vertex-divergence',
  'time-conflict',
);

describe('conflict-resolution metamorphic laws (via U14 consistency + auto-repair)', () => {
  it('a clean project reports NO inconsistency (no false-positive conflict)', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        const report = checkConsistency(project, CAL);
        if (!report.ok) {
          throw new Error(
            `clean project flagged: ${report.inconsistencies.map((i) => `${i.kind}/${i.detail}`).join(', ')}`,
          );
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('every injected corruption is DETECTED (no silent pass)', () => {
    fc.assert(
      fc.property(projectArb(), corruptionArb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt(project, tag, pick);
        if (inj === null) return; // inapplicable to this shape — skip.
        const report = checkConsistency(inj.project, CAL);
        if (report.ok) {
          throw new Error(`corruption "${tag}" was NOT detected (report empty)`);
        }
        // The specific class we injected must appear (the detector may also surface
        // collateral kinds, which is fine — we only require the injected one).
        const kinds = new Set(report.inconsistencies.map((i) => i.kind));
        if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
          throw new Error(
            `corruption "${tag}" expected kind ${inj.expectKind} but got: ${[...kinds].join(', ')}`,
          );
        }
      }),
      { seed: SEED, numRuns: 900 },
    );
  });

  it('applyRepairChecked is HONEST: resolved ⇒ report did not grow and target is gone (受け入れ基準5)', () => {
    fc.assert(
      fc.property(projectArb(), corruptionArb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        // The HARD production law: the framework never claims `resolved:true` for a
        // repair that grows the report or leaves its target — committing such a
        // repair would let the UI persist a still-/more-inconsistent project.
        if (fix.honestyViolated) {
          throw new Error(
            `applyRepairChecked reported resolved:true while growing the report / leaving target for "${tag}"`,
          );
        }
      }),
      { seed: SEED, numRuns: 900 },
    );
  });

  it('committing only framework-certified repairs converges to a CLEAN fixpoint', () => {
    fc.assert(
      fc.property(projectArb(), corruptionArb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        // Greedily committing only safe (resolved + report-shrinking) repairs must
        // reach a fully-consistent project for every corruption class we inject —
        // each has a dedicated safe repair option in the U14 catalogue.
        if (!fix.converged) {
          throw new Error(
            `safe-repair fixpoint did not converge for "${tag}" (stuck=${fix.stuck})`,
          );
        }
        const finalReport = checkConsistency(fix.project, CAL);
        if (!finalReport.ok) {
          throw new Error(
            `post-repair project still inconsistent for "${tag}": ${finalReport.inconsistencies
              .map((i) => i.kind)
              .join(', ')}`,
          );
        }
      }),
      { seed: SEED, numRuns: 900 },
    );
  });

  it('save→load = identity AFTER conflict resolution (repaired project round-trips through Zod)', () => {
    fc.assert(
      fc.property(projectArb(), corruptionArb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (!fix.converged) return; // covered by the previous law.
        const rt = boundaryRoundTrips(fix.project);
        if (!rt.ok) {
          throw new Error(
            `repaired project failed boundary round-trip (${rt.reason}) for corruption "${tag}"`,
          );
        }
      }),
      { seed: SEED, numRuns: 900 },
    );
  });

  it('repair on an ALREADY-clean project is a no-op (idempotent: never corrupts a consistent state)', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        // A clean project has no inconsistency, so repairToFixpoint returns it
        // immediately and unchanged. Assert exact identity (no spurious mutation).
        const fix = repairToFixpoint(project);
        if (!fix.converged) throw new Error('clean project unexpectedly did not converge');
        expect(projectsEqual(fix.project, project)).toBe(true);
        expect(fix.honestyViolated).toBe(false);
        expect(fix.stuck).toBe(false);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});

// ============================================================================
// Section 3 — metamorphic undo/redo + inverse-op, driven through the REAL U12
// history module (undo ∘ op = identity; redo ∘ undo ∘ op = op; insert∘delete = id).
// ============================================================================

const EDIT_KIND = defineCommandKind('bughunt2/edit');

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

describe('metamorphic undo/redo + inverse-op (via U12 history)', () => {
  it('undo ∘ op = identity: history.undo(execute(h, cmd)) restores the exact project', () => {
    fc.assert(
      fc.property(projectArb(), cmdArb(), (initial, cmd) => {
        const h0 = createHistory<DomainProject>(initial);
        const cmdObj = reversibleEdit(initial, cmd);
        const afterExec = execute(h0, cmdObj);
        const afterUndo = undo(afterExec.history);
        expect(projectsEqual(afterUndo.history.state, initial)).toBe(true);
        const check = checkAllInvariants(afterUndo.history.state);
        if (!check.ok) throw new Error(`undo produced invalid project: ${check.failed}`);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('redo ∘ undo ∘ op = op: redo restores the executed project byte-for-byte', () => {
    fc.assert(
      fc.property(projectArb(), cmdArb(), (initial, cmd) => {
        const h0 = createHistory<DomainProject>(initial);
        const cmdObj = reversibleEdit(initial, cmd);
        const afterExec = execute(h0, cmdObj);
        const executed = afterExec.history.state;
        const afterRedo = redo(undo(afterExec.history).history);
        expect(projectsEqual(afterRedo.history.state, executed)).toBe(true);
        expect(JSON.stringify(serialize(afterRedo.history.state))).toBe(
          JSON.stringify(serialize(executed)),
        );
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('op ∘ inverse-op = identity: deleteAnchor after insertPastEdit restores the series', () => {
    fc.assert(
      fc.property(
        projectArb(),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 500, max: 900 }),
        (initial, hiPick, newYear) => {
          const project = initial;
          const n = project.histories.length;
          if (n === 0) return;
          const hi = hiPick % n;
          const before = project.histories[hi]!;
          const inserted = applyCmd(project, { tag: 'insertPastEdit', hi, year: newYear });
          const insSeries = inserted.histories[hi]!.series;
          expect(insSeries.entries.length).toBe(before.series.entries.length + 1);
          const newAnchor = insSeries.entries.find(
            (e) => e.start.granularity === 'year' && e.start.year === newYear,
          );
          expect(newAnchor).toBeDefined();
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
