// HB3-10 property suite — the conflict-resolution vertex WELD, over the LIVE U13
// binding (`createLiveAddBinding` → orchestrator → U06 difference write-back).
//
// The concrete cases in `consistency-binding.test.tsx` pin specific geometries; this
// suite asserts the INVARIANTS hold for a whole family of overlapping rectangle
// pairs, so a weld rule that happens to work for one hand-picked square cannot pass:
//
//   (W1) WELD COMPLETENESS — every vertex of the trimmed adjust feature whose
//        coordinate key matches a PRIORITY vertex cites that priority's VertexId
//        (never a coincident-but-independent fresh id). This is the requirement.
//   (W2) NO DANGLING REFERENCE — every id the trimmed feature cites resolves to a
//        body in its OWN history snapshot store (教訓 5.31; `pruneVertexStore`
//        silently drops body-less ids and `resolveLeafShape` then yields undefined,
//        making the whole feature invisible — the single largest risk of welding).
//   (W3) FR-32 PARTICIPATION — no ring cites the same VertexId twice.
//   (W4) FR-106 — the resolved project is load-clean (`checkConsistency.ok`).
//   (W5) FR-94 — ONE composite command whose undo restores the baseline exactly.
//
// It lives under src/ui (not src/domain/__bughunt__) because it drives the LIVE
// binding, and the domain layer may not import ui (eslint import/no-restricted-paths).
// The `.test.tsx` extension puts it in the jsdom pool with its sibling binding test;
// nothing here touches the DOM.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createLiveAddBinding, type DomainRoot } from './consistency-binding';
import { featureByIdAt, featuresAt, verticesAt } from './live-lookup';
import { sharedVertexIdsOf } from './map/shared-vertex-derivation';
import { createEditProposal, PROCESS_STATUS } from '../domain/consistency/index';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createLeafFeature, referencedVertexIds, type LeafFeature } from '../domain/feature';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, getVertex, type Vertex } from '../domain/vertex';
import { vertexCoordKey } from '../domain/vertex-weld';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../domain/ids';
import { createGeoParams } from '../domain/geo/geo-params';
import { checkConsistency } from '../domain/persistence/consistency';
import { isCompositeCommand, type Command } from '../domain/command/index';
import { getCalendar } from '../domain/time/calendar';
import { resolveAt } from '../domain/anchor-series';
import { timePointYear } from '../domain/time/time-point';
import type { AddSnapshot } from '../domain/add/index';

const NUM_RUNS = 120;
const T = timePointYear(1000);
const gregorian = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainRoot {
  return {
    histories: [],
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

function rectLeaf(
  idRaw: string,
  vPrefix: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners: readonly (readonly [number, number])[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

const addSnapshot = (feature: LeafFeature, vertices: Vertex[]): AddSnapshot => ({
  feature,
  vertices,
  sharedCandidateIds: new Map(),
});

/**
 * One generated scenario: seed the PRIORITY rectangle, propose the ADJUST rectangle,
 * resolve the conflict with the priority winning, and return the committed root.
 * `undefined` means the geometry did not produce a resolvable conflict (the caller
 * skips — a non-overlap or a fully-covered adjust is not a weld scenario).
 */
interface Scenario {
  readonly root: DomainRoot;
  readonly baseline: DomainRoot;
  readonly command: Command<DomainRoot>;
}

function runScenario(adjust: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): Scenario | undefined {
  let root = emptyProject();
  let n = 0;
  const binding = createLiveAddBinding({
    getRoot: () => root,
    nextVertexId: () => asVertexId(`rv-${(n += 1)}`),
    nextRingId: () => asRingId(`rr-${(n += 1)}`),
  });

  // The PRIORITY is always the unit-scale rectangle [0,4]×[0,4]; the generator
  // varies the ADJUST around it, which covers every incidence class (corner-exact,
  // edge-exact, strictly-interior, straddling) without a second free rectangle.
  const p = rectLeaf('f-p', 'vp', 0, 0, 4, 4);
  const seeded = binding.startProcess(
    createEditProposal(p.feature.id, T, addSnapshot(p.feature, p.vertices)),
  );
  if (seeded.status !== PROCESS_STATUS.Committed) return undefined;
  root = seeded.state;

  const a = rectLeaf('f-a', 'va', adjust.x0, adjust.y0, adjust.x1, adjust.y1);
  const proposal = createEditProposal(a.feature.id, T, addSnapshot(a.feature, a.vertices));
  const pending = binding.startProcess(proposal);
  if (pending.status !== PROCESS_STATUS.ConflictsPending) return undefined;

  // An INDEPENDENT structural snapshot (a distinct object graph, NOT the reference
  // the command captures) of the pre-resolution root, taken BEFORE applying the
  // resolutions. It makes the FR-94 undo assertion a genuine DEEP comparison rather
  // than the tautology of comparing the command's captured baseline to itself
  // (LOW-3): an undo that failed to restore the exact pre-resolution project — or a
  // resolution that mutated the baseline in place — is now observable.
  const baseline = structuredClone(root);
  const committed = binding.applyResolutionsFor(proposal)(
    pending.conflicts.map((conflict) => ({
      conflictId: conflict.id,
      priorityFeatureId: p.feature.id,
      adjustFeatureId: a.feature.id,
    })),
  );
  if (committed.status !== PROCESS_STATUS.Committed) return undefined;
  return {
    root: committed.command.execute(root).state,
    baseline,
    command: committed.command,
  };
}

/** The vertex bodies a feature's own history snapshot carries at `time`. */
function ownSnapshotVertexIds(root: DomainRoot, featureId: string): Set<VertexId> {
  const history = root.histories.find((h) => String(h.featureId) === featureId);
  if (history === undefined) return new Set();
  const at = resolveAt(history.series, T, gregorian);
  if (at.kind !== 'present') return new Set();
  return new Set(at.entry.anchor.snapshot.vertices.byId.keys());
}

describe('HB3-10 property — conflict-resolution weld invariants over overlapping rectangles', () => {
  // Integer-ish coordinates on a coarse lattice keep every generated rectangle a
  // valid positive-area leaf while still covering corner-exact / edge-exact /
  // interior incidences against the fixed [0,4]² priority. Halves are included so
  // an adjust edge can land strictly BETWEEN two priority vertices (the "weld
  // nothing" class), not only on them.
  const lattice = fc.constantFrom(-2, -1, 0, 1, 1.5, 2, 2.5, 3, 4, 5, 6);

  const adjustRect = fc
    .tuple(lattice, lattice, lattice, lattice)
    .map(([ax, ay, bx, by]) => ({
      x0: Math.min(ax, bx),
      y0: Math.min(ay, by),
      x1: Math.max(ax, bx),
      y1: Math.max(ay, by),
    }))
    .filter((r) => r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1);

  it('welds every coincident boundary vertex onto the priority, with no dangling refs', () => {
    let exercised = 0;
    fc.assert(
      fc.property(adjustRect, (adjust) => {
        const outcome = runScenario(adjust);
        if (outcome === undefined) return; // not a resolvable-conflict geometry
        exercised += 1;
        const { root, baseline, command } = outcome;

        const priority = featureByIdAt(root, T, asFeatureId('f-p'));
        const trimmed = featureByIdAt(root, T, asFeatureId('f-a'));
        expect(priority?.kind).toBe('leaf');
        expect(trimmed?.kind).toBe('leaf');
        if (priority?.kind !== 'leaf' || trimmed?.kind !== 'leaf') return;

        const store = verticesAt(root, T);
        // coordinate key → the PRIORITY vertex id living there.
        const priorityByKey = new Map<string, VertexId>();
        for (const id of referencedVertexIds(priority)) {
          const body = getVertex(store, id);
          if (body !== undefined) priorityByKey.set(vertexCoordKey(body.coordinate), id);
        }

        const ownIds = ownSnapshotVertexIds(root, 'f-a');
        for (const ring of trimmed.shape.rings) {
          // (W3) FR-32: no ring cites the same vertex twice.
          expect(new Set(ring.vertexIds).size).toBe(ring.vertexIds.length);
          for (const id of ring.vertexIds) {
            // (W2) the id resolves to a body in the feature's OWN snapshot store.
            expect(ownIds.has(id)).toBe(true);
            const body = getVertex(store, id);
            expect(body).toBeDefined();
            if (body === undefined) continue;
            // (W1) a coordinate that coincides with a priority vertex MUST be that
            // priority vertex — a fresh id at the same place is the HB3-10 defect.
            const expected = priorityByKey.get(vertexCoordKey(body.coordinate));
            if (expected !== undefined) expect(id).toBe(expected);
          }
        }

        // The PRIORITY is never rewritten by its own resolution.
        expect(referencedVertexIds(priority).map(String).sort()).toEqual([
          'vp-0',
          'vp-1',
          'vp-2',
          'vp-3',
        ]);

        // (W4) FR-106: load-clean. (W5) FR-94: one composite, undo restores exactly.
        expect(checkConsistency(root, gregorian).inconsistencies).toEqual([]);
        expect(isCompositeCommand(command)).toBe(true);
        expect(command.undo(root).state).toEqual(baseline);
      }),
      { numRuns: NUM_RUNS },
    );
    // Guard against a vacuous green: the filter must not have skipped everything.
    expect(exercised).toBeGreaterThan(0);
  });

  it('derived sharing (FR-30/31) is exactly the set of welded ids — never a third feature', () => {
    let withSharing = 0;
    fc.assert(
      fc.property(adjustRect, (adjust) => {
        const outcome = runScenario(adjust);
        if (outcome === undefined) return;
        const { root } = outcome;
        const trimmed = featureByIdAt(root, T, asFeatureId('f-a'));
        if (trimmed?.kind !== 'leaf') return;

        const shared = sharedVertexIdsOf(verticesAt(root, T), featuresAt(root, T));
        const trimmedIds = new Set(referencedVertexIds(trimmed).map(String));
        for (const id of shared) {
          // Every shared id is a PRIORITY vertex the trimmed feature now also cites:
          // welding may only ever link the two conflict participants (no third party,
          // and no self-sharing between two rings of the trimmed feature here).
          expect(String(id)).toMatch(/^vp-/);
          expect(trimmedIds.has(String(id))).toBe(true);
        }
        if (shared.size > 0) withSharing += 1;
      }),
      { numRuns: NUM_RUNS },
    );
    // The corner-exact class must actually occur, or the property proves nothing.
    expect(withSharing).toBeGreaterThan(0);
  });
});
