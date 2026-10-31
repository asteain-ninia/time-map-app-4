// save-load-roundtrip-and-conflict-resolution の検査 1/3。全体の説明と共有の生成器は save-load-roundtrip-and-conflict-resolution.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { deleteAnchor } from '../anchor-series';
import { createHistory, execute, redo, undo } from '../command/history';
import { serialize, projectsEqual, type DomainProject } from '../persistence/serialize';
// eslint-disable-next-line no-restricted-imports
import { deserialize } from '../persistence/serialize';
import { parseManifest, PARSE_OUTCOME } from '../persistence';
import { checkConsistency, type Inconsistency } from '../persistence/consistency';
import {
  CAL,
  SEED,
  SEED2,
  SEED3,
  SEED4,
  allFeatureIds,
  applyCmd,
  applyMixedCmd,
  applyStructCmd,
  boundaryRoundTrips,
  checkAllInvariants,
  checkBaseInvariants,
  cmdArb,
  corrupt,
  corrupt3,
  corruptRingHierarchy,
  corruption3Arb,
  corruptionArb,
  doubleBoundaryStable,
  mixedCmdArb,
  nonGeometricCmdArb,
  projectArb,
  projectArb2,
  repairToFixpoint,
  reversibleEdit,
  selectionStaysValid,
  serializeIsCanonical,
  structCmdArb,
} from './save-load-roundtrip-and-conflict-resolution.arbitraries';

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
