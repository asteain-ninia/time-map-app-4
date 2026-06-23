// U13 — acceptance tests for the consistency-maintenance orchestrator.
//
// Every test is a pure 入力状態 → プロセス呼び出し → 期待結果 check (spec §受け入れ
// 基準). The dependency ports are stubbed/spied so order, early-return, single-
// undo-unit, and convergence behaviour are observable without any real geometry
// or time algorithm running here.

import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import { timePointYear } from '../time/time-point';
import {
  COMPOSITE_COMMAND_KIND,
  createCompositeCommand,
  type Command,
} from '../command/index';
import {
  CONFLICT_KIND,
  PROCESS_STATUS,
  REJECTION_KIND,
  createEditProposal,
  startProcess,
  applyResolutions,
  conflictIdFor,
  DEFAULT_MAX_CONVERGENCE_ROUNDS,
  MSG_TIME_VALIDATION_FAILED,
  MSG_CONSTRAINT_VIOLATION,
  MSG_CONVERGENCE_FAILED,
  type Conflict,
  type ConsistencyPorts,
  type EditProposal,
  type Resolution,
} from './index';

// --- test fixtures ----------------------------------------------------------

/** A toy domain state: an ordered log of the proposal/resolution marks applied. */
interface State {
  readonly applied: readonly string[];
}

const EMPTY_STATE: State = { applied: [] };

type Snapshot = { readonly mark: string };

const FA = asFeatureId('feat-A');
const FB = asFeatureId('feat-B');
const FC = asFeatureId('feat-C');

function proposalFor(id: FeatureId, mark: string): EditProposal<Snapshot> {
  return createEditProposal(id, timePointYear(1000), { mark });
}

function conflict(id: string, a: FeatureId, b: FeatureId): Conflict {
  return {
    id,
    kind: CONFLICT_KIND.TerminalOverlap,
    time: { kind: 'point', at: timePointYear(1000) },
    a: { featureId: a, displayName: `name-${a}` },
    b: { featureId: b, displayName: `name-${b}` },
    overlap: [[[]]], // opaque to U13; non-empty piece list.
  };
}

function resolutionFor(c: Conflict, priority: FeatureId, adjust: FeatureId): Resolution {
  return { conflictId: c.id, priorityFeatureId: priority, adjustFeatureId: adjust };
}

/** A no-op command (the makeCommand stub returns a real composite for kind checks). */
function fakeCommand(label: string): Command<State> {
  return createCompositeCommand<State>(label, []);
}

interface SpyLog {
  readonly calls: string[];
}

/**
 * Build ports with overridable behaviour. By default: applyProposal appends the
 * mark, checkTime passes, checkConstraints passes, detectSpatial finds nothing,
 * applyResolution appends a resolution mark, makeCommand returns a composite.
 * Every call is recorded on `log.calls` so order can be asserted.
 */
function makePorts(
  log: SpyLog,
  overrides: Partial<ConsistencyPorts<State, Snapshot>> = {},
): ConsistencyPorts<State, Snapshot> {
  return {
    applyProposal(current, proposal) {
      log.calls.push('applyProposal');
      return { applied: [...current.applied, `proposal:${proposal.snapshot.mark}`] };
    },
    checkTime() {
      log.calls.push('checkTime');
      return { ok: true };
    },
    checkConstraints() {
      log.calls.push('checkConstraints');
      return [];
    },
    detectSpatial() {
      log.calls.push('detectSpatial');
      return [];
    },
    applyResolution(state, _conflict, resolution) {
      log.calls.push('applyResolution');
      return { applied: [...state.applied, `adjust:${resolution.adjustFeatureId}`] };
    },
    makeCommand() {
      log.calls.push('makeCommand');
      return fakeCommand('整合性維持');
    },
    ...overrides,
  };
}

// --- 受け入れ基準1: fixed-order execution + early return --------------------

describe('受け入れ基準1: 固定順序の実行 (FR-61)', () => {
  it('追加確定: applyProposal → checkTime → checkConstraints → detectSpatial → makeCommand の順', () => {
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log);
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);

    expect(result.status).toBe(PROCESS_STATUS.Committed);
    expect(log.calls).toEqual([
      'applyProposal',
      'checkTime',
      'checkConstraints',
      'detectSpatial',
      'makeCommand',
    ]);
  });

  it('時間検証で拒否されると空間検出は呼ばれない (早期リターン)', () => {
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      checkTime() {
        log.calls.push('checkTime');
        return { ok: false, reason: { code: 'INV-1' } };
      },
    });
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);

    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    expect(log.calls).toContain('checkTime');
    expect(log.calls).not.toContain('detectSpatial');
    expect(log.calls).not.toContain('makeCommand');
  });
});

// --- 受け入れ基準2: structured conflict list -------------------------------

describe('受け入れ基準2: 空間競合の構造化リスト (FR-62)', () => {
  it('競合検出時は確定せず conflicts-pending を返し、各競合が時間・表示名・種類を持つ', () => {
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        log.calls.push('detectSpatial');
        return [c];
      },
    });

    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status !== PROCESS_STATUS.ConflictsPending) return;

    expect(log.calls).not.toContain('makeCommand'); // 確定一時停止
    expect(result.conflicts).toHaveLength(1);
    const only = result.conflicts[0]!;
    expect(only.kind).toBe(CONFLICT_KIND.TerminalOverlap);
    expect(only.time).toEqual({ kind: 'point', at: timePointYear(1000) });
    expect(only.a.displayName).toBe(`name-${FA}`);
    expect(only.b.displayName).toBe(`name-${FB}`);
    // ITEM-1 lock: the first-round pending carries the PROPOSAL trial state (the
    // proposal applied to the baseline) so the UI preview reads geometry from the
    // detected state, not the committed root (the stale-minimap fix).
    expect(result.trialState).toEqual({ applied: ['proposal:a'] });
  });

  it('複数競合が同時にあるとき全競合が漏れなくリストに現れる (片落としなし)', () => {
    const c1 = conflict(conflictIdFor(FA, FB), FA, FB);
    const c2 = conflict(conflictIdFor(FB, FC), FB, FC);
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, { detectSpatial: () => [c1, c2] });

    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(result.conflicts.map((x) => x.id)).toEqual([c1.id, c2.id]);
    expect(result.unresolvedConflictIds).toEqual([c1.id, c2.id]);
  });
});

// --- 受け入れ基準3: resolution application (multi-piece) --------------------

describe('受け入れ基準3: 解決方針の適用 (FR-63)', () => {
  it('優先地物・調整対象の組で applyResolution が呼ばれ、調整結果が状態へ反映される', () => {
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    let firstDetect = true;
    const log: SpyLog = { calls: [] };
    const captured: { conflict?: Conflict; resolution?: Resolution } = {};
    const ports = makePorts(log, {
      detectSpatial() {
        log.calls.push('detectSpatial');
        if (firstDetect) {
          firstDetect = false;
          return [c];
        }
        return []; // converged after one adjustment.
      },
      applyResolution(state, cf, resolution) {
        log.calls.push('applyResolution');
        captured.conflict = cf;
        captured.resolution = resolution;
        // Simulate U06 returning MULTIPLE pieces folded into the new state (教訓5.1):
        // we record two adjust marks to prove all pieces are reflected, not just the first.
        return {
          applied: [...state.applied, `adjust:piece1:${resolution.adjustFeatureId}`, 'adjust:piece2'],
        };
      },
    });

    const resolution = resolutionFor(c, FA, FB);
    const result = applyResolutions(EMPTY_STATE, proposalFor(FA, 'a'), [resolution], ports);

    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(captured.resolution).toEqual(resolution);
    expect(captured.conflict?.id).toBe(c.id);
    // Both pieces reflected (no first-piece-only drop).
    expect(result.state.applied).toContain('adjust:piece1:feat-B');
    expect(result.state.applied).toContain('adjust:piece2');
  });
});

// --- 受け入れ基準4: full resolution required + single undo unit -------------

describe('受け入れ基準4: 全競合解決まで未確定 / 単一アンドゥ単位 (FR-63 / FR-73)', () => {
  it('一部の競合のみ方針指定では確定せず conflicts-pending(未解決含む) を返す', () => {
    const c1 = conflict(conflictIdFor(FA, FB), FA, FB);
    const c2 = conflict(conflictIdFor(FB, FC), FB, FC);
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, { detectSpatial: () => [c1, c2] });

    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c1, FA, FB)], // only c1 has a policy
      ports,
    );
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(result.unresolvedConflictIds).toEqual([c2.id]);
    expect(log.calls).not.toContain('makeCommand');
    expect(log.calls).not.toContain('applyResolution'); // not applied while未充足
  });

  it('全競合に方針指定で確定し、確定は単一の不可分コマンド (composite) になる', () => {
    const c1 = conflict(conflictIdFor(FA, FB), FA, FB);
    const c2 = conflict(conflictIdFor(FB, FC), FB, FC);
    let detectCount = 0;
    const log: SpyLog = { calls: [] };
    let madeCommands = 0;
    const ports = makePorts(log, {
      detectSpatial() {
        detectCount += 1;
        return detectCount === 1 ? [c1, c2] : [];
      },
      makeCommand() {
        madeCommands += 1;
        return createCompositeCommand<State>('整合性維持', []);
      },
    });

    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c1, FA, FB), resolutionFor(c2, FB, FC)],
      ports,
    );
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    // Exactly one command minted (does not split into 2+).
    expect(madeCommands).toBe(1);
    expect(result.command.kind).toBe(COMPOSITE_COMMAND_KIND);
  });

  it('makeCommand は確定対象の全 feature id を touched として受け取る', () => {
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    let detectCount = 0;
    const captured: { touched?: readonly FeatureId[] } = {};
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        detectCount += 1;
        return detectCount === 1 ? [c] : [];
      },
      makeCommand(_baseline, _finalState, touched) {
        captured.touched = touched;
        return fakeCommand('整合性維持');
      },
    });

    applyResolutions(EMPTY_STATE, proposalFor(FA, 'a'), [resolutionFor(c, FA, FB)], ports);
    expect(new Set(captured.touched)).toEqual(new Set([FA, FB]));
  });
});

// --- 受け入れ基準5: pre-commit constraint re-check + rejection shape --------

describe('受け入れ基準5: 確定前の制約再検証と拒否理由 (教訓5.26)', () => {
  it('時間制約違反は拒否され、機械可読 kind と日本語メッセージの両方を持つ', () => {
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      checkTime: () => ({ ok: false, reason: { code: 'INV-2' } }),
    });
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.TimeViolation);
    expect(result.message).toBe(MSG_TIME_VALIDATION_FAILED);
    expect(result.detail).toEqual({ code: 'INV-2' });
  });

  it('編集制約違反 (自己交差/全体重複/階層破綻/禁止条件) は拒否され、確定しない', () => {
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      checkConstraints: () => [{ kind: 'self-intersection' }],
    });
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.ConstraintViolation);
    expect(result.message).toBe(MSG_CONSTRAINT_VIOLATION);
    expect(log.calls).not.toContain('detectSpatial'); // 制約違反で空間検出前に停止
    expect(log.calls).not.toContain('makeCommand');
  });

  it('UI を経由しない直接 applyResolutions 呼び出しでも制約再検証が走る', () => {
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      checkConstraints() {
        log.calls.push('checkConstraints');
        return [{ kind: 'hierarchy-break' }];
      },
    });
    const result = applyResolutions(EMPTY_STATE, proposalFor(FA, 'a'), [], ports);
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    expect(log.calls).toContain('checkConstraints');
  });
});

// --- 受け入れ基準6: terminal-only (port contract) --------------------------

describe('受け入れ基準6: 末端地物限定 (FR-26 / FR-27, 教訓5.25)', () => {
  it('空間検出ポートが返した競合のみを扱い、末端以外を独自に対象化しない', () => {
    // The port is the sole source of conflicts; U13 adds none of its own and
    // widens the target to no other feature kind. We prove U13 surfaces exactly
    // what the (terminal-only) detector returns — neither more nor fewer.
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, { detectSpatial: () => [c] });
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'a'), ports);
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(result.conflicts).toEqual([c]);
  });
});

// --- 受け入れ基準7: re-detection + convergence cap -------------------------

describe('受け入れ基準7: 差分調整後の再検出と収束 (FR-61)', () => {
  it('差分調整後に再検出し、残競合があれば再び conflicts-pending を返す (新規競合)', () => {
    const c1 = conflict(conflictIdFor(FA, FB), FA, FB);
    // A brand-new conflict with no policy appears after the adjustment.
    const cNew = conflict(conflictIdFor(FA, FC), FA, FC);
    let detectCount = 0;
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        detectCount += 1;
        return detectCount === 1 ? [c1] : [cNew];
      },
    });
    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c1, FA, FB)],
      ports,
    );
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(result.unresolvedConflictIds).toEqual([cNew.id]);
    // ITEM-1 lock: a re-conflict round carries the DIFFERENCE-ADJUSTED trial state
    // (workState — proposal applied + the c1 resolution), NOT the un-adjusted
    // proposal trial state, so the UI preview tracks the current trimmed geometry
    // rather than the stale pre-resolution shapes (the stale-minimap fix).
    expect(result.trialState).toEqual({ applied: ['proposal:a', `adjust:${FB}`] });
  });

  it('収束しない (毎回同じ競合が残る) 場合は拒否(収束失敗)を返し、無限ループしない', () => {
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    let detectCalls = 0;
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        detectCalls += 1;
        return [c]; // never converges; the same resolved conflict persists.
      },
    });
    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c, FA, FB)],
      ports,
      { maxRounds: 3 },
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.ConvergenceFailure);
    expect(result.message).toBe(MSG_CONVERGENCE_FAILED);
    // bounded: initial detect + one per round (3) = 4, not unbounded.
    expect(detectCalls).toBeLessThanOrEqual(4);
  });

  it('maxRounds:Infinity は停止性を壊さず既定上限にクランプされる (無限ループ防止)', () => {
    // A non-finite cap must NOT defeat termination (the for-loop bound). The
    // orchestrator clamps Infinity / NaN to the default cap and still rejects with
    // a convergence failure instead of spinning forever.
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    let detectCalls = 0;
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        detectCalls += 1;
        return [c]; // never converges.
      },
    });
    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c, FA, FB)],
      ports,
      { maxRounds: Number.POSITIVE_INFINITY },
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.ConvergenceFailure);
    // Bounded by the DEFAULT cap: initial detect + one per round = cap + 1.
    expect(detectCalls).toBeLessThanOrEqual(DEFAULT_MAX_CONVERGENCE_ROUNDS + 1);
  });

  it('差分調整後の状態が制約違反なら、空間競合ゼロでも確定しない (FR-61 制約再検証)', () => {
    // A resolution can produce a constraint-invalid state that has zero spatial
    // overlap; the post-resolution checkConstraints must catch it before commit.
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    let detectCalls = 0;
    let constraintCalls = 0;
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial() {
        detectCalls += 1;
        // First detect (pre-resolution) finds the conflict; after the adjustment
        // the re-detect is CLEAN — so only the constraint check can refuse.
        return detectCalls === 1 ? [c] : [];
      },
      checkConstraints() {
        constraintCalls += 1;
        // Pre-commit pipeline check passes (call 1); the post-resolution check
        // (call 2) reports a violation the trimmed shape introduced.
        return constraintCalls >= 2 ? [{ kind: 'self-intersection' }] : [];
      },
    });
    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c, FA, FB)],
      ports,
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.ConstraintViolation);
    expect(log.calls).not.toContain('makeCommand');
  });

  it('U06 差分が rejected (undefined) を返したら確定せず拒否する', () => {
    const c = conflict(conflictIdFor(FA, FB), FA, FB);
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      detectSpatial: () => [c],
      applyResolution: () => undefined, // degenerate boolean op.
    });
    const result = applyResolutions(
      EMPTY_STATE,
      proposalFor(FA, 'a'),
      [resolutionFor(c, FA, FB)],
      ports,
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status !== PROCESS_STATUS.Rejected) return;
    expect(result.kind).toBe(REJECTION_KIND.ConstraintViolation);
    expect(log.calls).not.toContain('makeCommand');
  });
});

// --- 受け入れ基準8: attribute-only edit is one whole-state commit ----------

describe('受け入れ基準8: 属性のみ編集の一体確定 (FR-59)', () => {
  it('属性だけの編集案でも時間・空間検証を経て 1 コマンドで確定する', () => {
    let madeCommands = 0;
    const log: SpyLog = { calls: [] };
    const ports = makePorts(log, {
      makeCommand() {
        log.calls.push('makeCommand');
        madeCommands += 1;
        return fakeCommand('属性編集');
      },
    });
    // The proposal carries a whole opaque snapshot even for an attribute-only change.
    const result = startProcess(EMPTY_STATE, proposalFor(FA, 'attr-only'), ports);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    expect(log.calls).toEqual([
      'applyProposal',
      'checkTime',
      'checkConstraints',
      'detectSpatial',
      'makeCommand',
    ]);
    expect(madeCommands).toBe(1);
  });
});

// --- input immutability (教訓5.22) -----------------------------------------

describe('入力不変 (教訓5.22): 確定まで・拒否時に現在状態を破壊しない', () => {
  it('拒否時に current は変化しない', () => {
    const current: State = { applied: ['existing'] };
    const ports = makePorts({ calls: [] }, { checkTime: () => ({ ok: false, reason: null }) });
    startProcess(current, proposalFor(FA, 'a'), ports);
    expect(current.applied).toEqual(['existing']);
  });
});
