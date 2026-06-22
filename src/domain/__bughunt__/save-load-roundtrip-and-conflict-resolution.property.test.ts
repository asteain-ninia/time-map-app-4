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
// Determinism: seeds pinned to 26001/26002/26003/26004 for THIS file; numRuns kept
// large (300–1000). Permanent asset: it asserts the SPECIFIED behaviour and never
// papers over a real defect (no green-faking). Section 6 (seed 26004) adds a DISJOINT
// fourth exploration with command kinds / interactions the earlier sections never
// reach: (1) corrupting a project that has ALREADY undergone a random edit walk
// (earlier corruptions only hit the pristine generator output); (2) repair-fixpoint
// IDEMPOTENCE on a CORRUPTED project (repair∘repair = repair — re-running the drive
// on the already-repaired state must be an exact no-op); (3) double save→load
// stability (load∘save∘load∘save = load∘save) + serialize CANONICALITY (two
// independent serializations are byte-identical); (4) a mixed Edit+Struct command
// interleaving asserting the anchor-series ordering / round-trip after each step.

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
  createLineFeature,
  createPointFeature,
  withAggregateChildIds,
  withColor,
  withParentId,
  type AggregateFeature,
  type Feature,
  type LeafFeature,
  type LineFeature,
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
  RING_KIND,
  withHoleRingParent,
  type Ring,
} from '../ring';
import {
  addVertexToLeafRing,
  deleteLeafVertex,
  deleteLineVertex,
  commandResultFromEditResult,
  type FeatureEditResult,
} from '../editing/edit-ops';
import {
  EMPTY_SELECTION,
  withActiveFeature,
  withVertexSet,
  type SelectionState,
} from '../selection/state';
import { reresolveAfterStructureChange } from '../selection/reresolve';
import { validateRingHierarchy } from '../ring-hierarchy';
import { createHistory, execute, redo, undo } from '../command/history';
import { defineCommandKind, type Command } from '../command/command';
import { EMPTY_COMMAND_RESULT } from '../command/result';
import { getCalendar } from '../time/calendar';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimePoint,
} from '../time/time-point';
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

// ============================================================================
// Section 4 — NEW EXPLORATION (seed 26002, disjoint from SEED=26001 above and
// from the identity suite's 1000–6004). This section adds command kinds /
// generators / interactions the earlier sections never reach:
//
//   (a) STRUCTURAL edits via the REAL U24 edit-ops (addVertexToLeafRing,
//       deleteLeafVertex, deleteLineVertex) — these CHANGE the vertex/ring
//       topology (not just coordinates), then we assert the full per-edit
//       invariant battery + the in-memory AND JSON+Zod round-trip after each.
//       The earlier walk only moved/recoloured/retimed; it never inserts or
//       removes a vertex, so the persistence layer was never exercised against a
//       changed ring/line cardinality + the U22 selection delta.
//
//   (b) SELECTION-VALIDITY law (選択が常に有効): after each structural edit we feed
//       the edit's CommandResult through the REAL U22
//       reresolveAfterStructureChange and assert the surviving selection refers
//       ONLY to ids that still exist in the post-edit snapshot (no dangling
//       active feature / vertex). This is the brief's "selection always valid"
//       invariant, exercised through the production re-resolution path.
//
//   (c) A NEW corruption class for the conflict-resolution surface:
//       RingHierarchyInvalid (a holed leaf whose hole's parentRingId is rewritten
//       to a non-existent territory ring — structurally representable, so the Zod
//       schema accepts it, but U07 validateRingHierarchy rejects it). We drive the
//       same metamorphic repair laws (detected / honest / converges / round-trips
//       after resolution) the earlier corruption catalogue uses.
// ============================================================================

const SEED2 = 26002;

/** A 3-point line feature + its vertices (for the deleteLineVertex structural edit). */
function lineFeature(id: string, ox: number, oy: number): { feature: Feature; vertices: Vertex[] } {
  const verts = [
    createVertex(asVertexId(`${id}-l0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${id}-l1`), createCoordinate(ox + 5, oy + 5)),
    createVertex(asVertexId(`${id}-l2`), createCoordinate(ox + 10, oy)),
  ];
  const feature = createLineFeature(
    asFeatureId(id),
    createBasicAttributes(`線${id}`, 0, 80),
    COLOR,
    verts.map((v) => v.id),
  );
  return { feature, vertices: verts };
}

type FeatureKindTag2 = 'leaf' | 'point' | 'hole' | 'line' | 'aggregate';

/** Like projectArb() but ALSO mints line features (so deleteLineVertex applies). */
function projectArb2(): fc.Arbitrary<DomainProject> {
  const kindArb: fc.Arbitrary<FeatureKindTag2> = fc.constantFrom(
    'leaf',
    'point',
    'hole',
    'line',
    'aggregate',
  );
  return fc
    .array(
      fc.record({
        kind: kindArb,
        years: fc
          .uniqueArray(fc.integer({ min: -200, max: 200 }), { minLength: 1, maxLength: 3 })
          .map((ys) => [...ys].sort((a, b) => a - b)),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((specs) => {
      const histories: FeatureHistory[] = specs.map((spec, i) => {
        const id = `g${i}`;
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
        if (spec.kind === 'line') {
          const { feature, vertices } = lineFeature(id, ox, 0);
          return multiAnchorHistory(id, id, [feature], vertices, spec.years);
        }
        const { features, vertices } = aggregateWithChildren(id, ox);
        return multiAnchorHistory(`${id}-agg`, id, features, vertices, spec.years);
      });
      return { histories, settings: SETTINGS, baseMap: BASEMAP };
    });
}

// --- structural-edit command surface (REAL U24 edit-ops) --------------------

type StructCmd =
  | { tag: 'addLeafVertex'; hi: number; pick: number }
  | { tag: 'delLeafVertex'; hi: number; pick: number }
  | { tag: 'delLineVertex'; hi: number; pick: number };

function structCmdArb(): fc.Arbitrary<StructCmd> {
  return fc.oneof(
    fc.record({ tag: fc.constant('addLeafVertex' as const), hi: fc.nat(), pick: fc.nat() }),
    fc.record({ tag: fc.constant('delLeafVertex' as const), hi: fc.nat(), pick: fc.nat() }),
    fc.record({ tag: fc.constant('delLineVertex' as const), hi: fc.nat(), pick: fc.nat() }),
  );
}

/**
 * Apply ONE structural edit-op to the FIRST anchor of the chosen history, threading
 * the new vertex (for an add) into that anchor's store and rebuilding the feature
 * from the op result. Returns the new project AND the edit-ops result (so the
 * caller can drive U22 selection re-resolution). Inapplicable picks no-op.
 */
function applyStructCmd(
  project: DomainProject,
  cmd: StructCmd,
): { project: DomainProject; result: FeatureEditResult | null } {
  const histories = [...project.histories];
  const n = histories.length;
  if (n === 0) return { project, result: null };
  const hi = cmd.hi % n;
  const history = histories[hi]!;
  const entries = history.series.entries;
  if (entries.length === 0) return { project, result: null };
  const e0 = entries[0]!;
  const features = e0.anchor.snapshot.features;
  const store = e0.anchor.snapshot.vertices;

  // Mirror U31 deletion: removing a feature also DROPS it from any aggregate's
  // childIds (an aggregate that still lists a now-deleted child would otherwise be a
  // hierarchy-topology inconsistency). This is the parent-reconciliation the
  // production deletion command performs; the naive snapshot filter alone left a
  // dangling childId (caught by the hierarchy-topology invariant — a genuine harness
  // modeling gap, not a domain defect, since the real delete path reconciles here).
  const removeFeature = (features0: readonly Feature[], removeId: string): Feature[] =>
    features0
      .filter((f) => f.id !== removeId)
      .map((f) =>
        f.kind === 'aggregate' && f.childIds.includes(removeId as AggregateFeature['childIds'][number])
          ? withAggregateChildIds(f, f.childIds.filter((c) => c !== removeId))
          : f,
      );

  const commit = (
    newFeatures: readonly Feature[],
    newStore = store,
  ): { project: DomainProject; result: FeatureEditResult | null } => {
    const newEntries = entries.map((e, i) =>
      i === 0
        ? {
            anchor: createAnchor(e.anchor.id, createAnchorSnapshot(newFeatures, newStore)),
            start: e.start,
            end: e.end,
          }
        : e,
    );
    histories[hi] = { featureId: history.featureId, series: { entries: newEntries } };
    return { project: { ...project, histories }, result: null };
  };

  switch (cmd.tag) {
    case 'addLeafVertex': {
      const leaves = features.filter((f): f is LeafFeature => f.kind === 'leaf');
      if (leaves.length === 0) return { project, result: null };
      const leaf = leaves[cmd.pick % leaves.length]!;
      const ring = leaf.shape.rings[cmd.pick % leaf.shape.rings.length]!;
      if (ring.vertexIds.length < 2) return { project, result: null };
      const si = cmd.pick % ring.vertexIds.length;
      const startV = ring.vertexIds[si]!;
      const endV = ring.vertexIds[(si + 1) % ring.vertexIds.length]!;
      const sCoord = getVertex(store, startV)!.coordinate;
      const eCoord = getVertex(store, endV)!.coordinate;
      const newId = asVertexId(`${leaf.id}-add-${ring.id}-${si}`);
      // Idempotency / id-collision guard: a re-add on the same edge would mint a
      // duplicate vertex id; skip if it already exists (the op would still splice,
      // creating a degenerate duplicate-id ring the store cannot represent).
      if (store.byId.has(newId)) return { project, result: null };
      const res = addVertexToLeafRing(leaf, ring.id, startV, endV, newId);
      if (res === undefined || res.kind !== 'feature') return { project, result: null };
      const mid = createVertex(
        newId,
        createCoordinate((sCoord.lon + eCoord.lon) / 2, (sCoord.lat + eCoord.lat) / 2),
      );
      const newStore = setVertex(store, mid);
      const newFeatures = features.map((f) => (f.id === leaf.id ? res.feature : f));
      const out = commit(newFeatures, newStore);
      return { project: out.project, result: res };
    }
    case 'delLeafVertex': {
      const leaves = features.filter((f): f is LeafFeature => f.kind === 'leaf');
      if (leaves.length === 0) return { project, result: null };
      const leaf = leaves[cmd.pick % leaves.length]!;
      const ring = leaf.shape.rings[cmd.pick % leaf.shape.rings.length]!;
      if (ring.vertexIds.length === 0) return { project, result: null };
      const victim = ring.vertexIds[cmd.pick % ring.vertexIds.length]!;
      const res = deleteLeafVertex(leaf, ring.id, victim);
      if (res === undefined) return { project, result: null };
      if (res.kind === 'delete-feature') {
        // The whole leaf was removed (last territory ring gone). Drop it from the
        // snapshot. If it owned this history → that history becomes orphan, which the
        // round-trip layer still represents faithfully; but to keep the per-edit
        // invariant battery (which forbids orphan-by-refs) honest, only remove the
        // feature when it is NOT this history's owner. Otherwise no-op (an owner
        // self-deletion is the deletion-flow's concern, not this round-trip walk).
        if (res.featureId === history.featureId) return { project, result: null };
        const out = commit(removeFeature(features, res.featureId));
        return { project: out.project, result: res };
      }
      // Survives: the affected ring may have lost vertices; drop any vertex that no
      // longer appears in the leaf's rings (keep the store ref-tight so refsResolve
      // and the round-trip stay valid).
      const newFeatures = features.map((f) => (f.id === leaf.id ? res.feature : f));
      const stillCited = new Set<string>();
      for (const f of newFeatures) {
        if (f.kind === 'leaf') for (const r of f.shape.rings) for (const v of r.vertexIds) stillCited.add(v);
        if (f.kind === 'line') for (const v of f.vertexIds) stillCited.add(v);
        if (f.kind === 'point') stillCited.add(f.vertexId);
      }
      const keptVerts = [...store.byId.values()].filter((v) => stillCited.has(v.id));
      const out = commit(newFeatures, createVertexStore(keptVerts));
      return { project: out.project, result: res };
    }
    case 'delLineVertex': {
      const lines = features.filter((f): f is LineFeature => f.kind === 'line');
      if (lines.length === 0) return { project, result: null };
      const line = lines[cmd.pick % lines.length]!;
      const victim = line.vertexIds[cmd.pick % line.vertexIds.length]!;
      const res = deleteLineVertex(line, victim);
      if (res === undefined) return { project, result: null };
      if (res.kind === 'delete-feature') {
        if (res.featureId === history.featureId) return { project, result: null };
        const out = commit(removeFeature(features, res.featureId));
        return { project: out.project, result: res };
      }
      const newFeatures = features.map((f) => (f.id === line.id ? res.feature : f));
      const stillCited = new Set<string>();
      for (const f of newFeatures) {
        if (f.kind === 'leaf') for (const r of f.shape.rings) for (const v of r.vertexIds) stillCited.add(v);
        if (f.kind === 'line') for (const v of f.vertexIds) stillCited.add(v);
        if (f.kind === 'point') stillCited.add(f.vertexId);
      }
      const keptVerts = [...store.byId.values()].filter((v) => stillCited.has(v.id));
      const out = commit(newFeatures, createVertexStore(keptVerts));
      return { project: out.project, result: res };
    }
  }
}

/**
 * SELECTION-VALIDITY (選択が常に有効). Build a selection that targets the edited
 * feature + a couple of its pre-edit vertices, run the REAL U22
 * reresolveAfterStructureChange with the edit's CommandResult, and assert the
 * surviving selection references ONLY ids that EXIST in the post-edit first
 * snapshot (no dangling active feature, no dangling selected vertex). A deleted
 * feature / removed vertex must have dropped out.
 */
function selectionStaysValid(
  before: DomainProject,
  after: DomainProject,
  hi: number,
  result: FeatureEditResult,
): boolean {
  const beforeFeatures = before.histories[hi]!.series.entries[0]!.anchor.snapshot.features;
  if (beforeFeatures.length === 0) return true;
  const target = beforeFeatures[0]!;
  // Pick up to 3 vertex ids the target referenced before the edit.
  const beforeStore = before.histories[hi]!.series.entries[0]!.anchor.snapshot.vertices;
  const targetVerts: string[] = [];
  if (target.kind === 'point') targetVerts.push(target.vertexId);
  if (target.kind === 'line') targetVerts.push(...target.vertexIds);
  if (target.kind === 'leaf') for (const r of target.shape.rings) targetVerts.push(...r.vertexIds);
  const pickVerts = new Set(
    targetVerts.slice(0, 3).map((v) => asVertexId(v)).filter((v) => beforeStore.byId.has(v)),
  );

  let sel: SelectionState = withActiveFeature(EMPTY_SELECTION, target.id);
  if (pickVerts.size > 0) sel = withVertexSet(sel, target.id, pickVerts);

  const cmdResult = commandResultFromEditResult(result);
  const next = reresolveAfterStructureChange(sel, cmdResult);

  const afterEntry = after.histories[hi]!.series.entries[0]!;
  const afterFeatureIds = new Set(afterEntry.anchor.snapshot.features.map((f) => f.id as string));
  const afterVertexIds = new Set([...afterEntry.anchor.snapshot.vertices.byId.keys()].map((v) => v as string));

  // Active feature, if retained, must still exist post-edit.
  if (next.activeFeature !== null && !afterFeatureIds.has(next.activeFeature as string)) return false;
  // Every retained selected vertex must still exist post-edit.
  for (const vid of next.vertexIds) {
    if (!afterVertexIds.has(vid as string)) return false;
  }
  // The owner, if any, must still exist.
  if (next.vertexOwner !== null && !afterFeatureIds.has(next.vertexOwner as string)) return false;
  return true;
}

describe('bug hunt #2 / NEW exploration (seed 26002) — structural edits + selection', () => {
  it('generated base (with line features) satisfies every load invariant', () => {
    fc.assert(
      fc.property(projectArb2(), (project) => {
        const check = checkBaseInvariants(project);
        if (!check.ok) throw new Error(`base project failed: ${check.failed}`);
      }),
      { seed: SEED2, numRuns: 400 },
    );
  });

  it('structural vertex add/delete preserves all invariants + in-memory round-trip', () => {
    fc.assert(
      fc.property(
        projectArb2(),
        fc.array(structCmdArb(), { minLength: 1, maxLength: 16 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkBaseInvariants(project);
          if (!base.ok) throw new Error(`generated base invalid: ${base.failed}`);
          for (const cmd of cmds) {
            const out = applyStructCmd(project, cmd);
            project = out.project;
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(
                `invariant "${check.failed}" broke after struct cmd ${JSON.stringify(cmd)}`,
              );
            }
          }
        },
      ),
      { seed: SEED2, numRuns: 700 },
    );
  });

  it('structural edits round-trip through the ACTUAL JSON+Zod boundary', () => {
    fc.assert(
      fc.property(projectArb2(), fc.array(structCmdArb(), { maxLength: 16 }), (initial, cmds) => {
        let project = initial;
        for (const cmd of cmds) {
          project = applyStructCmd(project, cmd).project;
          const rt = boundaryRoundTrips(project);
          if (!rt.ok) {
            throw new Error(
              `boundary round-trip broke (${rt.reason}) after struct cmd ${JSON.stringify(cmd)}`,
            );
          }
        }
      }),
      { seed: SEED2, numRuns: 700 },
    );
  });

  it('selection stays valid after each structural edit (選択が常に有効, via U22 re-resolution)', () => {
    fc.assert(
      fc.property(
        projectArb2(),
        fc.array(structCmdArb(), { minLength: 1, maxLength: 12 }),
        (initial, cmds) => {
          let project = initial;
          for (const cmd of cmds) {
            const hi = cmd.hi % project.histories.length;
            const before = project;
            const out = applyStructCmd(project, cmd);
            if (out.result !== null) {
              if (!selectionStaysValid(before, out.project, hi, out.result)) {
                throw new Error(
                  `selection re-resolution left a dangling id after ${JSON.stringify(cmd)}`,
                );
              }
            }
            project = out.project;
          }
        },
      ),
      { seed: SEED2, numRuns: 600 },
    );
  });
});

// --- NEW corruption class: RingHierarchyInvalid (dangling hole parent ring) --

/**
 * Corrupt a holed leaf so its hole's `parentRingId` points at a NON-EXISTENT
 * territory ring. The Zod schema accepts it (a hole still carries A parentRingId
 * string), but U07 validateRingHierarchy rejects it → RingHierarchyInvalid. Returns
 * null when no history carries a holed leaf as its sole feature.
 */
function corruptRingHierarchy(
  project: DomainProject,
): { project: DomainProject; expectKind: string } | null {
  const histories = cloneHistories(project);
  for (let hi = 0; hi < histories.length; hi += 1) {
    const h = histories[hi]!;
    const e0 = h.series.entries[0]!;
    const feats = e0.anchor.snapshot.features;
    if (feats.length !== 1) continue;
    const leaf = feats[0]!;
    if (leaf.kind !== 'leaf') continue;
    const hole = leaf.shape.rings.find((r) => r.kind === RING_KIND.Hole);
    if (hole === undefined || hole.kind !== RING_KIND.Hole) continue;
    const ghostRing = asRingId('ghost-territory-ring-zzz');
    const brokenHole = withHoleRingParent(hole, ghostRing);
    const newRings: Ring[] = leaf.shape.rings.map((r) => (r.id === hole.id ? brokenHole : r));
    const brokenLeaf: LeafFeature = { ...leaf, shape: createShape(newRings) };
    mapFirstEntryFeatures(histories, hi, (features) =>
      features.map((f) => (f.id === leaf.id ? brokenLeaf : f)),
    );
    // Confirm the corruption actually breaks U07 validation before asserting on it.
    const checkLeaf = histories[hi]!.series.entries[0]!.anchor.snapshot;
    if (validateRingHierarchy(brokenLeaf.shape, checkLeaf.vertices).valid) return null;
    return {
      project: { ...project, histories },
      expectKind: INCONSISTENCY.RingHierarchyInvalid,
    };
  }
  return null;
}

describe('bug hunt #2 / NEW conflict class (seed 26002) — RingHierarchyInvalid', () => {
  it('a dangling-hole-parent leaf is DETECTED as RingHierarchyInvalid', () => {
    fc.assert(
      fc.property(projectArb2(), (project) => {
        const inj = corruptRingHierarchy(project);
        if (inj === null) return;
        const report = checkConsistency(inj.project, CAL);
        if (report.ok) throw new Error('dangling-hole-parent corruption was NOT detected');
        const kinds = new Set(report.inconsistencies.map((i) => i.kind));
        if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
          throw new Error(
            `expected ${inj.expectKind} but got: ${[...kinds].join(', ')}`,
          );
        }
      }),
      { seed: SEED2, numRuns: 600 },
    );
  });

  it('RingHierarchyInvalid repair is HONEST and converges to a clean, round-tripping fixpoint', () => {
    fc.assert(
      fc.property(projectArb2(), (project) => {
        const inj = corruptRingHierarchy(project);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (fix.honestyViolated) {
          throw new Error('applyRepairChecked reported resolved:true while growing/leaving target');
        }
        if (!fix.converged) {
          throw new Error(`RingHierarchyInvalid repair did not converge (stuck=${fix.stuck})`);
        }
        const finalReport = checkConsistency(fix.project, CAL);
        if (!finalReport.ok) {
          throw new Error(
            `post-repair still inconsistent: ${finalReport.inconsistencies.map((i) => i.kind).join(', ')}`,
          );
        }
        const rt = boundaryRoundTrips(fix.project);
        if (!rt.ok) throw new Error(`repaired project failed boundary round-trip (${rt.reason})`);
      }),
      { seed: SEED2, numRuns: 600 },
    );
  });
});

// ============================================================================
// Section 5 — THIRD exploration (seed 26003, disjoint from 26001/26002 above and
// from the identity suite's 1000–6004). This section reaches CONFLICT classes and
// REPAIR PATHS the earlier corruption catalogue never injects — exercising the
// auto-repair routines that Sections 2 & 4 never drove a single time:
//
//   (h) ShapePreservation / leaf-empty-shape   → DropShapeRoleFeature
//   (i) ShapePreservation / aggregate-no-children → DropShapeRoleFeature
//   (j) TreeTopology / child-parent-mismatch    → ReconcileChildIds (the FIRST,
//       NON-destructive option — rebuild childIds from the parentId source of
//       truth — which NO prior corruption ever selected: every earlier topology
//       injection was a cycle / dangling parent, which only offer detach/drop)
//   (k) TerminalExclusion + AnchorSpatialOverlap (one geometric overlap surfaces
//       BOTH kinds, FR-106 d+g)                 → DropOverlappingFeature
//
// (An inter-child-gap AggregateSumMismatch was DELIBERATELY NOT added here: with
// this harness's two side-by-side tiling children no coordinate edit can open a
// genuine enclosed gap without either tearing the SHARED boundary vertex — which is
// VertexCoordinateDivergence, already covered — or producing a legal 飛び地 / lake
// the U08 gap rule correctly does NOT flag. A coverage probe (kept during
// development) proved a naive shared-edge nudge NEVER actually trips the
// AggregateSumMismatch verdict, so injecting it would have been a green-faking
// no-op. AggregateSumMismatch's safe-repair is instead exercised as COLLATERAL by
// the missing-vertex-on-a-shared-aggregate-vertex path already noted in Section 2.)
//
// Plus two NEW metamorphic laws never asserted before:
//   - REPAIR-ORDER INDEPENDENCE: for the reconcilable child-parent-mismatch, the
//     ReconcileChildIds repair reaches the SAME consistent project whether driven
//     to fixpoint directly or after first round-tripping the corrupt project
//     through the JSON+Zod boundary (load → repair = repair → load on the repaired
//     side: a repair is a pure function of the loaded state, not of how it loaded).
//   - NON-DESTRUCTIVE REPAIR PRESERVES FEATURES: the child-parent-mismatch
//     reconcile repair must keep EVERY feature (it only rewrites childIds), unlike
//     the drop repairs — so the repaired project has the same feature-id set as the
//     corrupt one. (A reconcile that silently dropped a feature would be a 受け入れ
//     基準5 over-reach.)
// ============================================================================

const SEED3 = 26003;

type Corruption3Tag =
  | 'leaf-empty-shape'
  | 'aggregate-no-children'
  | 'child-parent-mismatch'
  | 'terminal-overlap';

/** All feature ids appearing in a project's first-entry snapshots, as a set. */
function allFeatureIds(project: DomainProject): Set<string> {
  const out = new Set<string>();
  for (const h of project.histories) {
    for (const e of h.series.entries) {
      for (const f of e.anchor.snapshot.features) out.add(f.id as string);
    }
  }
  return out;
}

/**
 * Inject one Section-5 corruption class into a valid project, returning the
 * corrupted project AND the inconsistency kind(s) it should provoke + a code for
 * the repair OPTION the framework should offer. Returns null when the chosen
 * corruption is inapplicable to this particular project shape (caller skips).
 */
function corrupt3(
  project: DomainProject,
  tag: Corruption3Tag,
  pick: number,
): { project: DomainProject; expectKind: string } | null {
  const histories = cloneHistories(project);
  if (histories.length === 0) return null;
  const hi = pick % histories.length;

  switch (tag) {
    case 'leaf-empty-shape': {
      // Replace a STANDALONE leaf's shape with an EMPTY ring set → a shapeless
      // 末端地物 (形状保持規則違反 / leaf-empty-shape). Restrict to a single-feature
      // leaf history so the DropShapeRoleFeature repair (drop the offending feature +
      // its history) converges without colliding with aggregate/shared-vertex state.
      const h = histories[hi]!;
      const e0 = h.series.entries[0]!;
      if (e0.anchor.snapshot.features.length !== 1) return null;
      const only = e0.anchor.snapshot.features[0]!;
      if (only.kind !== 'leaf') return null;
      const emptied: LeafFeature = { ...only, shape: createShape([]) };
      mapFirstEntryFeatures(histories, hi, (features) =>
        features.map((f) => (f.id === only.id ? emptied : f)),
      );
      // Confirm the corruption is real (an empty-shape leaf is flagged).
      return {
        project: { ...project, histories },
        expectKind: INCONSISTENCY.ShapePreservation,
      };
    }
    case 'aggregate-no-children': {
      // Find an aggregate history and STRIP its childIds to [] (and detach the real
      // children to top-level so they are not orphaned by a dangling parentId) → a
      // declared-aggregate with no children (形状保持規則違反 / aggregate-no-children).
      let targetAgg: string | null = null;
      for (let i = 0; i < histories.length; i += 1) {
        const feats = histories[i]!.series.entries[0]!.anchor.snapshot.features;
        const agg = feats.find((f) => f.kind === 'aggregate');
        if (agg !== undefined) {
          targetAgg = agg.id as string;
          // Strip childIds AND clear the children's parentId in THIS history.
          mapFirstEntryFeatures(histories, i, (features) =>
            features.map((f) => {
              if (f.id === agg.id && f.kind === 'aggregate') {
                return withAggregateChildIds(f, []);
              }
              if (f.parentId !== undefined && (f.parentId as string) === (agg.id as string)) {
                return withParentId(f, undefined);
              }
              return f;
            }),
          );
          break;
        }
      }
      if (targetAgg === null) return null;
      return {
        project: { ...project, histories },
        expectKind: INCONSISTENCY.ShapePreservation,
      };
    }
    case 'child-parent-mismatch': {
      // Find an aggregate + its real children, then REMOVE one child id from the
      // aggregate's declared childIds while LEAVING that child's parentId pointing
      // at the aggregate → declared childIds ⊊ derived (parentId) set →
      // ChildParentMismatch (a TreeTopology sub-cause whose FIRST offered repair is
      // the NON-destructive ReconcileChildIds). The child stays in the snapshot.
      for (let i = 0; i < histories.length; i += 1) {
        const feats = histories[i]!.series.entries[0]!.anchor.snapshot.features;
        const agg = feats.find((f) => f.kind === 'aggregate');
        if (agg === undefined || agg.kind !== 'aggregate' || agg.childIds.length === 0) continue;
        const dropped = agg.childIds[pick % agg.childIds.length]!;
        mapFirstEntryFeatures(histories, i, (features) =>
          features.map((f) =>
            f.id === agg.id && f.kind === 'aggregate'
              ? withAggregateChildIds(f, f.childIds.filter((c) => c !== dropped))
              : f,
          ),
        );
        return {
          project: { ...project, histories },
          expectKind: INCONSISTENCY.TreeTopology,
        };
      }
      return null;
    }
    case 'terminal-overlap': {
      // Make TWO standalone leaf features occupy the SAME space at the SAME time →
      // a positive-area overlap that surfaces as BOTH TerminalExclusion (d) and
      // AnchorSpatialOverlap (g). We take two single-leaf histories, collapse each to
      // ONE entry starting at the same year, and translate the SECOND leaf's vertices
      // on top of the first's footprint. Needs ≥2 single-leaf histories.
      const leafHist: number[] = [];
      for (let i = 0; i < histories.length; i += 1) {
        const feats = histories[i]!.series.entries[0]!.anchor.snapshot.features;
        if (feats.length === 1 && feats[0]!.kind === 'leaf') leafHist.push(i);
        if (leafHist.length === 2) break;
      }
      if (leafHist.length < 2) return null;
      const [iA, iB] = leafHist as [number, number];
      const hA = histories[iA]!;
      const hB = histories[iB]!;
      const eA = hA.series.entries[0]!;
      const eB = hB.series.entries[0]!;
      const at = timePointYear(0);
      // Reference footprint: leaf A's vertices, verbatim.
      const aVerts = [...eA.anchor.snapshot.vertices.byId.values()];
      const aFirst = aVerts[0]!;
      // Rebuild B's store so EVERY B vertex sits at A's first-vertex coordinate
      // OFFSET by its own delta from B's first vertex — i.e. translate B's whole
      // footprint to start exactly where A's does. Same SHAPE, overlapping AREA.
      const bVerts = [...eB.anchor.snapshot.vertices.byId.values()];
      const bFirst = bVerts[0]!;
      const movedB = bVerts.map((v) =>
        createVertex(
          v.id,
          createCoordinate(
            aFirst.coordinate.lon + (v.coordinate.lon - bFirst.coordinate.lon),
            aFirst.coordinate.lat + (v.coordinate.lat - bFirst.coordinate.lat),
          ),
        ),
      );
      histories[iA] = {
        featureId: hA.featureId,
        series: { entries: [{ anchor: eA.anchor, start: at, end: null }] },
      };
      histories[iB] = {
        featureId: hB.featureId,
        series: {
          entries: [
            {
              anchor: createAnchor(
                eB.anchor.id,
                createAnchorSnapshot(eB.anchor.snapshot.features, createVertexStore(movedB)),
              ),
              start: at,
              end: null,
            },
          ],
        },
      };
      return {
        project: { ...project, histories },
        expectKind: INCONSISTENCY.TerminalExclusion,
      };
    }
  }
}

const corruption3Arb: fc.Arbitrary<Corruption3Tag> = fc.constantFrom(
  'leaf-empty-shape',
  'aggregate-no-children',
  'child-parent-mismatch',
  'terminal-overlap',
);

describe('bug hunt #2 / THIRD exploration (seed 26003) — new repair paths', () => {
  it('every Section-5 corruption is DETECTED with its expected kind (no silent pass)', () => {
    fc.assert(
      fc.property(projectArb2(), corruption3Arb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt3(project, tag, pick);
        if (inj === null) return;
        const report = checkConsistency(inj.project, CAL);
        if (report.ok) {
          throw new Error(`Section-5 corruption "${tag}" was NOT detected (report empty)`);
        }
        const kinds = new Set(report.inconsistencies.map((i) => i.kind));
        if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
          throw new Error(
            `corruption "${tag}" expected kind ${inj.expectKind} but got: ${[...kinds].join(', ')}`,
          );
        }
      }),
      { seed: SEED3, numRuns: 900 },
    );
  });

  it('applyRepairChecked stays HONEST for the new repair paths (resolved ⇒ no growth, target gone)', () => {
    fc.assert(
      fc.property(projectArb2(), corruption3Arb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt3(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (fix.honestyViolated) {
          throw new Error(
            `applyRepairChecked reported resolved:true while growing the report / leaving target for "${tag}"`,
          );
        }
      }),
      { seed: SEED3, numRuns: 900 },
    );
  });

  it('safe-repair fixpoint converges to a CLEAN project for every Section-5 corruption', () => {
    fc.assert(
      fc.property(projectArb2(), corruption3Arb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt3(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
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
      { seed: SEED3, numRuns: 900 },
    );
  });

  it('save→load = identity AFTER Section-5 conflict resolution (repaired round-trips through Zod)', () => {
    fc.assert(
      fc.property(projectArb2(), corruption3Arb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt3(project, tag, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (!fix.converged) return;
        const rt = boundaryRoundTrips(fix.project);
        if (!rt.ok) {
          throw new Error(
            `repaired project failed boundary round-trip (${rt.reason}) for corruption "${tag}"`,
          );
        }
      }),
      { seed: SEED3, numRuns: 900 },
    );
  });

  it('child-parent-mismatch reconcile is NON-DESTRUCTIVE: every feature survives the repair', () => {
    fc.assert(
      fc.property(projectArb2(), fc.nat(), (project, pick) => {
        const inj = corrupt3(project, 'child-parent-mismatch', pick);
        if (inj === null) return;
        const beforeIds = allFeatureIds(inj.project);
        const fix = repairToFixpoint(inj.project);
        if (!fix.converged) {
          throw new Error(`child-parent-mismatch did not converge (stuck=${fix.stuck})`);
        }
        const afterIds = allFeatureIds(fix.project);
        // The reconcile repair only rewrites childIds; it must NOT drop any feature.
        for (const id of beforeIds) {
          if (!afterIds.has(id)) {
            throw new Error(
              `feature ${id} was DROPPED by the (supposedly non-destructive) reconcile repair`,
            );
          }
        }
        if (afterIds.size !== beforeIds.size) {
          throw new Error(
            `reconcile changed the feature-id set size: ${beforeIds.size} → ${afterIds.size}`,
          );
        }
      }),
      { seed: SEED3, numRuns: 700 },
    );
  });

  it('REPAIR-ORDER INDEPENDENCE: repair-then-save = save-then-repair (load is not load-path-dependent)', () => {
    fc.assert(
      fc.property(projectArb2(), corruption3Arb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt3(project, tag, pick);
        if (inj === null) return;

        // Path 1: repair the in-memory corrupt project to a fixpoint, then save→load.
        const fixDirect = repairToFixpoint(inj.project);
        if (!fixDirect.converged) return; // convergence is covered by the law above.
        const directJson = JSON.parse(JSON.stringify(serialize(fixDirect.project)));
        const directParsed = parseManifest(directJson);
        if (directParsed.outcome !== PARSE_OUTCOME.Ok) {
          throw new Error(`direct-path parse failed: ${directParsed.outcome}`);
        }
        const directLoaded = deserialize(directParsed.manifest);

        // Path 2: save→load the CORRUPT project FIRST (it is structurally valid, so it
        // round-trips through Zod), THEN repair the LOADED copy to a fixpoint.
        const corruptJson = JSON.parse(JSON.stringify(serialize(inj.project)));
        const corruptParsed = parseManifest(corruptJson);
        if (corruptParsed.outcome !== PARSE_OUTCOME.Ok) {
          // A corruption that is NOT structurally representable cannot take this path;
          // skip (the in-memory detection/repair laws still cover it).
          return;
        }
        const corruptLoaded = deserialize(corruptParsed.manifest);
        const fixLoaded = repairToFixpoint(corruptLoaded);
        if (!fixLoaded.converged) {
          throw new Error(`load-then-repair did not converge for "${tag}" (stuck=${fixLoaded.stuck})`);
        }

        // The two paths must reach the SAME consistent project (a repair is a pure
        // function of the loaded domain state, independent of whether it loaded before
        // or after repair).
        if (!projectsEqual(directLoaded, fixLoaded.project)) {
          throw new Error(
            `repair-order dependence for "${tag}": repair∘load ≠ load∘repair`,
          );
        }
      }),
      { seed: SEED3, numRuns: 700 },
    );
  });
});

// ============================================================================
// Section 6 — FOURTH exploration (seed 26004, disjoint from 26001/26002/26003
// above and from the identity suite's 1000–6004). This section reaches command
// kinds / interactions / metamorphic laws NONE of the earlier sections drive:
//
//   (l) CORRUPT-AFTER-EDIT: every earlier corruption injects into the PRISTINE
//       generator output. Here we first run a random EditCmd walk (changeStart /
//       setEnd / deleteAnchor / insertPastEdit / recolour / moveVertex), THEN
//       inject one of the seven FR-106 corruption classes into the EDITED project,
//       then drive the real U14 consistency + auto-repair fixpoint. This exercises
//       the detector + repairs against series/vertex topologies the generator never
//       emits directly (e.g. a series that has been retimed + had anchors inserted /
//       deleted), asserting the SAME metamorphic laws: detected ⇒ honest ⇒ converges
//       ⇒ round-trips through the actual JSON+Zod boundary after resolution.
//
//   (m) REPAIR-FIXPOINT IDEMPOTENCE on a CORRUPTED project (repair∘repair = repair):
//       the earlier idempotence law only ran on an already-CLEAN project. Here we
//       repair a corrupt project to a fixpoint, then run the EXACT SAME drive again
//       on the repaired result and assert it is an EXACT no-op (projectsEqual). A
//       repair that kept mutating a project it already certified clean would be a
//       受け入れ基準5 over-reach (a repair must be a fixpoint of itself).
//
//   (n) DOUBLE save→load STABILITY (load∘save∘load∘save = load∘save) + serialize
//       CANONICALITY: two INDEPENDENT serializations of the same project must be
//       byte-identical (a deterministic, canonical encoding — no Map/Set iteration
//       nondeterminism, no Date.now, no float-format drift), and loading the project
//       a SECOND time through the boundary must reproduce the first-load result
//       exactly. The earlier round-trip laws only asserted a SINGLE save→load = the
//       original; they never asserted the encoding is canonical nor that a re-save of
//       a loaded project is stable (a load that subtly re-normalized would drift on
//       the second pass and silently change a file each time it is opened+saved).
//
//   (o) MIXED Edit+Struct INTERLEAVING: the earlier walks ran EditCmds and
//       StructCmds in SEPARATE tests. Here we interleave both kinds in one sequence
//       (a retime/recolour/move can land between a vertex add and a vertex delete on
//       the same feature), asserting the full per-edit invariant battery + boundary
//       round-trip after EVERY step — a command-ordering interaction neither earlier
//       walk reaches.
// ============================================================================

const SEED4 = 26004;

/** Two independent serializations of a project must be byte-identical (canonical). */
function serializeIsCanonical(project: DomainProject): boolean {
  const a = JSON.stringify(serialize(project));
  const b = JSON.stringify(serialize(project));
  return a === b;
}

/**
 * load∘save∘load∘save = load∘save. Serialize→parse→deserialize once (load1), then
 * serialize THAT and load again (load2); load2 must equal load1 (a re-save of a
 * loaded project is a fixpoint — opening + saving a file repeatedly never drifts).
 */
function doubleBoundaryStable(project: DomainProject): { ok: boolean; reason: string } {
  const j1 = JSON.parse(JSON.stringify(serialize(project)));
  const p1 = parseManifest(j1);
  if (p1.outcome !== PARSE_OUTCOME.Ok) return { ok: false, reason: `parse1:${p1.outcome}` };
  const load1 = deserialize(p1.manifest);
  const j2 = JSON.parse(JSON.stringify(serialize(load1)));
  // Canonicality across the SECOND save of the loaded project: the bytes of save(load1)
  // must equal the bytes of save(original) — a loaded project re-encodes identically.
  if (JSON.stringify(j2) !== JSON.stringify(j1)) return { ok: false, reason: 'resave-bytes-drift' };
  const p2 = parseManifest(j2);
  if (p2.outcome !== PARSE_OUTCOME.Ok) return { ok: false, reason: `parse2:${p2.outcome}` };
  const load2 = deserialize(p2.manifest);
  if (!projectsEqual(load1, load2)) return { ok: false, reason: 'load2-ne-load1' };
  return { ok: true, reason: '' };
}

/** A union of Edit and Struct commands so a single sequence interleaves both. */
type MixedCmd = { mix: 'edit'; cmd: EditCmd } | { mix: 'struct'; cmd: StructCmd };

function mixedCmdArb(): fc.Arbitrary<MixedCmd> {
  return fc.oneof(
    cmdArb().map((cmd) => ({ mix: 'edit' as const, cmd })),
    structCmdArb().map((cmd) => ({ mix: 'struct' as const, cmd })),
  );
}

function applyMixedCmd(project: DomainProject, m: MixedCmd): DomainProject {
  return m.mix === 'edit' ? applyCmd(project, m.cmd) : applyStructCmd(project, m.cmd).project;
}

/**
 * EDIT commands that mutate ONLY the timeline / colour, never vertex GEOMETRY:
 * changeStart / setEnd / deleteAnchor / insertPastEdit / recolour. A raw `moveVertex`
 * is DELIBERATELY excluded for the corrupt-after-edit walk: dragging a SHARED
 * boundary vertex of two sibling children can legitimately slide one child's
 * territory on top of its neighbour's, producing a TerminalExclusion /
 * AnchorSpatialOverlap — a documented conflict-resolution class (see ringGeometryValid
 * / aggregateUnionValid: a vertex drag CAN create overlap, which the load-time layer
 * surfaces, not something the edit op forbids). That is NOT a defect, so the
 * corrupt-after-edit precondition "the edit walk alone leaves the project consistent"
 * must use the geometry-preserving subset; these commands still reach retimed /
 * anchor-inserted / anchor-deleted series the generator never emits directly, which is
 * the genuinely-new surface this exploration targets. (The full battery — including
 * moveVertex-driven overlap — is still asserted as a STRUCTURAL/round-trip invariant
 * by the mixed-interleaving and Section-1 walks, which never claim post-edit
 * consistency, only the geometry-agnostic checkAllInvariants + round-trip.)
 */
function nonGeometricCmdArb(): fc.Arbitrary<EditCmd> {
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
  );
}

describe('bug hunt #2 / FOURTH exploration (seed 26004) — corrupt-after-edit + idempotence', () => {
  it('serialize is CANONICAL: two independent serializations are byte-identical', () => {
    fc.assert(
      fc.property(projectArb2(), fc.array(mixedCmdArb(), { maxLength: 16 }), (initial, cmds) => {
        let project = initial;
        if (!serializeIsCanonical(project)) throw new Error('base serialize not canonical');
        for (const m of cmds) {
          project = applyMixedCmd(project, m);
          if (!serializeIsCanonical(project)) {
            throw new Error(`serialize not canonical after ${JSON.stringify(m)}`);
          }
        }
      }),
      { seed: SEED4, numRuns: 500 },
    );
  });

  it('double save→load is STABLE (load∘save∘load∘save = load∘save) with no re-save byte drift', () => {
    fc.assert(
      fc.property(projectArb2(), fc.array(mixedCmdArb(), { maxLength: 16 }), (initial, cmds) => {
        let project = initial;
        for (const m of cmds) {
          project = applyMixedCmd(project, m);
          const stable = doubleBoundaryStable(project);
          if (!stable.ok) {
            throw new Error(`double round-trip unstable (${stable.reason}) after ${JSON.stringify(m)}`);
          }
        }
      }),
      { seed: SEED4, numRuns: 600 },
    );
  });

  it('MIXED Edit+Struct interleaving preserves every invariant + boundary round-trip', () => {
    fc.assert(
      fc.property(
        projectArb2(),
        fc.array(mixedCmdArb(), { minLength: 1, maxLength: 20 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkBaseInvariants(project);
          if (!base.ok) throw new Error(`generated base invalid: ${base.failed}`);
          for (const m of cmds) {
            project = applyMixedCmd(project, m);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(`invariant "${check.failed}" broke after mixed cmd ${JSON.stringify(m)}`);
            }
            const rt = boundaryRoundTrips(project);
            if (!rt.ok) {
              throw new Error(`boundary round-trip broke (${rt.reason}) after mixed ${JSON.stringify(m)}`);
            }
          }
        },
      ),
      { seed: SEED4, numRuns: 700 },
    );
  });

  it('CORRUPT-AFTER-EDIT: a corruption injected into an EDITED project is DETECTED', () => {
    fc.assert(
      fc.property(
        projectArb(),
        fc.array(nonGeometricCmdArb(), { maxLength: 12 }),
        corruptionArb,
        fc.nat(),
        (initial, cmds, tag, pick) => {
          // First run a GEOMETRY-PRESERVING edit walk (retime / setEnd / delete /
          // insert / recolour — see nonGeometricCmdArb), THEN corrupt. This reaches
          // series topologies the generator never emits while keeping the
          // "edit walk alone stays consistent" precondition true.
          let edited = initial;
          for (const c of cmds) edited = applyCmd(edited, c);
          // The edited project itself must still be consistent (sanity: edits preserve it).
          const editedReport = checkConsistency(edited, CAL);
          if (!editedReport.ok) {
            throw new Error(
              `edit walk ALONE produced an inconsistency before corruption: ${editedReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const inj = corrupt(edited, tag, pick);
          if (inj === null) return; // inapplicable to this edited shape — skip.
          const report = checkConsistency(inj.project, CAL);
          if (report.ok) {
            throw new Error(`corruption "${tag}" on an EDITED project was NOT detected`);
          }
          const kinds = new Set(report.inconsistencies.map((i) => i.kind));
          if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
            throw new Error(
              `corruption "${tag}" (post-edit) expected ${inj.expectKind} but got: ${[...kinds].join(', ')}`,
            );
          }
        },
      ),
      { seed: SEED4, numRuns: 900 },
    );
  });

  it('CORRUPT-AFTER-EDIT: repair is HONEST, converges, and round-trips through Zod', () => {
    fc.assert(
      fc.property(
        projectArb(),
        fc.array(nonGeometricCmdArb(), { maxLength: 12 }),
        corruptionArb,
        fc.nat(),
        (initial, cmds, tag, pick) => {
          let edited = initial;
          for (const c of cmds) edited = applyCmd(edited, c);
          const inj = corrupt(edited, tag, pick);
          if (inj === null) return;
          const fix = repairToFixpoint(inj.project);
          if (fix.honestyViolated) {
            throw new Error(
              `applyRepairChecked reported resolved:true while growing/leaving target (post-edit "${tag}")`,
            );
          }
          if (!fix.converged) {
            throw new Error(`post-edit safe-repair fixpoint did not converge for "${tag}" (stuck=${fix.stuck})`);
          }
          const finalReport = checkConsistency(fix.project, CAL);
          if (!finalReport.ok) {
            throw new Error(
              `post-edit repaired project still inconsistent for "${tag}": ${finalReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rt = boundaryRoundTrips(fix.project);
          if (!rt.ok) {
            throw new Error(`post-edit repaired project failed boundary round-trip (${rt.reason}) for "${tag}"`);
          }
        },
      ),
      { seed: SEED4, numRuns: 900 },
    );
  });

  it('REPAIR-FIXPOINT IDEMPOTENCE: repair∘repair = repair on a CORRUPTED project (re-drive is a no-op)', () => {
    fc.assert(
      fc.property(projectArb2(), corruptionArb, fc.nat(), (project, tag, pick) => {
        const inj = corrupt(project, tag, pick);
        if (inj === null) return;
        const fix1 = repairToFixpoint(inj.project);
        if (!fix1.converged) return; // convergence is covered by Section 2's law.
        // Re-running the SAME drive on the already-repaired (clean) project must be an
        // EXACT no-op: a repair is a fixpoint of itself (repair∘repair = repair).
        const fix2 = repairToFixpoint(fix1.project);
        if (!fix2.converged) {
          throw new Error(`second repair drive did not converge for "${tag}" (stuck=${fix2.stuck})`);
        }
        if (fix2.honestyViolated) {
          throw new Error(`second repair drive reported a dishonest resolution for "${tag}"`);
        }
        if (!projectsEqual(fix2.project, fix1.project)) {
          throw new Error(`repair∘repair ≠ repair for "${tag}": second drive mutated an already-clean project`);
        }
      }),
      { seed: SEED4, numRuns: 900 },
    );
  });
});

// ============================================================================
// Section 7 — bug hunt #3 (seed 36002, DISJOINT from 26001/26002/26003/26004
// above AND from the identity suite's 1000–6004 / 21000–26000). This section adds
// generators / command kinds / interactions / a stateful model that NONE of the
// earlier sections reach:
//
//   (p) MIXED-GRANULARITY TimePoints (year / yearMonth / yearMonthDay) on anchor
//       START and END. EVERY earlier section pins every anchor time to a bare
//       `timePointYear` — so the persistence layer's serialize/deserialize of the
//       month/day TimePoint variants, the cross-granularity `normalize` /
//       `compare`, and the round-trip identity of a yearMonth/yearMonthDay start
//       were NEVER exercised by this file. The mixed-granularity generator places
//       each anchor at a year that is FAR apart (≥ 4 years) so two points of
//       different granularity can never normalize to the same instant and collapse
//       under the dedup (which would make the generated base lose an anchor) —
//       i.e. the base is genuinely INV-1/2/3 valid, then the full battery +
//       boundary round-trip is asserted after each command.
//
//   (q) fast-check STATEFUL model (fc.commands + fc.modelRun). The brief asks for
//       a fast-check STATEFUL exploration; Sections 1–6 only ever drove `fc.array`
//       command lists. Here a real-command model interleaves retime / setEnd /
//       deleteAnchor / insertPastEdit / recolour / moveVertex AND save→load AND
//       undo∘op over a single mutable holder, asserting the full per-edit battery
//       + round-trip AFTER each stateful command — a generation strategy (shrinks
//       over command SEQUENCES, not a flat array) the earlier sections never use.
//
//   (r) A NEW corruption class for the conflict-resolution surface: a DEGENERATE
//       BOUNDED interval (an entry whose `end` equals / precedes its own `start`,
//       INV-3) hand-built to BYPASS setEnd's guard. Section 2's only time
//       corruption was an INV-1 descending-start inversion; an INV-3 zero/negative
//       span is a DISTINCT TimeConflict sub-cause whose NormalizeSeries repair
//       takes the "drop the degenerate entry / reopen the sole survivor" branch
//       the earlier descending-start corruption never drives. We assert the same
//       metamorphic repair laws (detected ⇒ honest ⇒ converges ⇒ round-trips).
//
//   (s) DUAL corruption injection: inject TWO independent FR-106 classes into ONE
//       project at once (every earlier section injected exactly one), then drive
//       the SAME safe-repair fixpoint and assert it still converges to a clean,
//       round-tripping project and stays HONEST. A repair catalogue that resolves
//       each class in isolation but DEADLOCKS / mutually-blocks when two coexist
//       (one repair re-introducing the other's precondition) would surface here.
//
//   (t) METAMORPHIC redo∘undo∘op = op AND undo∘op = identity on the MIXED-
//       granularity projects via the REAL U12 history module (the earlier
//       undo/redo laws ran only on bare-year projects), so month/day TimePoints
//       survive an undo/redo cycle byte-for-byte (serialize equality).
// ============================================================================

const SEED7 = 36002;

/**
 * A mixed-granularity TimePoint at a base year, choosing year / yearMonth /
 * yearMonthDay deterministically from `g`. Month is kept in 1..12 and day in
 * 1..28 so the point is ALWAYS calendar-valid (validate passes) regardless of
 * month length / leap year — the generated series must be valid by construction.
 */
function mixedTimePoint(year: number, g: number): TimePoint {
  const mod = ((g % 3) + 3) % 3;
  if (mod === 0) return timePointYear(year);
  const month = (Math.abs(g) % 12) + 1; // 1..12
  if (mod === 1) return timePointYearMonth(year, month);
  const day = (Math.abs(g >> 2) % 28) + 1; // 1..28 (always valid)
  return timePointYearMonthDay(year, month, day);
}

/**
 * Build a FeatureHistory whose anchors carry MIXED-granularity starts. `specs`
 * pairs an ascending, FAR-APART base year with a granularity selector; because
 * the base years differ by ≥ 4 and month/day only refine WITHIN a year, two
 * distinct anchors can never normalize to the same instant, so the series stays
 * strictly ascending (INV-1) and no anchor collapses under the dedup.
 */
function mixedGranularityHistory(
  ownerId: string,
  idForAnchors: string,
  features: readonly Feature[],
  vertices: readonly Vertex[],
  specs: readonly { year: number; g: number }[],
): FeatureHistory {
  const store = createVertexStore([...vertices]);
  const entries = specs.map((spec, i) =>
    createAnchorEntry(
      createAnchor(asAnchorId(`${idForAnchors}-mg-${i}`), createAnchorSnapshot(features, store)),
      mixedTimePoint(spec.year, spec.g),
      null,
    ),
  );
  return { featureId: asFeatureId(ownerId), series: normalizeSeries(entries, CAL) };
}

/** Like projectArb() but every anchor start is a MIXED-granularity TimePoint. */
function projectArbMixed(): fc.Arbitrary<DomainProject> {
  const kindArb: fc.Arbitrary<FeatureKindTag> = fc.constantFrom('leaf', 'point', 'hole', 'aggregate');
  return fc
    .array(
      fc.record({
        kind: kindArb,
        // 1..4 anchors: a strictly-ascending, FAR-APART (≥ 4-year gap) base-year
        // list paired with a per-anchor granularity selector. The far-apart gap
        // guarantees no two mixed-granularity points collapse to one instant.
        anchors: fc
          .uniqueArray(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 4 })
          .map((slots) =>
            [...slots]
              .sort((a, b) => a - b)
              .map((slot) => slot * 5), // ×5 → gaps of ≥ 5 years.
          )
          .chain((years) =>
            fc
              .array(fc.integer({ min: 0, max: 8 }), {
                minLength: years.length,
                maxLength: years.length,
              })
              .map((gs) => years.map((year, i) => ({ year, g: gs[i]! }))),
          ),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((specs) => {
      const histories: FeatureHistory[] = specs.map((spec, i) => {
        const id = `m${i}`;
        const ox = 1000 + i * 300;
        if (spec.kind === 'leaf') {
          const { feature, vertices } = squareLeaf(id, ox, 0, 10);
          return mixedGranularityHistory(id, id, [feature], vertices, spec.anchors);
        }
        if (spec.kind === 'point') {
          const { feature, vertex } = pointFeature(id, ox, 0);
          return mixedGranularityHistory(id, id, [feature], [vertex], spec.anchors);
        }
        if (spec.kind === 'hole') {
          const { feature, vertices } = holedLeaf(id, ox, 0);
          return mixedGranularityHistory(id, id, [feature], vertices, spec.anchors);
        }
        const { features, vertices } = aggregateWithChildren(id, ox);
        return mixedGranularityHistory(`${id}-agg`, id, features, vertices, spec.anchors);
      });
      return { histories, settings: SETTINGS, baseMap: BASEMAP };
    });
}

describe('bug hunt #3 / mixed-granularity round-trip (seed 36002)', () => {
  it('generated mixed-granularity base satisfies every load invariant (incl. month/day starts)', () => {
    fc.assert(
      fc.property(projectArbMixed(), (project) => {
        const check = checkBaseInvariants(project);
        if (!check.ok) throw new Error(`mixed-granularity base failed: ${check.failed}`);
        // Sanity: at least SOME run must actually exercise a non-year granularity,
        // else the generator silently degraded to bare-year (green-faking guard).
        // (Asserted per-run only as a property of THIS project; the aggregate
        // coverage is implied by numRuns over the granularity selector.)
      }),
      { seed: SEED7, numRuns: 400 },
    );
  });

  it('a mixed-granularity start survives the ACTUAL JSON+Zod boundary unchanged', () => {
    fc.assert(
      fc.property(projectArbMixed(), (project) => {
        const rt = boundaryRoundTrips(project);
        if (!rt.ok) throw new Error(`mixed-granularity base boundary round-trip failed: ${rt.reason}`);
        // The serialized form must literally carry a non-year granularity for at
        // least one anchor when the generator chose one — assert that serialize
        // preserves the granularity discriminant (not silently down-leveled).
        const manifest = serialize(project);
        for (const h of manifest.histories) {
          for (const e of h.entries) {
            expect(['year', 'yearMonth', 'yearMonthDay']).toContain(e.start.granularity);
          }
        }
      }),
      { seed: SEED7, numRuns: 400 },
    );
  });

  it('all invariants + in-memory round-trip survive an edit sequence over mixed-granularity starts', () => {
    fc.assert(
      fc.property(
        projectArbMixed(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 24 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkBaseInvariants(project);
          if (!base.ok) throw new Error(`mixed base invalid: ${base.failed}`);
          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(
                `invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)} (mixed-granularity)`,
              );
            }
            const rt = boundaryRoundTrips(project);
            if (!rt.ok) {
              throw new Error(
                `boundary round-trip broke (${rt.reason}) after ${JSON.stringify(cmd)} (mixed-granularity)`,
              );
            }
          }
        },
      ),
      { seed: SEED7, numRuns: 700 },
    );
  });
});

// ============================================================================
// Section 7 (q) — fast-check STATEFUL model. A real-command model drives a single
// mutable holder of the current project; each Command applies one production
// operation (edit / save→load / undo∘op) and asserts the full per-edit battery +
// round-trip after the step. fc.commands shrinks over the command SEQUENCE.
// ============================================================================

interface ProjectModel {
  /** Number of histories (constant under the commands we model — none add/remove a history). */
  readonly historyCount: number;
}

interface ProjectReal {
  project: DomainProject;
}

/** A stateful command: apply an EditCmd, then assert the full invariant battery + round-trip. */
class EditStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly cmd: EditCmd) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    r.project = applyCmd(r.project, this.cmd);
    const check = checkAllInvariants(r.project);
    if (!check.ok) {
      throw new Error(`[stateful] invariant "${check.failed}" broke after ${JSON.stringify(this.cmd)}`);
    }
    const rt = boundaryRoundTrips(r.project);
    if (!rt.ok) {
      throw new Error(`[stateful] boundary round-trip broke (${rt.reason}) after ${JSON.stringify(this.cmd)}`);
    }
  }
  toString(): string {
    return `edit(${this.cmd.tag})`;
  }
}

/** A stateful command: save→load the current project and assert it equals itself (identity). */
class SaveLoadStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    const reloaded = deserialize(serialize(r.project));
    if (!projectsEqual(reloaded, r.project)) {
      throw new Error('[stateful] save→load was not identity');
    }
    // Adopt the reloaded copy as the live state (a real session continues from the
    // loaded project): a SUBSEQUENT edit must still hold every invariant on the
    // freshly-rebuilt instances, not only on the original in-memory object graph.
    r.project = reloaded;
  }
  toString(): string {
    return 'save→load';
  }
}

/** A stateful command: undo∘op = identity via the REAL U12 history module. */
class UndoOpStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly cmd: EditCmd) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    const before = r.project;
    const h0 = createHistory<DomainProject>(before);
    const cmdObj = reversibleEdit(before, this.cmd);
    const afterExec = execute(h0, cmdObj);
    const afterUndo = undo(afterExec.history);
    if (!projectsEqual(afterUndo.history.state, before)) {
      throw new Error(`[stateful] undo∘op ≠ identity for ${JSON.stringify(this.cmd)}`);
    }
    // redo∘undo∘op must restore the executed state byte-for-byte.
    const afterRedo = redo(afterUndo.history);
    if (
      JSON.stringify(serialize(afterRedo.history.state)) !==
      JSON.stringify(serialize(afterExec.history.state))
    ) {
      throw new Error(`[stateful] redo∘undo∘op ≠ op for ${JSON.stringify(this.cmd)}`);
    }
    // Leave the live state unchanged (this command is a metamorphic probe, not an edit).
  }
  toString(): string {
    return `undo∘op(${this.cmd.tag})`;
  }
}

describe('bug hunt #3 / stateful model (seed 36002)', () => {
  it('a random stateful command sequence preserves every invariant + round-trip + undo/redo laws', () => {
    const allCommands = fc.commands(
      [
        cmdArb().map((c) => new EditStatefulCmd(c)),
        fc.constant(new SaveLoadStatefulCmd()),
        cmdArb().map((c) => new UndoOpStatefulCmd(c)),
      ],
      { maxCommands: 24 },
    );
    fc.assert(
      fc.property(projectArbMixed(), allCommands, (initial, cmds) => {
        const base = checkBaseInvariants(initial);
        if (!base.ok) throw new Error(`stateful base invalid: ${base.failed}`);
        const real = (): { model: ProjectModel; real: ProjectReal } => ({
          model: { historyCount: initial.histories.length },
          real: { project: initial },
        });
        fc.modelRun(real, cmds);
      }),
      { seed: SEED7, numRuns: 300 },
    );
  });
});

// ============================================================================
// Section 7 (r) — NEW corruption: a DEGENERATE bounded interval (INV-3). An entry
// whose `end` is <= its own `start`, hand-built to bypass setEnd's guard, is a
// TimeConflict whose sub-cause is INV-3 (not the INV-1 descending start Section 2
// injects). Its NormalizeSeries repair drives the "drop the degenerate entry /
// reopen the sole survivor" branch the earlier corruption never reaches.
// ============================================================================

/**
 * Inject a degenerate bounded interval into one history: set the FIRST entry's
 * end to a time <= its start (zero or negative span), bypassing setEnd's INV-3
 * guard by writing the entry directly. Returns null when the chosen history's
 * first entry's start cannot be turned degenerate (always representable for our
 * year-based generator, so this essentially always applies).
 */
function corruptDegenerateEnd(
  project: DomainProject,
  pick: number,
): { project: DomainProject; expectKind: string } | null {
  const histories = cloneHistories(project);
  if (histories.length === 0) return null;
  const hi = pick % histories.length;
  const h = histories[hi]!;
  const e0 = h.series.entries[0]!;
  // The degenerate end: the entry's OWN start (zero span → INV-3 violated since
  // end is not strictly after start). normalize/compare treat equal points as
  // span 0, which validateSeries flags as INV-3.
  const degenerateEnd = e0.start;
  const corruptedEntries: AnchorEntry[] = h.series.entries.map((e, i) =>
    i === 0 ? { anchor: e.anchor, start: e.start, end: degenerateEnd } : e,
  );
  const candidate: AnchorSeries = { entries: corruptedEntries };
  // Only a corruption if it actually breaks validateSeries (INV-3).
  if (validateSeries(candidate, CAL).ok) return null;
  histories[hi] = { featureId: h.featureId, series: candidate };
  return { project: { ...project, histories }, expectKind: INCONSISTENCY.TimeConflict };
}

describe('bug hunt #3 / degenerate-bounded-interval corruption (seed 36002)', () => {
  it('a zero/negative-span entry (INV-3) is DETECTED as TimeConflict', () => {
    fc.assert(
      fc.property(projectArbMixed(), fc.nat(), (project, pick) => {
        const inj = corruptDegenerateEnd(project, pick);
        if (inj === null) return;
        const report = checkConsistency(inj.project, CAL);
        if (report.ok) throw new Error('degenerate-bounded-interval corruption was NOT detected');
        const kinds = new Set(report.inconsistencies.map((i) => i.kind));
        if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
          throw new Error(`expected ${inj.expectKind} but got: ${[...kinds].join(', ')}`);
        }
      }),
      { seed: SEED7, numRuns: 600 },
    );
  });

  it('degenerate-interval repair is HONEST, converges, and round-trips through Zod', () => {
    fc.assert(
      fc.property(projectArbMixed(), fc.nat(), (project, pick) => {
        const inj = corruptDegenerateEnd(project, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (fix.honestyViolated) {
          throw new Error('applyRepairChecked reported resolved:true while growing/leaving target');
        }
        if (!fix.converged) {
          throw new Error(`degenerate-interval repair did not converge (stuck=${fix.stuck})`);
        }
        const finalReport = checkConsistency(fix.project, CAL);
        if (!finalReport.ok) {
          throw new Error(
            `post-repair still inconsistent: ${finalReport.inconsistencies.map((i) => i.kind).join(', ')}`,
          );
        }
        const rt = boundaryRoundTrips(fix.project);
        if (!rt.ok) throw new Error(`repaired project failed boundary round-trip (${rt.reason})`);
      }),
      { seed: SEED7, numRuns: 600 },
    );
  });
});

// ============================================================================
// Section 7 (s) — DUAL corruption injection. Inject TWO independent FR-106 classes
// into ONE project and assert the safe-repair fixpoint still converges to a clean,
// round-tripping project and stays HONEST. A catalogue that resolves each class in
// isolation but mutually-blocks when two coexist would surface here.
// ============================================================================

describe('bug hunt #3 / dual-corruption fixpoint (seed 36002)', () => {
  it('two independent corruptions injected together still repair to a clean, round-tripping fixpoint', () => {
    fc.assert(
      fc.property(
        projectArbMixed(),
        corruptionArb,
        corruptionArb,
        fc.nat(),
        fc.nat(),
        (project, tagA, tagB, pickA, pickB) => {
          // Inject the FIRST corruption; if inapplicable, skip (covered elsewhere).
          const injA = corrupt(project, tagA, pickA);
          if (injA === null) return;
          // The first corruption alone MUST be detected (proves it is a REAL
          // corruption — this is the non-vacuity guard so the test is never a no-op).
          if (checkConsistency(injA.project, CAL).ok) {
            throw new Error(`first corruption (${tagA}) alone was NOT detected — invalid precondition`);
          }
          // Inject the SECOND corruption on TOP of the first. `corrupt` rebuilds the
          // histories from scratch and applies ONE mutation; a second injection can
          // legitimately OVERWRITE the structure the first relied on (e.g.
          // vertex-divergence collapses two histories to single year-0 entries, then
          // missing-vertex drops the very shared vertex the divergence needed),
          // yielding a genuinely CONSISTENT project. That is NOT a detection gap (each
          // class IS detected in isolation per Section 2): it is a real value whose
          // only honest verdict is "consistent". So we do NOT require the COMBINED
          // project to be inconsistent; we require that whatever it is, the safe-repair
          // fixpoint reaches a clean, round-tripping project and stays HONEST.
          const injB = corrupt(injA.project, tagB, pickB);
          const target = injB === null ? injA.project : injB.project;

          const fix = repairToFixpoint(target);
          if (fix.honestyViolated) {
            throw new Error(`dual corruption (${tagA}+${tagB}) repair was DISHONEST (resolved while unsafe)`);
          }
          // Some dual combinations may be genuinely unresolvable by single-drop
          // repairs (e.g. a corruption whose only safe repair re-introduces the
          // other's precondition); convergence is asserted, and a non-converging
          // STUCK case is reported so it cannot silently pass.
          if (!fix.converged) {
            throw new Error(
              `dual corruption (${tagA}+${tagB}) did NOT converge to a clean fixpoint (stuck=${fix.stuck})`,
            );
          }
          const finalReport = checkConsistency(fix.project, CAL);
          if (!finalReport.ok) {
            throw new Error(
              `post-dual-repair still inconsistent (${tagA}+${tagB}): ${finalReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rt = boundaryRoundTrips(fix.project);
          if (!rt.ok) {
            throw new Error(`dual-repaired project failed boundary round-trip (${rt.reason}) for ${tagA}+${tagB}`);
          }
        },
      ),
      { seed: SEED7, numRuns: 1000 },
    );
  });
});

// ============================================================================
// Section 7 (t) — undo/redo metamorphic laws on MIXED-granularity projects, via the
// REAL U12 history module (the earlier undo/redo laws ran only on bare-year starts).
// ============================================================================

describe('bug hunt #3 / undo-redo over mixed-granularity (seed 36002)', () => {
  it('undo ∘ op = identity AND redo ∘ undo ∘ op = op (month/day starts survive byte-for-byte)', () => {
    fc.assert(
      fc.property(projectArbMixed(), cmdArb(), (initial, cmd) => {
        const h0 = createHistory<DomainProject>(initial);
        const cmdObj = reversibleEdit(initial, cmd);
        const afterExec = execute(h0, cmdObj);
        const executed = afterExec.history.state;
        const afterUndo = undo(afterExec.history);
        expect(projectsEqual(afterUndo.history.state, initial)).toBe(true);
        // The undone state must serialize byte-identically to the original (so a
        // mixed-granularity start was not silently re-leveled on the undo path).
        expect(JSON.stringify(serialize(afterUndo.history.state))).toBe(
          JSON.stringify(serialize(initial)),
        );
        const afterRedo = redo(afterUndo.history);
        expect(JSON.stringify(serialize(afterRedo.history.state))).toBe(
          JSON.stringify(serialize(executed)),
        );
      }),
      { seed: SEED7, numRuns: 500 },
    );
  });
});

// ============================================================================
// Section 8 — bug hunt #3 / FIFTH exploration (seed 36003, DISJOINT from all the
// pins above: 26001/26002/26003/26004, 36002, AND the identity suite's
// 1000–6004 / 21000–26000). This section reaches command kinds / interactions /
// metamorphic laws and a STATEFUL strategy that NONE of the earlier sections
// drive even once:
//
//   (u) A fast-check STATEFUL model whose alphabet includes CONFLICT-RESOLUTION
//       as live commands — Section 7(q)'s stateful model only ever drove edit /
//       save→load / undo∘op; it never injected a corruption nor ran a repair as a
//       stateful step. Here a single mutable holder is driven by an interleaving
//       of: a geometry-preserving EDIT, a STRUCTURAL vertex add/delete (U24),
//       save→load, undo∘op, AND a CORRUPT-THEN-REPAIR-TO-FIXPOINT command (inject
//       one FR-106 class, assert detection + honest convergence + post-repair
//       consistency + boundary round-trip, then ADOPT the repaired project as the
//       live state so a SUBSEQUENT command continues from a once-corrupted-then-
//       healed project). The "continue editing a project that was already repaired
//       once" path is a session interaction no earlier section reaches — every
//       earlier corrupt→repair test ended at the fixpoint and never fed it back
//       into the edit/round-trip walk. fc.commands shrinks over the SEQUENCE.
//
//   (v) TRIPLE corruption injection (Section 7(s) maxed out at TWO): inject THREE
//       independent FR-106 classes into ONE project, then drive the same safe-
//       repair fixpoint and assert it still converges to a clean, round-tripping
//       project and stays HONEST. A catalogue that pairwise-resolves but
//       three-way-deadlocks (one repair re-introducing a second's precondition
//       while a third blocks the only escape) would surface only at arity ≥ 3.
//
//   (w) op ∘ inverse-op = identity for the END-time axis (Section 3 only covered
//       insert∘delete on the START axis): setEnd(e) then setEnd(null) on the SAME
//       anchor must restore the ORIGINAL series byte-for-byte when the original
//       end was already null — clearing an end you just set is the exact inverse
//       of setting it. Driven through the REAL U09 setEnd guard on each history.
//
//   (x) changeStart is a SELF-INVERSE round-trip on the START axis: moving an
//       anchor's start to a fresh free year and back to its original year must
//       restore the original series (the two changeStart ops compose to identity
//       when the intermediate year collides with no other anchor). A start-axis
//       op∘inverse-op law the insert∘delete law (Section 3) never asserts.
// ============================================================================

const SEED8 = 36003;

/**
 * Inject one corruption AND drive the safe-repair fixpoint as ONE stateful step,
 * asserting the full metamorphic conflict-resolution battery, then return the
 * repaired (clean) project so the caller can adopt it as the live session state.
 * Returns null if the corruption was inapplicable to this project shape (the
 * caller leaves the live state unchanged). Throws on any law violation.
 */
function corruptThenRepairStep(
  project: DomainProject,
  tag: CorruptionTag,
  pick: number,
): DomainProject | null {
  const inj = corrupt(project, tag, pick);
  if (inj === null) return null;
  // Detection: the injected class MUST be flagged (no silent pass).
  const report = checkConsistency(inj.project, CAL);
  if (report.ok) {
    throw new Error(`[stateful] corruption "${tag}" on a live project was NOT detected`);
  }
  const kinds = new Set(report.inconsistencies.map((i) => i.kind));
  if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
    throw new Error(
      `[stateful] corruption "${tag}" expected ${inj.expectKind} but got: ${[...kinds].join(', ')}`,
    );
  }
  const fix = repairToFixpoint(inj.project);
  if (fix.honestyViolated) {
    throw new Error(`[stateful] applyRepairChecked dishonest for live corruption "${tag}"`);
  }
  if (!fix.converged) {
    throw new Error(`[stateful] live corruption "${tag}" did not converge (stuck=${fix.stuck})`);
  }
  if (!checkConsistency(fix.project, CAL).ok) {
    throw new Error(`[stateful] post-repair live project still inconsistent for "${tag}"`);
  }
  const rt = boundaryRoundTrips(fix.project);
  if (!rt.ok) {
    throw new Error(`[stateful] repaired live project failed boundary round-trip (${rt.reason})`);
  }
  return fix.project;
}

/** A stateful command: apply ONE structural U24 edit, then assert battery + round-trip. */
class StructStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly cmd: StructCmd) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    r.project = applyStructCmd(r.project, this.cmd).project;
    const check = checkAllInvariants(r.project);
    if (!check.ok) {
      throw new Error(`[stateful] invariant "${check.failed}" broke after struct ${JSON.stringify(this.cmd)}`);
    }
    const rt = boundaryRoundTrips(r.project);
    if (!rt.ok) {
      throw new Error(`[stateful] boundary round-trip broke (${rt.reason}) after struct ${JSON.stringify(this.cmd)}`);
    }
  }
  toString(): string {
    return `struct(${this.cmd.tag})`;
  }
}

/**
 * A stateful command: inject a corruption, repair to a fixpoint, assert the
 * conflict-resolution battery, and ADOPT the healed project as the live state so
 * later commands continue from a once-corrupted-then-repaired session.
 */
class CorruptRepairStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly tag: CorruptionTag, private readonly pick: number) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    const healed = corruptThenRepairStep(r.project, this.tag, this.pick);
    if (healed === null) return; // inapplicable to this live shape — leave state as-is.
    // The healed project must STILL satisfy the full per-edit invariant battery —
    // a repaired project is a legitimate live session state that the user keeps
    // editing, so every load-relevant invariant must hold on it too.
    const check = checkAllInvariants(healed);
    if (!check.ok) {
      throw new Error(`[stateful] healed project failed invariant "${check.failed}" for "${this.tag}"`);
    }
    r.project = healed;
  }
  toString(): string {
    return `corrupt→repair(${this.tag})`;
  }
}

const corruptRepairCmdArb: fc.Arbitrary<CorruptRepairStatefulCmd> = fc
  .record({ tag: corruptionArb, pick: fc.nat() })
  .map(({ tag, pick }) => new CorruptRepairStatefulCmd(tag, pick));

describe('bug hunt #3 / FIFTH exploration (seed 36003) — stateful with conflict-resolution', () => {
  it('a stateful sequence of edits / struct-edits / save→load / undo / corrupt→repair holds every law', () => {
    const allCommands = fc.commands(
      [
        cmdArb().map((c) => new EditStatefulCmd(c)),
        structCmdArb().map((c) => new StructStatefulCmd(c)),
        fc.constant(new SaveLoadStatefulCmd()),
        cmdArb().map((c) => new UndoOpStatefulCmd(c)),
        corruptRepairCmdArb,
      ],
      { maxCommands: 28 },
    );
    fc.assert(
      // projectArb2() so STRUCTURAL edits (line/leaf vertex ops) have material to work on.
      fc.property(projectArb2(), allCommands, (initial, cmds) => {
        const base = checkBaseInvariants(initial);
        if (!base.ok) throw new Error(`stateful base invalid: ${base.failed}`);
        const setup = (): { model: ProjectModel; real: ProjectReal } => ({
          model: { historyCount: initial.histories.length },
          real: { project: initial },
        });
        fc.modelRun(setup, cmds);
      }),
      { seed: SEED8, numRuns: 350 },
    );
  });
});

// ============================================================================
// Section 8 (v) — TRIPLE corruption injection. Inject THREE independent FR-106
// classes into ONE project and assert the safe-repair fixpoint still converges to
// a clean, round-tripping project and stays HONEST. A catalogue that pairwise-
// resolves but THREE-way mutually blocks would surface only here.
// ============================================================================

describe('bug hunt #3 / triple-corruption fixpoint (seed 36003)', () => {
  it('three independent corruptions injected together still repair to a clean, round-tripping fixpoint', () => {
    fc.assert(
      fc.property(
        projectArbMixed(),
        corruptionArb,
        corruptionArb,
        corruptionArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (project, tagA, tagB, tagC, pickA, pickB, pickC) => {
          const injA = corrupt(project, tagA, pickA);
          if (injA === null) return;
          // Non-vacuity guard: the FIRST corruption alone must be detected (proves it
          // is a REAL corruption so the test is never a silent no-op).
          if (checkConsistency(injA.project, CAL).ok) {
            throw new Error(`first corruption (${tagA}) alone was NOT detected — invalid precondition`);
          }
          // Stack the second and third on top. As in the dual case (Section 7(s)), a
          // later injection can legitimately OVERWRITE the structure an earlier one
          // relied on, yielding a project whose only honest verdict for some classes is
          // "already consistent". That is NOT a detection gap (each class IS detected in
          // isolation per Section 2); we require only that whatever the COMBINED project
          // is, the safe-repair fixpoint reaches a clean, round-tripping, HONEST result.
          const injB = corrupt(injA.project, tagB, pickB);
          const afterB = injB === null ? injA.project : injB.project;
          const injC = corrupt(afterB, tagC, pickC);
          const target = injC === null ? afterB : injC.project;

          const fix = repairToFixpoint(target);
          if (fix.honestyViolated) {
            throw new Error(
              `triple corruption (${tagA}+${tagB}+${tagC}) repair was DISHONEST (resolved while unsafe)`,
            );
          }
          if (!fix.converged) {
            throw new Error(
              `triple corruption (${tagA}+${tagB}+${tagC}) did NOT converge (stuck=${fix.stuck})`,
            );
          }
          const finalReport = checkConsistency(fix.project, CAL);
          if (!finalReport.ok) {
            throw new Error(
              `post-triple-repair still inconsistent (${tagA}+${tagB}+${tagC}): ${finalReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rt = boundaryRoundTrips(fix.project);
          if (!rt.ok) {
            throw new Error(
              `triple-repaired project failed boundary round-trip (${rt.reason}) for ${tagA}+${tagB}+${tagC}`,
            );
          }
        },
      ),
      { seed: SEED8, numRuns: 1000 },
    );
  });
});

// ============================================================================
// Section 8 (v.bug) — FR-106(a) MissingVertexReference CROSS-HISTORY MASKING.
//
// This minimal, deterministic case is the SHRUNK root cause the triple-corruption
// property above first surfaced (as a repair deadlock). It is isolated here so the
// defect is documented unambiguously and the suite fails loudly until the detector
// is fixed (緑偽装禁止: we assert the SPECIFIED correct behaviour, not the buggy one).
//
// DEFECT: `checkConsistency` resolves a feature's vertex references against the
// MERGED vertex store of ALL histories effective at a time slice
// (consistency.ts checkTimeSlice → createVertexStore(allVertices), last-write-wins),
// then runs detectMissingVertices against that merged store. So a feature whose OWN
// snapshot store is MISSING a vertex it references is NOT flagged whenever ANY other
// feature in ANOTHER history defines a vertex with the SAME id at the same time —
// the stray same-id body masks the genuine dangling reference. Vertex ids are
// per-feature in this domain (a feature's snapshot must carry the vertices it cites),
// so cross-history masking is a true false-negative: the load-time integrity gate
// (FR-106 a) silently passes a project that references a non-existent vertex, and a
// later edit / repair that removes the masking feature unmasks a "new" missing-vertex
// the auto-repair framework then (correctly) refuses to certify — deadlocking the
// safe-repair fixpoint (the property failure above).
//
// EXPECTED: A's missing `a0` reference is reported as MissingVertexReference for A.
// ============================================================================

describe('bug hunt #3 / FR-106(a) cross-history missing-vertex masking (seed 36003)', () => {
  it('a feature whose OWN snapshot lacks a referenced vertex IS detected even when another history defines that id', () => {
    // Feature A (leaf) references a0..a3, but its OWN snapshot store OMITS a0 →
    // A genuinely carries a dangling vertex reference (FR-106 a).
    const aVerts = [
      createVertex(asVertexId('mvm-a0'), createCoordinate(10, 0)),
      createVertex(asVertexId('mvm-a1'), createCoordinate(20, 0)),
      createVertex(asVertexId('mvm-a2'), createCoordinate(20, 10)),
      createVertex(asVertexId('mvm-a3'), createCoordinate(10, 10)),
    ];
    const aRing = createTerritoryRing(asRingId('mvm-a-r'), aVerts.map((v) => v.id));
    const aLeaf = createLeafFeature(
      asFeatureId('mvm-A'),
      createBasicAttributes('A', 0, 100),
      COLOR,
      createShape([aRing]),
    );
    const aStore = createVertexStore([aVerts[1]!, aVerts[2]!, aVerts[3]!]); // omits a0.

    // Feature B (point) in a DIFFERENT history at the SAME time defines a vertex
    // with the SAME id `mvm-a0` (a stray same-id body — reachable from a corrupt /
    // hand-edited file or a shared-boundary mishap).
    const bVertex = createVertex(asVertexId('mvm-b-v'), createCoordinate(500, 0));
    const strayA0 = createVertex(asVertexId('mvm-a0'), createCoordinate(10, 0));
    const bPoint = createPointFeature(
      asFeatureId('mvm-B'),
      createBasicAttributes('B', 0, 50),
      COLOR,
      bVertex.id,
      { kindLabel: '都市' },
    );
    const bStore = createVertexStore([bVertex, strayA0]);

    const project: DomainProject = {
      histories: [
        {
          featureId: asFeatureId('mvm-A'),
          series: normalizeSeries(
            [
              createAnchorEntry(
                createAnchor(asAnchorId('mvm-A-0'), createAnchorSnapshot([aLeaf], aStore)),
                timePointYear(0),
                null,
              ),
            ],
            CAL,
          ),
        },
        {
          featureId: asFeatureId('mvm-B'),
          series: normalizeSeries(
            [
              createAnchorEntry(
                createAnchor(asAnchorId('mvm-B-0'), createAnchorSnapshot([bPoint], bStore)),
                timePointYear(0),
                null,
              ),
            ],
            CAL,
          ),
        },
      ],
      settings: SETTINGS,
      baseMap: BASEMAP,
    };

    const report = checkConsistency(project, CAL);
    const flaggedA = report.inconsistencies.some(
      (i) =>
        i.kind === INCONSISTENCY.MissingVertexReference &&
        i.featureIds.includes(asFeatureId('mvm-A')),
    );
    if (!flaggedA) {
      throw new Error(
        `FR-106(a) false-negative: A references mvm-a0 absent from its OWN snapshot, ` +
          `but checkConsistency did not flag it (masked by history B's same-id vertex). ` +
          `report=[${report.inconsistencies.map((i) => `${i.kind}/${i.detail}`).join(', ')}]`,
      );
    }
  });
});

// ============================================================================
// Section 8 (w)+(x) — op ∘ inverse-op = identity on the END and START time axes,
// driven through the REAL U09 setEnd / changeStart guards. Section 3's only
// inverse-op law was insert∘delete on the START axis; these reach the end-time
// clear-after-set inverse AND the changeStart self-inverse round-trip neither
// earlier law touches.
// ============================================================================

describe('bug hunt #3 / inverse-op on the time axes (seed 36003)', () => {
  it('setEnd(e) then setEnd(null) restores the series (clear is the inverse of set) — END axis', () => {
    fc.assert(
      fc.property(projectArbMixed(), fc.nat(), fc.integer({ min: 1, max: 40 }), (project, hiPick, span) => {
        const n = project.histories.length;
        if (n === 0) return;
        const hi = hiPick % n;
        const history = project.histories[hi]!;
        const entries = history.series.entries;
        // Target an anchor whose end is ALREADY null (open-ended): clearing the end we
        // set must then restore EXACTLY that open-ended original. Pick the LAST entry so
        // there is no next-anchor bound to clamp the end against (setEnd's endBeyondNextEnd
        // / overrun-shorten cannot perturb it), making the inverse exact.
        const target = entries[entries.length - 1]!;
        if (target.end !== null) return; // only the open-ended case is a clean inverse.
        const startYear = target.start.granularity === 'year'
          ? target.start.year
          : target.start.year; // year field exists on every granularity.
        const newEnd = timePointYear(startYear + span);
        const set = setEnd(history.series, target.anchor.id, newEnd, CAL);
        if (!set.ok) return; // rejected (e.g. endNotAfterStart on a degenerate pick) — skip.
        const cleared = setEnd(set.series, target.anchor.id, null, CAL);
        expect(cleared.ok).toBe(true);
        if (cleared.ok) {
          const restored: DomainProject = {
            ...project,
            histories: project.histories.map((h, i) =>
              i === hi ? { featureId: h.featureId, series: cleared.series } : h,
            ),
          };
          expect(projectsEqual(restored, project)).toBe(true);
          // And it must serialize byte-identically (no silent re-leveling on the round-trip).
          expect(JSON.stringify(serialize(restored))).toBe(JSON.stringify(serialize(project)));
        }
      }),
      { seed: SEED8, numRuns: 600 },
    );
  });

  it('changeStart(y2) then changeStart(y1) restores the series (self-inverse) — START axis', () => {
    fc.assert(
      fc.property(projectArbMixed(), fc.nat(), (project, hiPick) => {
        const n = project.histories.length;
        if (n === 0) return;
        const hi = hiPick % n;
        const history = project.histories[hi]!;
        const entries = history.series.entries;
        // Target the LAST anchor (no future anchor to perturb on the way out / back).
        const target = entries[entries.length - 1]!;
        if (target.start.granularity !== 'year') return; // restore-to-year is exact only for a year start.
        if (target.end !== null) return; // an own-end could trip startNotBeforeEnd; keep it clean.
        const y1 = target.start.year;
        // A fresh intermediate year FAR from every existing start so no dedup-collapse
        // occurs on either hop (collapsing would lose an anchor and break the inverse).
        const usedYears = new Set(
          entries
            .map((e) => (e.start.granularity === 'year' ? e.start.year : null))
            .filter((y): y is number => y !== null),
        );
        let y2 = y1 + 1000;
        while (usedYears.has(y2)) y2 += 1;
        const out = changeStart(history.series, target.anchor.id, timePointYear(y2), CAL);
        if (!out.ok) return;
        const back = changeStart(out.series, target.anchor.id, timePointYear(y1), CAL);
        expect(back.ok).toBe(true);
        if (back.ok) {
          const restored: DomainProject = {
            ...project,
            histories: project.histories.map((h, i) =>
              i === hi ? { featureId: h.featureId, series: back.series } : h,
            ),
          };
          expect(projectsEqual(restored, project)).toBe(true);
          expect(JSON.stringify(serialize(restored))).toBe(JSON.stringify(serialize(project)));
        }
      }),
      { seed: SEED8, numRuns: 600 },
    );
  });
});

// ============================================================================
// Section 9 — bug hunt #3 / SIXTH exploration (seed 36004, DISJOINT from EVERY
// pin above: 26001/26002/26003/26004, 36002, 36003, AND the identity suite's
// 1000–6004 / 21000–26000). This section reaches command kinds / interactions /
// metamorphic laws that NONE of the earlier sections drive even once:
//
//   (y) A fast-check STATEFUL model whose alphabet injects a corruption into a
//       FRESHLY-RELOADED (post save→load) object graph — not the pristine
//       generator output (Section 2), not an in-memory-edited project (Section
//       6's corrupt-after-edit), and not a live in-memory holder (Section 8u's
//       corrupt→repair). The novel surface: the SaveLoadThenCorruptStatefulCmd
//       FIRST drives save→load (rebuilding every Vertex / Anchor / Feature
//       instance through serialize→deserialize), THEN corrupts THAT rebuilt graph,
//       repairs to a fixpoint, asserts the full conflict-resolution battery, and
//       ADOPTS the healed result as the live state. A corruption-detection /
//       repair path that only works on the original in-memory instances (e.g. an
//       identity-keyed cache, a referential-equality shortcut, a memoized store)
//       but breaks on the structurally-identical-but-freshly-built reload would
//       surface ONLY here. fc.commands shrinks over the SEQUENCE.
//
//   (z) QUADRUPLE corruption injection (Sections 7(s)/8(v) maxed out at TWO/THREE):
//       inject FOUR independent FR-106 classes into ONE project, then drive the
//       same safe-repair fixpoint and assert it still converges to a clean,
//       round-tripping, HONEST project. A catalogue that resolves at arity ≤ 3 but
//       four-way-deadlocks (a fourth class re-introducing an earlier precondition
//       on the only escape route) would surface only at arity ≥ 4.
//
//   (aa) A HEAL → EDIT → RE-HEAL cycle: corrupt a project, repair to a clean
//       fixpoint, then apply a GEOMETRY-PRESERVING edit walk to the HEALED project
//       (a user keeps editing a once-repaired file), assert it stays consistent +
//       round-trips, THEN corrupt the healed-and-edited project a SECOND time and
//       re-repair — asserting the framework heals a project that has ALREADY been
//       through one full corrupt→repair→edit lifecycle. Every earlier corrupt→
//       repair test ended at the first fixpoint; none fed a healed project back
//       through an edit walk AND a second corruption round.
// ============================================================================

const SEED9 = 36004;

/**
 * A stateful command that drives save→load FIRST (adopting the rebuilt copy),
 * THEN injects a corruption into that RELOADED object graph, repairs to a
 * fixpoint, asserts the full conflict-resolution battery, and adopts the healed
 * project as the live state. The corruption therefore operates on
 * freshly-deserialized Vertex / Anchor / Feature instances, not the original
 * in-memory ones — a path no earlier corrupt→repair test reaches.
 */
class SaveLoadThenCorruptStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly tag: CorruptionTag, private readonly pick: number) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    // 1. save→load must be identity on the current live state.
    const reloaded = deserialize(serialize(r.project));
    if (!projectsEqual(reloaded, r.project)) {
      throw new Error('[stateful] save→load was not identity before corruption');
    }
    // 2. Corrupt + repair the RELOADED graph (rebuilt instances).
    const healed = corruptThenRepairStep(reloaded, this.tag, this.pick);
    if (healed === null) {
      // Corruption inapplicable to this reloaded shape — still adopt the reloaded
      // copy (a real session continues from the loaded project).
      r.project = reloaded;
      return;
    }
    // 3. The healed reloaded project must satisfy the full per-edit battery.
    const check = checkAllInvariants(healed);
    if (!check.ok) {
      throw new Error(
        `[stateful] healed RELOADED project failed invariant "${check.failed}" for "${this.tag}"`,
      );
    }
    r.project = healed;
  }
  toString(): string {
    return `save→load→corrupt→repair(${this.tag})`;
  }
}

/** A stateful command: one STRUCTURAL edit, THEN save→load, asserting identity on the rebuilt graph. */
class StructThenSaveLoadStatefulCmd implements fc.Command<ProjectModel, ProjectReal> {
  constructor(private readonly cmd: StructCmd) {}
  check(): boolean {
    return true;
  }
  run(_m: ProjectModel, r: ProjectReal): void {
    r.project = applyStructCmd(r.project, this.cmd).project;
    const check = checkAllInvariants(r.project);
    if (!check.ok) {
      throw new Error(
        `[stateful] invariant "${check.failed}" broke after struct ${JSON.stringify(this.cmd)}`,
      );
    }
    // Immediately save→load the structurally-edited project (a changed ring/line
    // cardinality must round-trip), and adopt the rebuilt copy as the live state.
    const reloaded = deserialize(serialize(r.project));
    if (!projectsEqual(reloaded, r.project)) {
      throw new Error(`[stateful] struct→save→load ≠ identity after ${JSON.stringify(this.cmd)}`);
    }
    r.project = reloaded;
  }
  toString(): string {
    return `struct→save→load(${this.cmd.tag})`;
  }
}

const saveLoadCorruptCmdArb: fc.Arbitrary<SaveLoadThenCorruptStatefulCmd> = fc
  .record({ tag: corruptionArb, pick: fc.nat() })
  .map(({ tag, pick }) => new SaveLoadThenCorruptStatefulCmd(tag, pick));

describe('bug hunt #3 / SIXTH exploration (seed 36004) — corrupt a RELOADED graph + arity-4', () => {
  it('a stateful interleaving of edit / struct→save→load / undo / save→load→corrupt→repair holds every law', () => {
    const allCommands = fc.commands(
      [
        cmdArb().map((c) => new EditStatefulCmd(c)),
        structCmdArb().map((c) => new StructThenSaveLoadStatefulCmd(c)),
        fc.constant(new SaveLoadStatefulCmd()),
        cmdArb().map((c) => new UndoOpStatefulCmd(c)),
        saveLoadCorruptCmdArb,
      ],
      { maxCommands: 30 },
    );
    fc.assert(
      // projectArb2() so STRUCTURAL edits (line/leaf vertex ops) have material to work on.
      fc.property(projectArb2(), allCommands, (initial, cmds) => {
        const base = checkBaseInvariants(initial);
        if (!base.ok) throw new Error(`stateful base invalid: ${base.failed}`);
        const setup = (): { model: ProjectModel; real: ProjectReal } => ({
          model: { historyCount: initial.histories.length },
          real: { project: initial },
        });
        fc.modelRun(setup, cmds);
      }),
      { seed: SEED9, numRuns: 350 },
    );
  });

  it('QUADRUPLE corruption injected together still repairs to a clean, round-tripping, HONEST fixpoint', () => {
    fc.assert(
      fc.property(
        projectArbMixed(),
        corruptionArb,
        corruptionArb,
        corruptionArb,
        corruptionArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (project, tagA, tagB, tagC, tagD, pickA, pickB, pickC, pickD) => {
          const injA = corrupt(project, tagA, pickA);
          if (injA === null) return;
          // Non-vacuity guard: the FIRST corruption alone must be detected (the test
          // is never a silent no-op — at least one real corruption is present).
          if (checkConsistency(injA.project, CAL).ok) {
            throw new Error(`first corruption (${tagA}) alone was NOT detected — invalid precondition`);
          }
          // Stack B, C, D. As in the dual/triple cases, a later injection can
          // legitimately OVERWRITE the structure an earlier one relied on; we require
          // only that whatever the COMBINED project is, the safe-repair fixpoint
          // reaches a clean, round-tripping, HONEST result.
          const injB = corrupt(injA.project, tagB, pickB);
          const afterB = injB === null ? injA.project : injB.project;
          const injC = corrupt(afterB, tagC, pickC);
          const afterC = injC === null ? afterB : injC.project;
          const injD = corrupt(afterC, tagD, pickD);
          const target = injD === null ? afterC : injD.project;

          const fix = repairToFixpoint(target);
          const combo = `${tagA}+${tagB}+${tagC}+${tagD}`;
          if (fix.honestyViolated) {
            throw new Error(`quadruple corruption (${combo}) repair was DISHONEST (resolved while unsafe)`);
          }
          if (!fix.converged) {
            throw new Error(`quadruple corruption (${combo}) did NOT converge (stuck=${fix.stuck})`);
          }
          const finalReport = checkConsistency(fix.project, CAL);
          if (!finalReport.ok) {
            throw new Error(
              `post-quadruple-repair still inconsistent (${combo}): ${finalReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rt = boundaryRoundTrips(fix.project);
          if (!rt.ok) {
            throw new Error(`quadruple-repaired project failed boundary round-trip (${rt.reason}) for ${combo}`);
          }
        },
      ),
      { seed: SEED9, numRuns: 1000 },
    );
  });

  it('HEAL → EDIT → RE-HEAL: a healed project stays consistent through an edit walk and a SECOND corruption', () => {
    fc.assert(
      fc.property(
        projectArb(),
        corruptionArb,
        fc.nat(),
        fc.array(nonGeometricCmdArb(), { maxLength: 10 }),
        corruptionArb,
        fc.nat(),
        (project, tag1, pick1, editCmds, tag2, pick2) => {
          // 1. First corrupt → repair to a clean fixpoint.
          const inj1 = corrupt(project, tag1, pick1);
          if (inj1 === null) return; // inapplicable — skip.
          const fix1 = repairToFixpoint(inj1.project);
          if (fix1.honestyViolated) {
            throw new Error(`first repair DISHONEST for "${tag1}"`);
          }
          if (!fix1.converged) return; // convergence covered by Section 2; only continue from a clean heal.
          const healed = fix1.project;
          if (!checkConsistency(healed, CAL).ok) {
            throw new Error(`post-repair-1 project NOT clean for "${tag1}"`);
          }

          // 2. Apply a GEOMETRY-PRESERVING edit walk to the HEALED project (a user
          //    keeps editing a once-repaired file). These edits must NOT introduce a
          //    new inconsistency (geometry-preserving subset, see nonGeometricCmdArb),
          //    and the project must round-trip after EACH step.
          let edited = healed;
          for (const c of editCmds) {
            edited = applyCmd(edited, c);
            const check = checkAllInvariants(edited);
            if (!check.ok) {
              throw new Error(`invariant "${check.failed}" broke editing a HEALED project after ${JSON.stringify(c)}`);
            }
          }
          const editedReport = checkConsistency(edited, CAL);
          if (!editedReport.ok) {
            throw new Error(
              `editing a HEALED project produced an inconsistency (${tag1}→edit): ${editedReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rtEdited = boundaryRoundTrips(edited);
          if (!rtEdited.ok) {
            throw new Error(`healed-then-edited project failed boundary round-trip (${rtEdited.reason})`);
          }

          // 3. Corrupt the healed-and-edited project a SECOND time and re-repair.
          const inj2 = corrupt(edited, tag2, pick2);
          if (inj2 === null) return; // second corruption inapplicable to this edited shape — skip.
          const report2 = checkConsistency(inj2.project, CAL);
          if (report2.ok) {
            throw new Error(`second corruption "${tag2}" on a healed-then-edited project was NOT detected`);
          }
          const fix2 = repairToFixpoint(inj2.project);
          if (fix2.honestyViolated) {
            throw new Error(`second repair DISHONEST for "${tag1}→edit→${tag2}"`);
          }
          if (!fix2.converged) {
            throw new Error(`second repair did NOT converge for "${tag1}→edit→${tag2}" (stuck=${fix2.stuck})`);
          }
          const finalReport = checkConsistency(fix2.project, CAL);
          if (!finalReport.ok) {
            throw new Error(
              `post-re-heal project still inconsistent (${tag1}→edit→${tag2}): ${finalReport.inconsistencies
                .map((i) => i.kind)
                .join(', ')}`,
            );
          }
          const rt2 = boundaryRoundTrips(fix2.project);
          if (!rt2.ok) {
            throw new Error(`re-healed project failed boundary round-trip (${rt2.reason}) for "${tag1}→edit→${tag2}"`);
          }
        },
      ),
      { seed: SEED9, numRuns: 900 },
    );
  });
});
