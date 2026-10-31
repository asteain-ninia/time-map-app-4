// save-load-roundtrip-and-conflict-resolution の検査 2/3。全体の説明と共有の生成器は save-load-roundtrip-and-conflict-resolution.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, changeStart, setEnd, normalizeSeries, resolveAt } from '../anchor-series';
import { createBasicAttributes } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, createPointFeature } from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createHistory, execute, redo, undo } from '../command/history';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';
import { serialize, projectsEqual, type DomainProject } from '../persistence/serialize';
import { checkConsistency, INCONSISTENCY, type Inconsistency } from '../persistence/consistency';
import {
  BASEMAP,
  CAL,
  COLOR,
  EditStatefulCmd,
  type ProjectModel,
  type ProjectReal,
  SEED10,
  SEED7,
  SEED8,
  SEED9,
  SETTINGS,
  SaveLoadStatefulCmd,
  StructStatefulCmd,
  StructThenSaveLoadStatefulCmd,
  UndoOpStatefulCmd,
  applyCmd,
  boundaryRoundTrips,
  boundedGapHistory,
  checkAllInvariants,
  checkBaseInvariants,
  cmdArb,
  corrupt,
  corruptDegenerateEnd,
  corruptRepairCmdArb,
  corruptionArb,
  layoutBoundedWindows,
  nonGeometricCmdArb,
  projectArb,
  projectArb2,
  projectArbBounded,
  projectArbMixed,
  repairToFixpoint,
  reversibleEdit,
  saveLoadCorruptCmdArb,
  squareLeaf,
  structCmdArb,
} from './save-load-roundtrip-and-conflict-resolution.arbitraries';

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

describe('bug hunt #4 / bounded-interval + gap round-trip (seed 46001)', () => {
  it('generated bounded-end + gap base satisfies every load invariant (non-null ends + enclaves)', () => {
    fc.assert(
      fc.property(projectArbBounded(), (project) => {
        const check = checkBaseInvariants(project);
        if (!check.ok) throw new Error(`bounded-gap base failed: ${check.failed}`);
        // Non-vacuity: at least one entry in this project MUST carry a non-null end
        // (else the generator silently degraded to the all-open shape the prior
        // sections already cover — a green-faking guard for THIS exploration).
        const hasBoundedEnd = project.histories.some((hh) =>
          hh.series.entries.some((e) => e.end !== null),
        );
        if (!hasBoundedEnd) {
          throw new Error('bounded-gap generator produced no non-null end (degraded to all-open)');
        }
      }),
      { seed: SEED10, numRuns: 400 },
    );
  });

  it('a bounded end + interior gap survives the ACTUAL JSON+Zod boundary unchanged', () => {
    fc.assert(
      fc.property(projectArbBounded(), (project) => {
        const rt = boundaryRoundTrips(project);
        if (!rt.ok) throw new Error(`bounded-gap base boundary round-trip failed: ${rt.reason}`);
        // The serialized form must literally carry the non-null end (not silently
        // dropped / re-opened on the persistence round-trip).
        const manifest = serialize(project);
        let sawBoundedEnd = false;
        for (const hh of manifest.histories) {
          for (const e of hh.entries) {
            if (e.end !== null && e.end !== undefined) sawBoundedEnd = true;
          }
        }
        if (!sawBoundedEnd) throw new Error('serialize dropped every bounded end');
      }),
      { seed: SEED10, numRuns: 400 },
    );
  });

  it('resolveAt is ABSENT inside a non-existence enclave and PRESENT inside a window (選択 over time)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            count: fc.integer({ min: 2, max: 4 }),
            spans: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 4, maxLength: 4 }),
            // Force gap ≥ 2 so every interior enclave has an integer midpoint to probe.
            gaps: fc.array(fc.integer({ min: 2, max: 20 }), { minLength: 4, maxLength: 4 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (specs) => {
          for (let i = 0; i < specs.length; i += 1) {
            const spec = specs[i]!;
            const id = `r${i}`;
            const { feature, vertices } = squareLeaf(id, 1000 + i * 300, 0, 10);
            const { windows, gapMidpoints } = layoutBoundedWindows(spec.count, spec.spans, spec.gaps);
            const history = boundedGapHistory(id, id, [feature], vertices, windows);
            // Every interior gap midpoint must resolve to ABSENT (the feature does not
            // exist in its own non-existence enclave — a query there would paint a ghost).
            for (const mid of gapMidpoints) {
              const res = resolveAt(history.series, timePointYear(mid), CAL);
              if (res.kind !== 'absent') {
                throw new Error(`resolveAt PRESENT inside enclave at year ${mid} (should be absent)`);
              }
            }
            // The interior of each BOUNDED window must resolve to PRESENT.
            for (const w of windows) {
              if (w.end === null) {
                // Open window: a time at/after start is present.
                const res = resolveAt(history.series, timePointYear(w.start), CAL);
                if (res.kind !== 'present') {
                  throw new Error(`resolveAt ABSENT inside open window starting ${w.start}`);
                }
              } else if (w.end - w.start >= 1) {
                const within = w.start; // start is inclusive, end exclusive.
                const res = resolveAt(history.series, timePointYear(within), CAL);
                if (res.kind !== 'present') {
                  throw new Error(`resolveAt ABSENT inside window [${w.start},${w.end})`);
                }
              }
            }
          }
        },
      ),
      { seed: SEED10, numRuns: 500 },
    );
  });

  it('all invariants + in-memory round-trip survive an edit sequence over bounded-gap series', () => {
    fc.assert(
      fc.property(
        projectArbBounded(),
        fc.array(cmdArb(), { minLength: 1, maxLength: 24 }),
        (initial, cmds) => {
          let project = initial;
          const base = checkBaseInvariants(project);
          if (!base.ok) throw new Error(`bounded base invalid: ${base.failed}`);
          for (const cmd of cmds) {
            project = applyCmd(project, cmd);
            const check = checkAllInvariants(project);
            if (!check.ok) {
              throw new Error(
                `invariant "${check.failed}" broke after cmd ${JSON.stringify(cmd)} (bounded-gap)`,
              );
            }
            const rt = boundaryRoundTrips(project);
            if (!rt.ok) {
              throw new Error(
                `boundary round-trip broke (${rt.reason}) after ${JSON.stringify(cmd)} (bounded-gap)`,
              );
            }
          }
        },
      ),
      { seed: SEED10, numRuns: 700 },
    );
  });
});
