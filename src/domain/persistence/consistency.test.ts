// U14 consistency-detection + auto-repair tests (受け入れ基準 4 / 5 / 6 / 10).

import { describe, expect, it } from 'vitest';

import {
  INCONSISTENCY,
  applyRepairChecked,
  checkConsistency,
  repairOptionsFor,
  type DomainProject,
  type FeatureHistory,
  type Inconsistency,
  type UiSettings,
} from './index';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  pointFeature,
  richValidProject,
  singleAnchorHistory,
  squareLeaf,
} from './fixtures';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

function find(report: { inconsistencies: readonly Inconsistency[] }, kind: string) {
  return report.inconsistencies.find((i) => i.kind === kind);
}

// --- 受け入れ基準6: a fully valid project reports nothing -------------------

describe('integrity — clean project (受け入れ基準6, 過剰検出なし)', () => {
  it('reports an empty consistency report for a rich valid project', () => {
    const report = checkConsistency(richValidProject(), CAL);
    if (!report.ok) {
      // Surface what tripped so a failure is diagnosable.
      throw new Error(
        `expected clean, got: ${report.inconsistencies.map((i) => `${i.kind}:${i.detail}`).join('; ')}`,
      );
    }
    expect(report.ok).toBe(true);
    expect(report.inconsistencies).toHaveLength(0);
  });
});

// --- (a) missing vertex reference -------------------------------------------

describe('(a) missing vertex reference', () => {
  function projectWithMissingVertex(): DomainProject {
    const leaf = squareLeaf('mv-leaf', '欠損国', 0, 0);
    // Store only 3 of the 4 vertices the ring references.
    const verts = createVertexStore(leaf.vertices.slice(0, 3));
    return {
      histories: [singleAnchorHistory('mv-leaf', [leaf.feature], verts)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects a feature referencing an absent vertex id', () => {
    const inc = find(checkConsistency(projectWithMissingVertex(), CAL), INCONSISTENCY.MissingVertexReference);
    expect(inc).toBeDefined();
    expect(inc!.featureIds).toContain('mv-leaf');
    expect(inc!.atTime).toBeDefined();
  });

  it('repair (drop feature) resolves it and re-validates clean', () => {
    const project = projectWithMissingVertex();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.MissingVertexReference)!;
    const options = repairOptionsFor(inc);
    expect(options.length).toBeGreaterThan(0);
    const applied = applyRepairChecked(project, inc, options[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.ok).toBe(true);
  });
});

// --- (b) tree topology (cycle) — 受け入れ基準10 ----------------------------

describe('(b) tree topology + cycle safety (受け入れ基準10, 教訓5.28)', () => {
  function projectWithCycle(): DomainProject {
    // Two features that parent each other (A→B→A).
    const a = createAggregateFeature(
      asFeatureId('cy-a'),
      createBasicAttributes('A', 0, 100),
      COLOR,
      [asFeatureId('cy-b')],
      { parentId: asFeatureId('cy-b') },
    );
    const b = createAggregateFeature(
      asFeatureId('cy-b'),
      createBasicAttributes('B', 0, 100),
      COLOR,
      [asFeatureId('cy-a')],
      { parentId: asFeatureId('cy-a') },
    );
    const anchor = createAnchor(
      asAnchorId('cy-anc'),
      createAnchorSnapshot([a, b], createVertexStore([])),
    );
    return {
      histories: [
        {
          featureId: asFeatureId('cy-a'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('reports a parent cycle in finite time (no infinite loop)', () => {
    const report = checkConsistency(projectWithCycle(), CAL);
    const inc = find(report, INCONSISTENCY.TreeTopology);
    expect(inc).toBeDefined();
    expect(inc!.detail).toBe('cycle');
  });

  it('detects a dangling parent reference', () => {
    const leaf = squareLeaf('dp-leaf', '孤児', 0, 0);
    const orphan = { ...leaf.feature, parentId: asFeatureId('ghost') } as Feature;
    const project: DomainProject = {
      histories: [singleAnchorHistory('dp-leaf', [orphan], createVertexStore(leaf.vertices))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TreeTopology);
    expect(inc).toBeDefined();
    expect(inc!.detail).toBe('dangling-parent');
  });

  it('repair (detach to top-level) clears a dangling parent', () => {
    const leaf = squareLeaf('dp2-leaf', '孤児', 0, 0);
    const orphan = { ...leaf.feature, parentId: asFeatureId('ghost') } as Feature;
    const project: DomainProject = {
      histories: [singleAnchorHistory('dp2-leaf', [orphan], createVertexStore(leaf.vertices))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TreeTopology)!;
    const applied = applyRepairChecked(project, inc, 'detach-to-top-level', CAL);
    expect(applied.resolved).toBe(true);
  });
});

// --- (c) shape-preservation rule -------------------------------------------

describe('(c) shape-preservation rule', () => {
  function projectWithEmptyLeaf(): DomainProject {
    const feature = createLeafFeature(
      asFeatureId('el-1'),
      createBasicAttributes('空形状', 0, 100),
      COLOR,
      createShape([]), // empty shape: a shapeless 末端地物 (violation).
    );
    return {
      histories: [singleAnchorHistory('el-1', [feature], createVertexStore([]))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects a leaf with an empty shape', () => {
    const inc = find(checkConsistency(projectWithEmptyLeaf(), CAL), INCONSISTENCY.ShapePreservation);
    expect(inc).toBeDefined();
    expect(inc!.detail).toBe('leaf-empty-shape');
  });

  it('detects a declared aggregate with no children', () => {
    const agg = createAggregateFeature(
      asFeatureId('ea-1'),
      createBasicAttributes('空集約', 0, 100),
      COLOR,
      [],
    );
    const project: DomainProject = {
      histories: [singleAnchorHistory('ea-1', [agg], createVertexStore([]))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.ShapePreservation);
    expect(inc).toBeDefined();
    expect(inc!.detail).toBe('aggregate-no-children');
  });

  it('repair (drop) resolves the empty-leaf violation', () => {
    const project = projectWithEmptyLeaf();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.ShapePreservation)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.ok).toBe(true);
  });
});

// --- (d) terminal exclusion + (g) anchor spatial overlap --------------------

describe('(d) terminal exclusion / (g) anchor spatial overlap', () => {
  function projectWithOverlap(): DomainProject {
    const a = squareLeaf('ov-a', '甲', 0, 0, 10);
    const b = squareLeaf('ov-b', '乙', 5, 0, 10); // overlaps甲 in [5,10]x[0,10].
    const verts = createVertexStore([...a.vertices, ...b.vertices]);
    const anchor = createAnchor(
      asAnchorId('ov-anc'),
      createAnchorSnapshot([a.feature, b.feature], verts),
    );
    return {
      histories: [
        {
          featureId: asFeatureId('ov-a'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects two overlapping 末端地物 (both kinds d and g)', () => {
    const report = checkConsistency(projectWithOverlap(), CAL);
    const d = find(report, INCONSISTENCY.TerminalExclusion);
    const g = find(report, INCONSISTENCY.AnchorSpatialOverlap);
    expect(d).toBeDefined();
    expect(g).toBeDefined();
    expect(d!.featureIds).toEqual(expect.arrayContaining(['ov-a', 'ov-b']));
  });

  it('repair (drop one) removes the overlap', () => {
    const project = projectWithOverlap();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TerminalExclusion)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
  });
});

// --- (e) aggregate = sum of children (inter-child gap) ----------------------

describe('(e) aggregate sum mismatch (受け入れ基準4 / 5)', () => {
  /** An axis-aligned rectangular leaf [x,x+w]×[y,y+h], parented to `parentId`. */
  function rectLeaf(
    id: string,
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    parentId: string,
  ): { feature: Feature; vertices: ReturnType<typeof createVertex>[] } {
    const corners = [
      createCoordinate(x, y),
      createCoordinate(x + w, y),
      createCoordinate(x + w, y + h),
      createCoordinate(x, y + h),
    ];
    const vertices = corners.map((c, i) => createVertex(asVertexId(`${id}-v${i}`), c));
    const ring = createTerritoryRing(
      asRingId(`${id}-r`),
      vertices.map((v) => v.id),
    );
    const feature = createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(name, 0, 100),
      COLOR,
      createShape([ring]),
      { parentId: asFeatureId(parentId) },
    );
    return { feature, vertices };
  }

  /**
   * An aggregate whose four direct children FRAME an empty interior square: the
   * children tile [0,30]×[0,30] except the [10,20]×[10,20] hole in the middle.
   * Their U06 union is a single piece with a hole ring not owned by any single
   * child — a genuine 隙間 (mirrors U08 hierarchy.test buildFrameWithHole). This
   * is the positive (e) case the previous test never exercised.
   */
  function projectWithInterChildGap(): DomainProject {
    const bottom = rectLeaf('g-fb', '下', 0, 0, 30, 10, 'g-agg'); // y[0,10]
    const top = rectLeaf('g-ft', '上', 0, 20, 30, 10, 'g-agg'); // y[20,30]
    const left = rectLeaf('g-fl', '左', 0, 10, 10, 10, 'g-agg'); // x[0,10], y[10,20]
    const right = rectLeaf('g-fr', '右', 20, 10, 10, 10, 'g-agg'); // x[20,30], y[10,20]
    const tiles = [bottom, top, left, right];
    const children = tiles.map((t) => t.feature);
    const agg = createAggregateFeature(
      asFeatureId('g-agg'),
      createBasicAttributes('枠連合', 0, 100),
      COLOR,
      children.map((c) => c.id),
    );
    const verts = createVertexStore(tiles.flatMap((t) => t.vertices));
    const anchor = createAnchor(
      asAnchorId('g-anc'),
      createAnchorSnapshot([...children, agg], verts),
    );
    return {
      histories: [
        {
          featureId: asFeatureId('g-agg'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects an inter-child gap (children frame an interior hole)', () => {
    const report = checkConsistency(projectWithInterChildGap(), CAL);
    const inc = find(report, INCONSISTENCY.AggregateSumMismatch);
    expect(inc).toBeDefined();
    // The violation names the aggregate (and its direct children).
    expect(inc!.featureIds).toContain('g-agg');
    expect(inc!.atTime).toBeDefined();
  });

  it('repair (drop aggregate, detach children) resolves it and re-validates clean', () => {
    const project = projectWithInterChildGap();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.AggregateSumMismatch)!;
    const options = repairOptionsFor(inc);
    expect(options.length).toBeGreaterThan(0);
    const applied = applyRepairChecked(project, inc, options[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.ok).toBe(true);
  });

  it('disjoint corner enclaves (飛び地) are NOT flagged (過剰検出なし)', () => {
    // Four disjoint corner squares with a void between them: separate pieces with
    // no enclosed hole are legal per U08 — the check must stay quiet (受け入れ基準6).
    const tl = squareLeaf('e-tl', '左上', 0, 20, 10);
    const tr = squareLeaf('e-tr', '右上', 20, 20, 10);
    const bl = squareLeaf('e-bl', '左下', 0, 0, 10);
    const br = squareLeaf('e-br', '右下', 20, 0, 10);
    const children: Feature[] = [tl, tr, bl, br].map(
      (c) => ({ ...c.feature, parentId: asFeatureId('e-agg') }) as Feature,
    );
    const agg = createAggregateFeature(
      asFeatureId('e-agg'),
      createBasicAttributes('飛び地連合', 0, 100),
      COLOR,
      children.map((c) => c.id),
    );
    const verts = createVertexStore([
      ...tl.vertices,
      ...tr.vertices,
      ...bl.vertices,
      ...br.vertices,
    ]);
    const anchor = createAnchor(
      asAnchorId('e-anc'),
      createAnchorSnapshot([...children, agg], verts),
    );
    const project: DomainProject = {
      histories: [
        {
          featureId: asFeatureId('e-agg'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.AggregateSumMismatch);
    expect(inc).toBeUndefined();
  });
});

// --- interval-END time slices (regression) ----------------------------------

describe('time-slice sweep inspects interval ENDs, not only starts (regression)', () => {
  /**
   * A parent leaf that exists in [0,150) and a child leaf that exists in [0,300)
   * naming the parent as its parentId. AFTER t=150 the parent is gone but the
   * child remains, so the child has a DANGLING parent in the [150,300) window —
   * a topology violation that only manifests at/after the parent's END. The old
   * sweep collected only START times (0) and never inspected the post-end window.
   */
  function projectWithPostEndDanglingParent(): DomainProject {
    const parent = squareLeaf('pe-parent', '親', 0, 0, 10);
    const childBase = squareLeaf('pe-child', '子', 50, 50, 10);
    const child = { ...childBase.feature, parentId: asFeatureId('pe-parent') } as Feature;

    const parentVerts = createVertexStore(parent.vertices);
    const childVerts = createVertexStore(childBase.vertices);

    const parentAnchor = createAnchor(
      asAnchorId('pe-parent-anc'),
      createAnchorSnapshot([parent.feature], parentVerts),
    );
    const childAnchor = createAnchor(
      asAnchorId('pe-child-anc'),
      createAnchorSnapshot([child], childVerts),
    );

    return {
      histories: [
        {
          featureId: asFeatureId('pe-parent'),
          // Parent existence STOPS at 150 (bounded end).
          series: { entries: [createAnchorEntry(parentAnchor, timePointYear(0), timePointYear(150))] },
        },
        {
          featureId: asFeatureId('pe-child'),
          // Child continues past 150 (open-ended).
          series: { entries: [createAnchorEntry(childAnchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects a dangling-parent state that only exists after the parent end time', () => {
    const report = checkConsistency(projectWithPostEndDanglingParent(), CAL);
    const dangling = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.TreeTopology && i.detail === 'dangling-parent',
    );
    expect(dangling).toBeDefined();
    // It is observed at the parent's END boundary (150), not only at start 0.
    expect(dangling!.atTime).toEqual(timePointYear(150));
  });
});

// --- (f) time conflict ------------------------------------------------------

describe('(f) time conflict', () => {
  function projectWithTimeConflict(): DomainProject {
    const pt = pointFeature('tc-pt', '都市', 10, 10);
    const snap = createAnchorSnapshot([pt.feature], createVertexStore([pt.vertex]));
    const a1 = createAnchor(asAnchorId('tc-a1'), snap);
    const a2 = createAnchor(asAnchorId('tc-a2'), snap);
    // Two entries with EQUAL start years (INV-1 violation: not strictly ascending).
    return {
      histories: [
        {
          featureId: asFeatureId('tc-pt'),
          series: {
            entries: [
              createAnchorEntry(a1, timePointYear(100), null),
              createAnchorEntry(a2, timePointYear(100), null),
            ],
          },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
  }

  it('detects a non-ascending anchor series', () => {
    const inc = find(checkConsistency(projectWithTimeConflict(), CAL), INCONSISTENCY.TimeConflict);
    expect(inc).toBeDefined();
    expect(inc!.detail).toBe('INV-1');
  });

  it('repair (normalize) resolves the conflict and never empties the series', () => {
    const project = projectWithTimeConflict();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TimeConflict)!;
    const applied = applyRepairChecked(project, inc, 'normalize-series', CAL);
    expect(applied.resolved).toBe(true);
    // 受け入れ基準5: a normalize repair never yields a 0-entry series.
    for (const h of applied.project.histories) {
      expect(h.series.entries.length).toBeGreaterThan(0);
    }
  });
});

// --- orphan / zombie history (owner feature absent from all snapshots) ------

describe('orphan history (zombie series, FR-106 拡張)', () => {
  // A history whose owner featureId is NOT carried by any of its snapshots.
  function projectWithOrphanHistory(): DomainProject {
    const leaf = squareLeaf('oh-real', '実在国', 0, 0);
    const real = singleAnchorHistory('oh-real', [leaf.feature], createVertexStore(leaf.vertices));
    // The orphan history's snapshot carries the REAL leaf, but its featureId is a
    // ghost that owns nothing in any snapshot — a zombie timeline.
    const orphanSnap = createAnchorSnapshot([leaf.feature], createVertexStore(leaf.vertices));
    const orphan: FeatureHistory = {
      featureId: asFeatureId('oh-ghost'),
      series: { entries: [createAnchorEntry(createAnchor(asAnchorId('oh-anc'), orphanSnap), timePointYear(0), null)] },
    };
    return { histories: [real, orphan], settings: DEFAULT_SETTINGS, baseMap: DEFAULT_BASEMAP };
  }

  it('detects a history whose owner feature is in no snapshot', () => {
    const inc = find(checkConsistency(projectWithOrphanHistory(), CAL), INCONSISTENCY.OrphanHistory);
    expect(inc).toBeDefined();
    expect(inc!.featureIds).toContain('oh-ghost');
    expect(inc!.detail).toBe('owner-feature-absent');
  });

  it('repair (drop orphan history) resolves it and re-validates clean', () => {
    const project = projectWithOrphanHistory();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.OrphanHistory)!;
    const options = repairOptionsFor(inc);
    expect(options.length).toBeGreaterThan(0);
    const applied = applyRepairChecked(project, inc, options[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.ok).toBe(true);
    // The real history survives; only the ghost is gone.
    expect(applied.project.histories.map((h) => h.featureId)).toEqual(['oh-real']);
  });

  it('dropping a feature also drops its owning history (no zombie left behind)', () => {
    // Two independent leaves, each its own history. Dropping leaf-a's feature must
    // also remove leaf-a's history so no orphan history is manufactured.
    const a = squareLeaf('dz-a', 'A国', 0, 0);
    const b = squareLeaf('dz-b', 'B国', 40, 0);
    const project: DomainProject = {
      histories: [
        singleAnchorHistory('dz-a', [a.feature], createVertexStore(a.vertices)),
        singleAnchorHistory('dz-b', [b.feature], createVertexStore(b.vertices)),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc: Inconsistency = {
      kind: INCONSISTENCY.MissingVertexReference,
      featureIds: [asFeatureId('dz-a')],
      featureNames: ['A国'],
    };
    const applied = applyRepairChecked(project, inc, 'drop-feature-missing-vertex', CAL);
    // The owning history is removed too — no orphan/zombie history remains.
    expect(applied.project.histories.map((h) => h.featureId)).toEqual(['dz-b']);
    expect(find(applied.remaining, INCONSISTENCY.OrphanHistory)).toBeUndefined();
  });
});

// --- uiSettings preservation across repair (bug-hunt regression) ------------

describe('repair preserves the optional uiSettings block (regression)', () => {
  // A fully-specified UI settings surface (FR-109 / FR-110), distinct from any
  // default so a drop-to-defaults regression is detectable. Carries a non-empty
  // custom palette, project name/description, zoom/timeline bounds, grid, and the
  // conflict-guide toggle — exactly the fields the buggy transforms silently lost.
  const UI: UiSettings = {
    project: {
      projectName: '帝国年代記',
      projectDescription: 'A test project with a full ui block.',
      equatorLengthKm: 40000,
      flattening: 0.0034,
      timelineMinYear: -500,
      timelineMaxYear: 2000,
      gridSpacingDeg: 15,
      gridColor: '#abcdef',
      gridOpacity: 0.42,
      baseMapId: '@preset/equirectangular-world',
      areaLabelOccupancyThreshold: 0.3,
      newAreaAutoColorDefault: false,
      defaultPaletteTheme: 'pastel',
      customPalette: ['#112233', '#445566'],
      zoomMin: 0.25,
      zoomMax: 8,
    },
    app: {
      snapDistancePx: 50,
      renderFps: 60,
      vertexMarkerCap: 500,
      showConflictGuide: false,
    },
  };

  /** Attach the UI block to a project. */
  function withUi(project: DomainProject): DomainProject {
    return { ...project, uiSettings: UI };
  }

  function expectUiPreserved(applied: { project: DomainProject }): void {
    // The whole block must survive verbatim — not be reset to undefined/defaults.
    expect(applied.project.uiSettings).toBeDefined();
    expect(applied.project.uiSettings).toEqual(UI);
    // And specifically the fields the bug stripped (named for diagnosability).
    expect(applied.project.uiSettings!.project.projectName).toBe('帝国年代記');
    expect(applied.project.uiSettings!.project.customPalette).toEqual(['#112233', '#445566']);
    expect(applied.project.uiSettings!.app.showConflictGuide).toBe(false);
  }

  it('survives a drop-feature repair (missing-vertex)', () => {
    const leaf = squareLeaf('uir-mv', '欠損国', 0, 0);
    const verts = createVertexStore(leaf.vertices.slice(0, 3));
    const project = withUi({
      histories: [singleAnchorHistory('uir-mv', [leaf.feature], verts)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    });
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.MissingVertexReference)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expectUiPreserved(applied);
  });

  it('survives a detach-to-top-level repair (dangling parent)', () => {
    const leaf = squareLeaf('uir-dp', '孤児', 0, 0);
    const orphan = { ...leaf.feature, parentId: asFeatureId('ghost') } as Feature;
    const project = withUi({
      histories: [singleAnchorHistory('uir-dp', [orphan], createVertexStore(leaf.vertices))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    });
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TreeTopology)!;
    const applied = applyRepairChecked(project, inc, 'detach-to-top-level', CAL);
    expect(applied.resolved).toBe(true);
    expectUiPreserved(applied);
  });

  it('survives a normalize-series repair (time conflict)', () => {
    const pt = pointFeature('uir-tc', '都市', 10, 10);
    const snap = createAnchorSnapshot([pt.feature], createVertexStore([pt.vertex]));
    const project = withUi({
      histories: [
        {
          featureId: asFeatureId('uir-tc'),
          series: {
            entries: [
              createAnchorEntry(createAnchor(asAnchorId('uir-tc-a1'), snap), timePointYear(100), null),
              createAnchorEntry(createAnchor(asAnchorId('uir-tc-a2'), snap), timePointYear(100), null),
            ],
          },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    });
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.TimeConflict)!;
    const applied = applyRepairChecked(project, inc, 'normalize-series', CAL);
    expect(applied.resolved).toBe(true);
    expectUiPreserved(applied);
  });

  it('survives a drop-orphan-history repair', () => {
    const leaf = squareLeaf('uir-oh', '実在国', 0, 0);
    const real = singleAnchorHistory('uir-oh', [leaf.feature], createVertexStore(leaf.vertices));
    const orphanSnap = createAnchorSnapshot([leaf.feature], createVertexStore(leaf.vertices));
    const orphan: FeatureHistory = {
      featureId: asFeatureId('uir-oh-ghost'),
      series: {
        entries: [
          createAnchorEntry(createAnchor(asAnchorId('uir-oh-anc'), orphanSnap), timePointYear(0), null),
        ],
      },
    };
    const project = withUi({
      histories: [real, orphan],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    });
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.OrphanHistory)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expectUiPreserved(applied);
  });

  it('survives a drop-aggregate repair (detach children + drop)', () => {
    // Reuse the inter-child-gap aggregate shape inline so the drop-aggregate path
    // (detachChildrenOf → dropFeatures, both fixed) is exercised with a ui block.
    const rect = (id: string, x: number, y: number, w: number, h: number) => {
      const corners = [
        createCoordinate(x, y),
        createCoordinate(x + w, y),
        createCoordinate(x + w, y + h),
        createCoordinate(x, y + h),
      ];
      const vertices = corners.map((c, i) => createVertex(asVertexId(`${id}-v${i}`), c));
      const ring = createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id));
      const feature = createLeafFeature(
        asFeatureId(id),
        createBasicAttributes(id, 0, 100),
        COLOR,
        createShape([ring]),
        { parentId: asFeatureId('uir-agg') },
      );
      return { feature, vertices };
    };
    const tiles = [
      rect('uir-fb', 0, 0, 30, 10),
      rect('uir-ft', 0, 20, 30, 10),
      rect('uir-fl', 0, 10, 10, 10),
      rect('uir-fr', 20, 10, 10, 10),
    ];
    const children = tiles.map((t) => t.feature);
    const agg = createAggregateFeature(
      asFeatureId('uir-agg'),
      createBasicAttributes('枠連合', 0, 100),
      COLOR,
      children.map((c) => c.id),
    );
    const verts = createVertexStore(tiles.flatMap((t) => t.vertices));
    const anchor = createAnchor(
      asAnchorId('uir-agg-anc'),
      createAnchorSnapshot([...children, agg], verts),
    );
    const project = withUi({
      histories: [
        {
          featureId: asFeatureId('uir-agg'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    });
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.AggregateSumMismatch)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expectUiPreserved(applied);
  });

  it('leaves a project WITHOUT uiSettings still without it (no spurious key)', () => {
    const leaf = squareLeaf('uir-none', '欠損国', 0, 0);
    const verts = createVertexStore(leaf.vertices.slice(0, 3));
    const project: DomainProject = {
      histories: [singleAnchorHistory('uir-none', [leaf.feature], verts)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.MissingVertexReference)!;
    const applied = applyRepairChecked(project, inc, repairOptionsFor(inc)[0]!.id, CAL);
    expect(applied.project.uiSettings).toBeUndefined();
  });
});

// --- repair purity ----------------------------------------------------------

describe('repair purity (教訓5.22)', () => {
  it('does not mutate the input project', () => {
    const project = richValidProject();
    const before = JSON.stringify(project.histories.map((h) => h.featureId));
    const inc: Inconsistency = {
      kind: INCONSISTENCY.MissingVertexReference,
      featureIds: [asFeatureId('agg-1')],
      featureNames: ['連邦'],
    };
    applyRepairChecked(project, inc, 'drop-feature-missing-vertex', CAL);
    const after = JSON.stringify(project.histories.map((h) => h.featureId));
    expect(after).toBe(before);
  });
});
