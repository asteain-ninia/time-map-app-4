// REGRESSION (bug-hunt): ring-hierarchy validation must be wired into load-time
// consistency, and the schema must reject duplicate ring ids.
//
// Two confirmed defects this file pins:
//   1. checkConsistency never ran validateRingHierarchy per leaf. A leaf whose
//      hole ring's parentRingId points at NO existing territory ring is silently
//      dropped by resolveLeafShape (bucketed under a parent id no territory
//      carries → never emitted), so the feature loaded as a hole-free /
//      partially-invisible area and the report said nothing. checkConsistency must
//      now flag it as RingHierarchyInvalid, and the repair must resolve it.
//   2. shapeSchema accepted duplicate ring ids, collapsing the ring index
//      last-write-wins before any check could see it. The schema must reject it at
//      the structural boundary.
//
// These tests are a permanent asset; they must NOT be relaxed to paint over a
// real defect.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  INCONSISTENCY,
  applyRepairChecked,
  checkConsistency,
  repairOptionsFor,
  type DomainProject,
  type Inconsistency,
} from './index';
import { shapeSchema } from './schema';
import {
  CAL,
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
  squareVertices,
} from './fixtures';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature } from '../feature';
import { asFeatureId, asRingId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing } from '../ring';
import { createVertexStore } from '../vertex';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

function find(report: { inconsistencies: readonly Inconsistency[] }, kind: string) {
  return report.inconsistencies.find((i) => i.kind === kind);
}

/**
 * A leaf whose single hole ring's parentRingId references a ring id that does NOT
 * exist in the shape (orphan hole). Structurally this is a perfectly legal
 * persisted shape (a hole carries a parentRingId string); the alternation +
 * resolveLeafShape drop only manifest at runtime. The vertex store is complete so
 * the MissingVertexReference check does NOT fire — the ONLY thing that can catch
 * this is the ring-hierarchy check.
 */
function projectWithOrphanHole(): DomainProject {
  const outer = squareVertices('oh-outer', 0, 0, 30);
  const hole = squareVertices('oh-hole', 10, 10, 5);

  const outerRing = createTerritoryRing(
    asRingId('oh-r-outer'),
    outer.map((v) => v.id),
  );
  // parentRingId points at a ring id that is absent from the shape.
  const orphanHole = createHoleRing(
    asRingId('oh-r-hole'),
    hole.map((v) => v.id),
    asRingId('oh-r-NONEXISTENT'),
  );
  const feature = createLeafFeature(
    asFeatureId('oh-1'),
    createBasicAttributes('孤児穴国', 0, 100),
    COLOR,
    createShape([outerRing, orphanHole]),
  );
  const verts = createVertexStore([...outer, ...hole]);
  return {
    histories: [singleAnchorHistory('oh-1', [feature], verts)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('load-time consistency wires ring-hierarchy validation (bug-hunt regression)', () => {
  it('flags a leaf whose hole parentRingId names no existing ring', () => {
    const report = checkConsistency(projectWithOrphanHole(), CAL);
    const inc = find(report, INCONSISTENCY.RingHierarchyInvalid);
    expect(inc).toBeDefined();
    expect(inc!.featureIds).toContain('oh-1');
    expect(inc!.atTime).toBeDefined();
    // The sub-cause is the dangling parent ring reference.
    expect(inc!.detail).toBe('dangling-parent');
  });

  it('offers a repair that resolves it and re-validates clean', () => {
    const project = projectWithOrphanHole();
    const inc = find(checkConsistency(project, CAL), INCONSISTENCY.RingHierarchyInvalid)!;
    const options = repairOptionsFor(inc);
    expect(options.length).toBeGreaterThan(0);
    const applied = applyRepairChecked(project, inc, options[0]!.id, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.ok).toBe(true);
  });

  it('does NOT flag a structurally + geometrically valid holed leaf (no over-detection)', () => {
    const outer = squareVertices('vh-outer', 0, 0, 30);
    const hole = squareVertices('vh-hole', 10, 10, 8);
    const outerRing = createTerritoryRing(
      asRingId('vh-r-outer'),
      outer.map((v) => v.id),
    );
    const holeRing = createHoleRing(
      asRingId('vh-r-hole'),
      hole.map((v) => v.id),
      asRingId('vh-r-outer'),
    );
    const feature = createLeafFeature(
      asFeatureId('vh-1'),
      createBasicAttributes('正常穴国', 0, 100),
      COLOR,
      createShape([outerRing, holeRing]),
    );
    const verts = createVertexStore([...outer, ...hole]);
    const project: DomainProject = {
      histories: [singleAnchorHistory('vh-1', [feature], verts)],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const report = checkConsistency(project, CAL);
    expect(find(report, INCONSISTENCY.RingHierarchyInvalid)).toBeUndefined();
  });
});

describe('schema rejects duplicate ring ids (bug-hunt regression)', () => {
  it('rejects a shape with two rings sharing one id', () => {
    const dup = {
      rings: [
        { kind: 'territory', id: 'dup', vertexIds: ['a', 'b', 'c'] },
        { kind: 'territory', id: 'dup', vertexIds: ['d', 'e', 'f'] },
      ],
    };
    const parsed = shapeSchema.safeParse(dup);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'rings.1.id')).toBe(true);
    }
  });

  it('accepts a shape whose ring ids are all distinct', () => {
    const ok = {
      rings: [
        { kind: 'territory', id: 'r0', vertexIds: ['a', 'b', 'c'] },
        { kind: 'hole', id: 'r1', vertexIds: ['d', 'e', 'f'], parentRingId: 'r0' },
      ],
    };
    expect(shapeSchema.safeParse(ok).success).toBe(true);
  });

  it('property: any shape with a repeated ring id is rejected', () => {
    const ringIdArb = fc.constantFrom('r0', 'r1', 'r2', 'r3');
    fc.assert(
      fc.property(fc.array(ringIdArb, { minLength: 1, maxLength: 8 }), (ids) => {
        const shape = {
          rings: ids.map((id) => ({
            kind: 'territory' as const,
            id,
            vertexIds: ['a', 'b', 'c'],
          })),
        };
        const hasDup = new Set(ids).size !== ids.length;
        expect(shapeSchema.safeParse(shape).success).toBe(!hasDup);
      }),
      { seed: 4242, numRuns: 300 },
    );
  });
});
