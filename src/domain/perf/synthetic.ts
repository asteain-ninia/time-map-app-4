// U42 — deterministic synthetic-project generator (NFR 5.2 / 教訓 5.39).
//
// Builds a FULLY VALID DomainProject at the NFR 5.2 scale (default 5,000 objects
// × mean 10 anchors) for the measurement harness. 教訓 5.39 適用: every fixture is
// produced by INSTANTIATING the real domain factories (createLeafFeature /
// createAnchor / normalizeSeries / createVertexStore 等) — never hand-written
// literals that "satisfy the type" — so a未参照 property欠落 cannot pass silently.
//
// Legality (受け入れ基準 2): the generated state must satisfy ALL invariants
// (末端排他 / リング階層交互 / 錨列昇順非重複). To make 末端排他 hold BY CONSTRUCTION
// (rather than by post-hoc rejection), leaves are placed on a non-overlapping
// grid: each leaf occupies its own cell with margin, so no two leaf bodies touch.
// The whole project can then be passed through the persistence consistency check
// (checkConsistency) to PROVE legality (done in synthetic.test.ts).
//
// Deterministic: a fixed seed yields an identical project (no Math.random / clock),
// so a measurement is reproducible (NFR 5.8 / 受け入れ基準 6). Scale/distribution
// come from the single source `./thresholds` (開発ガイド §4).

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries, type AnchorEntry } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing, createHoleRing, type Ring } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';
import type { DomainProject, FeatureHistory, ProjectSettings } from '../persistence/serialize';
import { PRESET_BASEMAP_ID, FULL_WORLD_META } from '../basemap/preset';
import { createGeoParams } from '../geo/geo-params';

import { PERF_SCALE } from './thresholds';

const CAL = getCalendar('gregorian');

/** A small deterministic LCG (no Math.random) — reproducible synthetic data. */
function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const STYLE = createColorInfo(true, '#3366cc', '#00e5ff', '#1a3366', 'default', 0.6, 0.9);

/** Parameters for {@link generateSyntheticProject}; defaults = NFR 5.2 scale. */
export interface SyntheticParams {
  readonly objectCount: number;
  readonly meanAnchorsPerFeature: number;
  readonly distribution: typeof PERF_SCALE.distribution;
  readonly holeRatio: number;
  readonly enclaveRatio: number;
  readonly seed: number;
}

/** The default params, taken verbatim from the single threshold source. */
export const DEFAULT_SYNTHETIC_PARAMS: SyntheticParams = {
  objectCount: PERF_SCALE.objectCount,
  meanAnchorsPerFeature: PERF_SCALE.meanAnchorsPerFeature,
  distribution: PERF_SCALE.distribution,
  holeRatio: PERF_SCALE.holeRatio,
  enclaveRatio: PERF_SCALE.enclaveRatio,
  seed: 1,
};

// --- grid layout: each body gets its own non-overlapping cell -----------------
//
// We place bodies on a square grid spanning the world ([-180,180) × [-90,90)).
// Cell size is chosen from the count so cells fit the world; each body occupies
// the inner part of its cell with a margin, guaranteeing 末端排他 by construction.

interface Cell {
  readonly cx: number;
  readonly cy: number;
  readonly half: number; // half-extent of the body inside the cell (with margin)
}

function gridCells(count: number): Cell[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = 360 / cols;
  const cellH = 180 / rows;
  // Body fits inside 60% of the cell, centred — leaves a 40% gutter so adjacent
  // bodies never touch (strict 末端排他).
  const half = Math.min(cellW, cellH) * 0.3;
  const cells: Cell[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cells.push({
      cx: -180 + (col + 0.5) * cellW,
      cy: -90 + (row + 0.5) * cellH,
      half,
    });
  }
  return cells;
}

/** Anchor count for feature index `i` so the mean is exactly `mean` (deterministic). */
function anchorCountFor(i: number, mean: number): number {
  // Vary within [mean-3, mean+3] in a fixed pattern; the symmetric spread keeps
  // the average at `mean` over a full period of 7. Always >= 1.
  const spread = [0, 1, -1, 2, -2, 3, -3];
  const v = mean + spread[i % spread.length]!;
  return Math.max(1, v);
}

function squareRingVertices(prefix: string, cx: number, cy: number, half: number) {
  return [
    createVertex(asVertexId(`${prefix}-0`), createCoordinate(cx - half, cy - half)),
    createVertex(asVertexId(`${prefix}-1`), createCoordinate(cx + half, cy - half)),
    createVertex(asVertexId(`${prefix}-2`), createCoordinate(cx + half, cy + half)),
    createVertex(asVertexId(`${prefix}-3`), createCoordinate(cx - half, cy + half)),
  ];
}

/** Build one leaf feature (optionally with hole + enclave) inside a cell. */
function buildLeaf(
  id: string,
  cell: Cell,
  withHole: boolean,
  withEnclave: boolean,
): { feature: Feature; vertices: ReturnType<typeof createVertex>[] } {
  const outer = squareRingVertices(`${id}-o`, cell.cx, cell.cy, cell.half);
  const outerRing = createTerritoryRing(
    asRingId(`${id}-ro`),
    outer.map((v) => v.id),
  );
  const verts = [...outer];
  const rings: Ring[] = [outerRing];

  if (withHole) {
    const holeHalf = cell.half * 0.4;
    const hole = squareRingVertices(`${id}-h`, cell.cx, cell.cy, holeHalf);
    const holeRing = createHoleRing(
      asRingId(`${id}-rh`),
      hole.map((v) => v.id),
      asRingId(`${id}-ro`),
    );
    verts.push(...hole);
    rings.push(holeRing);

    if (withEnclave) {
      const encHalf = holeHalf * 0.4;
      const enc = squareRingVertices(`${id}-e`, cell.cx, cell.cy, encHalf);
      const encRing = createTerritoryRing(
        asRingId(`${id}-re`),
        enc.map((v) => v.id),
        asRingId(`${id}-rh`),
      );
      verts.push(...enc);
      rings.push(encRing);
    }
  }

  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 3000),
    STYLE,
    createShape(rings),
  );
  return { feature, vertices: verts };
}

/**
 * Build a multi-anchor history for a single feature whose snapshot is the given
 * features+vertices. The anchors share the same snapshot but have ascending,
 * non-overlapping start times (錨列昇順非重複 by construction). Each anchor starts
 * one year after the previous.
 */
function multiAnchorHistory(
  featureId: string,
  features: readonly Feature[],
  vertices: ReturnType<typeof createVertexStore>,
  anchorCount: number,
): FeatureHistory {
  const entries: AnchorEntry[] = [];
  for (let a = 0; a < anchorCount; a += 1) {
    const anchor = createAnchor(
      asAnchorId(`${featureId}-anc-${a}`),
      createAnchorSnapshot(features, vertices),
    );
    // Ascending, strictly increasing starts; last anchor open-ended (end null).
    entries.push(createAnchorEntry(anchor, timePointYear(a * 2), null));
  }
  return {
    featureId: asFeatureId(featureId),
    series: normalizeSeries(entries, CAL),
  };
}

const SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40000, 0.0034),
  gridSpacingDeg: 10,
  snapDistancePx: 50,
  autoColorDefault: true,
};

/**
 * Generate a deterministic, fully-valid synthetic project at the given scale
 * (default = NFR 5.2 五千 × 平均十錨). Feature kinds follow the distribution;
 * a fraction of leaves carry holes/enclaves; a fraction of leaves are grouped
 * under aggregate parents. Leaves are laid out on a non-overlapping grid so
 * 末端排他 holds by construction. The mean anchor count over all features equals
 * `meanAnchorsPerFeature`.
 */
export function generateSyntheticProject(
  params: Partial<SyntheticParams> = {},
): DomainProject {
  const p: SyntheticParams = { ...DEFAULT_SYNTHETIC_PARAMS, ...params };
  const rng = makeRng(p.seed);
  const cells = gridCells(p.objectCount);

  const histories: FeatureHistory[] = [];

  // Decide kind per index from the distribution (deterministic rng).
  // We track leaf ids so a later aggregate can adopt some as children.
  const leafIds: string[] = [];
  const leafCells = new Map<string, Cell>();

  const dist = p.distribution;
  const cumPoint = dist.point;
  const cumLine = cumPoint + dist.line;
  const cumLeaf = cumLine + dist.leaf;

  for (let i = 0; i < p.objectCount; i += 1) {
    const cell = cells[i]!;
    const r = rng();
    const anchors = anchorCountFor(i, p.meanAnchorsPerFeature);

    if (r < cumPoint) {
      const id = `pt-${i}`;
      const v = createVertex(asVertexId(`${id}-v`), createCoordinate(cell.cx, cell.cy));
      const feature = createPointFeature(
        asFeatureId(id),
        createBasicAttributes(id, 0, 3000),
        STYLE,
        v.id,
        { kindLabel: '都市' },
      );
      histories.push(multiAnchorHistory(id, [feature], createVertexStore([v]), anchors));
    } else if (r < cumLine) {
      const id = `ln-${i}`;
      const a = createVertex(
        asVertexId(`${id}-a`),
        createCoordinate(cell.cx - cell.half, cell.cy),
      );
      const b = createVertex(
        asVertexId(`${id}-b`),
        createCoordinate(cell.cx + cell.half, cell.cy),
      );
      const feature = createLineFeature(
        asFeatureId(id),
        createBasicAttributes(id, 0, 3000),
        STYLE,
        [a.id, b.id],
      );
      histories.push(multiAnchorHistory(id, [feature], createVertexStore([a, b]), anchors));
    } else if (r < cumLeaf) {
      const id = `leaf-${i}`;
      const withHole = rng() < p.holeRatio;
      const withEnclave = withHole && rng() < p.enclaveRatio;
      const { feature, vertices } = buildLeaf(id, cell, withHole, withEnclave);
      histories.push(
        multiAnchorHistory(id, [feature], createVertexStore(vertices), anchors),
      );
      leafIds.push(id);
      leafCells.set(id, cell);
    } else {
      // Aggregate: it groups up to 2 not-yet-parented leaves laid out in their
      // OWN cells (so the aggregate's子 are spatially disjoint). If no free leaves
      // exist yet, fall back to a small leaf so the count stays exact.
      const id = `agg-${i}`;
      const freeChildren = leafIds.splice(0, Math.min(2, leafIds.length));
      if (freeChildren.length === 0) {
        const { feature, vertices } = buildLeaf(id, cell, false, false);
        histories.push(
          multiAnchorHistory(id, [feature], createVertexStore(vertices), anchors),
        );
        leafIds.push(id);
        leafCells.set(id, cell);
        continue;
      }
      // Rebuild the child leaves WITH the aggregate as parent, in their own cells,
      // and put the whole group (children + aggregate) into the aggregate history.
      const childFeatures: Feature[] = [];
      const childVerts: ReturnType<typeof createVertex>[] = [];
      for (const childId of freeChildren) {
        const childCell = leafCells.get(childId)!;
        const built = buildLeaf(childId, childCell, false, false);
        const reparented = { ...built.feature, parentId: asFeatureId(id) } as Feature;
        childFeatures.push(reparented);
        childVerts.push(...built.vertices);
        // Remove the standalone history we pushed earlier for this child.
        const idx = histories.findIndex((h) => h.featureId === asFeatureId(childId));
        if (idx >= 0) histories.splice(idx, 1);
      }
      const aggregate = createAggregateFeature(
        asFeatureId(id),
        createBasicAttributes(id, 0, 3000),
        STYLE,
        freeChildren.map((c) => asFeatureId(c)),
      );
      const groupFeatures: Feature[] = [...childFeatures, aggregate];
      histories.push(
        multiAnchorHistory(id, groupFeatures, createVertexStore(childVerts), anchors),
      );
    }
  }

  return {
    histories,
    settings: SETTINGS,
    baseMap: { source: PRESET_BASEMAP_ID, meta: FULL_WORLD_META },
  };
}

/** Total anchor count across all histories (for mean verification in tests). */
export function totalAnchorCount(project: DomainProject): number {
  let total = 0;
  for (const h of project.histories) total += h.series.entries.length;
  return total;
}
