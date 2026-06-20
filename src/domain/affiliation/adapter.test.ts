// U28 → U13 アダプタの両側テスト (教訓 5.33 / 5.34: 層をまたぐ契約を型と両側テストで
// 固定する)。所属変更編集案が U13 の固定順序プロセスを **経由して** 確定され、空間競合は
// U13 へ委譲されること、確定が 1 アンドゥ単位の不可分コマンドになることを固定する
// (spec §依存 U13 / スコープ項目 7 / 受け入れ基準 5)。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { timePointYear } from '../time/time-point';
import { PROCESS_STATUS, type Conflict } from '../consistency/types';
import { CONFLICT_KIND } from '../consistency/types';

import { parentExisting } from './decision';
import { buildAffiliationProposal } from './proposal';
import {
  affiliationTouchedIds,
  startAffiliationProcess,
  toEditProposal,
  type AffiliationPortOverrides,
  type AffiliationSnapshot,
} from './adapter';

// --- fixtures ---------------------------------------------------------------

const fid = (s: string): FeatureId => asFeatureId(s);
const COLOR = createColorInfo(true, '#1', '#2', '#3');
const ATTRS = (n: string, s = 0, e = 100): ReturnType<typeof createBasicAttributes> =>
  createBasicAttributes(n, s, e);

function leaf(id: string, parent?: string): Feature {
  const ring = createTerritoryRing(asRingId(`${id}-r`), [asVertexId(`${id}-v`)]);
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  return createLeafFeature(fid(id), ATTRS(id), COLOR, createShape([ring]), optional);
}
function agg(id: string, parent?: string): Feature {
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  return createAggregateFeature(fid(id), ATTRS(id), COLOR, [], optional);
}

// Ports that pass time/constraint checks; spatial conflicts are injected per-test
// to prove U28 delegates spatial conflict handling to U13 (it owns no spatial code).
function passingOverrides(
  conflicts: readonly Conflict[] = [],
): AffiliationPortOverrides<AffiliationSnapshot> {
  return {
    checkTime: () => ({ ok: true }),
    checkConstraints: () => [],
    detectSpatial: () => conflicts,
    applyResolution: (state) => state,
  };
}

const baseline = [agg('A'), agg('B'), leaf('child', 'A')];

function makeProposal() {
  const r = buildAffiliationProposal(baseline, fid('child'), parentExisting(fid('B')), {
    idState: createIdGeneratorState(0, 0),
    now: () => 1,
  });
  if (r.status !== 'proposal') throw new Error('expected proposal');
  return r.proposal;
}

// --- contract: AffiliationProposal -> EditProposal<Snapshot> ----------------

describe('U28→U13 アダプタ: 編集案を EditProposal へ写像', () => {
  it('toEditProposal が featureId / anchorTime / snapshot を U13 契約の形で埋める', () => {
    const proposal = makeProposal();
    const anchor = timePointYear(1500);
    const ep = toEditProposal(proposal, anchor);
    // featureId は展開後の代表対象。
    expect(ep.featureId).toBe(proposal.targetIds[0]);
    expect(ep.anchorTime).toBe(anchor);
    // snapshot は確定後の面情報集合 (U13 は不透明値として扱う)。
    expect(ep.snapshot).toBe(proposal.nextFeatures);
  });

  it('touched 集合は created∪deleted∪survived∪targets を網羅 (教訓5.23)', () => {
    const proposal = makeProposal();
    const touched = affiliationTouchedIds(proposal);
    for (const id of proposal.targetIds) expect(touched).toContain(id);
    for (const id of proposal.createdIds) expect(touched).toContain(id);
    for (const id of proposal.deletedIds) expect(touched).toContain(id);
    for (const id of proposal.survivedTouchedIds) expect(touched).toContain(id);
  });
});

// --- contract: confirmation flows THROUGH U13 startProcess ------------------

describe('U28→U13 アダプタ: 確定は U13 固定順序プロセスを経由する', () => {
  it('競合なしなら U13 が 1 アンドゥ単位コマンドとともに committed を返す', () => {
    const proposal = makeProposal();
    const result = startAffiliationProcess(
      baseline,
      proposal,
      timePointYear(1500),
      passingOverrides([]),
    );
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status === PROCESS_STATUS.Committed) {
      // 確定後状態は編集案の結果状態 (applyProposal が snapshot をそのまま返す)。
      expect(result.state).toBe(proposal.nextFeatures);
      // 単一の不可分コマンド: execute/undo が 1 コマンドとして成立する。
      const exec = result.command.execute(baseline);
      expect(exec.state).toBe(proposal.nextFeatures);
      const undo = result.command.undo(exec.state);
      expect(undo.state).toBe(baseline);
    }
  });

  it('空間競合は U13 へ委譲: detectSpatial が競合を返すと conflicts-pending', () => {
    const proposal = makeProposal();
    const conflict: Conflict = {
      id: 'cf-1',
      kind: CONFLICT_KIND.TerminalOverlap,
      time: { kind: 'point', at: timePointYear(1500) },
      a: { featureId: fid('child'), displayName: 'child' },
      b: { featureId: fid('B'), displayName: 'B' },
      overlap: [],
    };
    const result = startAffiliationProcess(
      baseline,
      proposal,
      timePointYear(1500),
      passingOverrides([conflict]),
    );
    // U28 は空間判定を自前で行わず、U13 が返す競合をそのまま返す (委譲)。
    expect(result.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (result.status === PROCESS_STATUS.ConflictsPending) {
      expect(result.conflicts.map((c) => c.id)).toEqual(['cf-1']);
    }
  });

  it('時間整合性違反は U13 が拒否: 確定が U13 を迂回しない', () => {
    const proposal = makeProposal();
    const overrides: AffiliationPortOverrides<AffiliationSnapshot> = {
      ...passingOverrides([]),
      checkTime: () => ({ ok: false, reason: 'bad-anchor' }),
    };
    const result = startAffiliationProcess(
      baseline,
      proposal,
      timePointYear(1500),
      overrides,
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
  });
});
