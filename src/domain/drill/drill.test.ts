// U27 — drill command + proposal tests (受け入れ基準 1 / 2 / 3 / 4 / 7).

import { describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import { type FeatureId } from '../ids';
import { RING_KIND } from '../ring';
import { timePointYear } from '../time/time-point';
import {
  PROCESS_STATUS,
  startProcess,
  type Command,
  type ConsistencyPorts,
  type EditProposal,
} from '../index';
import {
  DRILL_STATUS,
  drillRegion,
  type DrillInput,
  type DrillResult,
} from './drill';
import { assembleDrillProposal, toEditProposal, type DrillSnapshot } from './proposal';
import { aggregate, centralRegion, fid, freshIdPorts, unitSquare } from './fixtures';

const NEW_PROPS = {
  attributes: createBasicAttributes('新地物', 1500, 1600),
  color: createColorInfo(true, '#abc', '#0f0', '#000'),
} as const;

function baseInput(target: Feature, store: DrillInput['store']): DrillInput {
  return {
    target,
    store,
    region: centralRegion(),
    editBaseTime: timePointYear(1500),
    newProperties: NEW_PROPS,
    ids: freshIdPorts(),
  };
}

describe('drillRegion — 新地物生成 + 穴形成 (受け入れ1)', () => {
  it('原末端は同一性を保ち、新地物は別IDの末端地物として生成される', () => {
    const { feature, store } = unitSquare();
    const res = drillRegion(baseInput(feature, store));
    expect(res.status).toBe(DRILL_STATUS.Drilled);
    if (res.status !== DRILL_STATUS.Drilled) return;

    // 原末端 id 不変.
    expect(res.originalFeatureId).toBe(feature.id);
    // 新地物は別 id・末端地物.
    expect(res.newFeatureId).not.toBe(feature.id);
    expect(res.proposal.newFeature.kind).toBe(FEATURE_KIND.Leaf);
    expect(res.proposal.newFeature.id).toBe(res.newFeatureId);
  });

  it('穴付き原末端は territory + hole を持つ (穴形成)', () => {
    const { feature, store } = unitSquare();
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    const kinds = res.proposal.holedShape.rings.map((r) => r.kind);
    expect(kinds).toContain(RING_KIND.Territory);
    expect(kinds).toContain(RING_KIND.Hole);
  });

  it('新地物の形状は territory リングのみ (穴なしの独立面)', () => {
    const { feature, store } = unitSquare();
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    const kinds = res.proposal.newFeature.shape.rings.map((r) => r.kind);
    expect(kinds).toEqual([RING_KIND.Territory]);
  });
});

describe('上位領域の初期継承 (受け入れ2 / FR-45 / FR-39)', () => {
  it('原末端が親 A を持つと新地物の親も A になる', () => {
    const parentA = fid('agg-A');
    const { feature, store } = unitSquare('sq', { parentId: parentA });
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    expect(res.inheritedParentId).toBe(parentA);
    expect(res.proposal.newFeature.parentId).toBe(parentA);
  });

  it('原末端が最上位なら新地物も最上位 (親なし; 教訓5.18)', () => {
    const { feature, store } = unitSquare(); // no parent.
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    expect(res.inheritedParentId).toBeUndefined();
    // 最上位フラグ真⇔親なし: the parentId key is absent on the new feature.
    expect('parentId' in res.proposal.newFeature).toBe(false);
  });
});

describe('対概念分離: 穴あけは必ず地物数を 1 増やす (受け入れ3 / FR-23)', () => {
  it('成功結果は常に新地物 id を持つ (形状編集のみの経路を持たない)', () => {
    const { feature, store } = unitSquare();
    const res: DrillResult = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    // The success variant ALWAYS carries newFeatureId (type-level: required field).
    expect(res.newFeatureId).toBeTruthy();
    // 形状編集 (U25) would update one feature in place with NO new feature; the drill
    // proposal touches the original + a NEW id (count +1).
    expect(res.proposal.touchedFeatureIds).toContain(feature.id);
    expect(res.proposal.touchedFeatureIds).toContain(res.newFeatureId);
    expect(res.proposal.touchedFeatureIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('集約地物の拒否 (受け入れ7)', () => {
  it('集約地物を対象に渡すと拒否し、日本語メッセージを持つ', () => {
    const { store } = unitSquare();
    const res = drillRegion(baseInput(aggregate(), store));
    expect(res.status).toBe(DRILL_STATUS.Rejected);
    if (res.status !== DRILL_STATUS.Rejected) return;
    expect(res.message).toMatch(/集約地物/);
    expect(res.reason).toBeTruthy();
  });
});

// --- 受け入れ4: U13 整合性維持プロセスが呼ばれ単一アンドゥ単位になる ----------
//
// We drive U13's startProcess with spy ports and the drill EditProposal. The drill
// proposal packs BOTH features into ONE snapshot, so U13 confirms them as ONE
// command (1 アンドゥ単位); the spy proves the fixed-order pipeline is triggered and
// makeCommand is called exactly once.

interface FakeState {
  readonly features: ReadonlyMap<FeatureId, Feature>;
}

function makeSpyPorts(): {
  ports: ConsistencyPorts<FakeState, DrillSnapshot>;
  spies: {
    applyProposal: ReturnType<typeof vi.fn>;
    checkTime: ReturnType<typeof vi.fn>;
    detectSpatial: ReturnType<typeof vi.fn>;
    makeCommand: ReturnType<typeof vi.fn>;
  };
} {
  const applyProposal = vi.fn(
    (current: FakeState, proposal: EditProposal<DrillSnapshot>): FakeState => {
      // Apply the indivisible snapshot: holed original (same id) + new feature.
      const next = new Map(current.features);
      const original = next.get(proposal.snapshot.originalFeatureId);
      if (original !== undefined && original.kind === FEATURE_KIND.Leaf) {
        next.set(original.id, { ...(original as LeafFeature), shape: proposal.snapshot.holedShape });
      }
      next.set(proposal.snapshot.newFeature.id, proposal.snapshot.newFeature);
      return { features: next };
    },
  );
  const checkTime = vi.fn(() => ({ ok: true as const }));
  const detectSpatial = vi.fn(() => [] as never[]);
  const makeCommand = vi.fn(
    (_baseline: FakeState, finalState: FakeState): Command<FakeState> =>
      ({
        kind: 'drill-composite',
        label: 'drill',
        execute: () => ({ state: finalState, result: { touchedFeatureIds: [] } }),
        undo: () => ({ state: _baseline, result: { touchedFeatureIds: [] } }),
        redo: () => ({ state: finalState, result: { touchedFeatureIds: [] } }),
      }) as unknown as Command<FakeState>,
  );

  return {
    ports: {
      applyProposal,
      checkTime,
      checkConstraints: () => [],
      detectSpatial,
      applyResolution: (s) => s,
      makeCommand,
    },
    spies: { applyProposal, checkTime, detectSpatial, makeCommand },
  };
}

describe('U13 整合性維持プロセスのトリガーと単一アンドゥ単位 (受け入れ4 / FR-94)', () => {
  it('穴あけ確定で固定順序の検証が呼ばれ、1 つのコマンドに束ねられる', () => {
    const { feature, store } = unitSquare();
    const drill = drillRegion(baseInput(feature, store));
    if (drill.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');

    const current: FakeState = { features: new Map([[feature.id, feature as Feature]]) };
    const proposal = toEditProposal(drill.proposal, drill.anchorTime);
    const { ports, spies } = makeSpyPorts();

    const result = startProcess(current, proposal, ports);

    // 固定順序のプロセスが起動: applyProposal → checkTime → detectSpatial.
    expect(spies.applyProposal).toHaveBeenCalledTimes(1);
    expect(spies.checkTime).toHaveBeenCalledTimes(1);
    expect(spies.detectSpatial).toHaveBeenCalledTimes(1);
    // 競合なし → 単一コマンドに束ねて確定 (makeCommand 1 回 = 1 アンドゥ単位).
    expect(spies.makeCommand).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    // 確定後の地物数が ちょうど 1 増える (受け入れ1: +1).
    expect(result.state.features.size).toBe(2);
    expect(result.state.features.has(drill.newFeatureId)).toBe(true);
    // 原末端は同一 id で残り、穴付き形状へ変化している.
    const remained = result.state.features.get(feature.id);
    expect(remained?.kind).toBe(FEATURE_KIND.Leaf);
    // 穴付き形状: holed original carries a Hole ring (穴あけ後の末端形状).
    expect(remained?.kind === FEATURE_KIND.Leaf
      ? (remained as LeafFeature).shape.rings.map((r) => r.kind)
      : []).toContain(RING_KIND.Hole);
  });

  it('アンドゥで穴あけ前状態へ完全復元し、リドゥで新地物IDを再採番せず復元する (受け入れ4後半 / 教訓5.20)', () => {
    const { feature, store } = unitSquare();
    const drill = drillRegion(baseInput(feature, store));
    if (drill.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');

    // The pre-drill baseline: ONLY the original square (no hole, no new feature).
    const baseline: FakeState = { features: new Map([[feature.id, feature as Feature]]) };
    const proposal = toEditProposal(drill.proposal, drill.anchorTime);
    const { ports } = makeSpyPorts();

    const result = startProcess(baseline, proposal, ports);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    // The committed result carries exactly ONE composite command (1 アンドゥ単位).
    const command = result.command;

    // 確定直後 (execute 相当): 2 地物・原末端は穴付き.
    expect(result.state.features.size).toBe(2);
    const drilledOriginal = result.state.features.get(feature.id);
    expect(drilledOriginal?.kind === FEATURE_KIND.Leaf
      ? (drilledOriginal as LeafFeature).shape.rings.map((r) => r.kind)
      : []).toContain(RING_KIND.Hole);

    // --- undo(): 穴あけ前状態へ完全復元 ------------------------------------
    const undone = command.undo(result.state);
    // 地物数が元どおり (2 → 1): 新地物は消える.
    expect(undone.state.features.size).toBe(1);
    expect(undone.state.features.has(drill.newFeatureId)).toBe(false);
    // 原末端は同一 id で残り、穴のない元の末端形状 (territory のみ、Hole なし) へ戻る.
    const restored = undone.state.features.get(feature.id);
    expect(restored).toBeDefined();
    expect(restored?.kind).toBe(FEATURE_KIND.Leaf);
    if (restored?.kind === FEATURE_KIND.Leaf) {
      const restoredKinds = (restored as LeafFeature).shape.rings.map((r) => r.kind);
      expect(restoredKinds).toEqual([RING_KIND.Territory]);
      expect(restoredKinds).not.toContain(RING_KIND.Hole);
    }
    // 完全復元: undo 後の状態は元の baseline と同値 (穴あけ前そのもの).
    expect(restored).toBe(feature as Feature);

    // --- redo(): 新地物IDを初回生成IDのまま (再採番せず) 復元 -------------
    const redone = command.redo(undone.state);
    expect(redone.state.features.size).toBe(2);
    // newFeatureId は初回生成値と同一値で features に存在する (ID再採番回避 / 教訓5.20).
    expect(redone.state.features.has(drill.newFeatureId)).toBe(true);
    const replayed = redone.state.features.get(drill.newFeatureId);
    expect(replayed?.id).toBe(drill.newFeatureId);
    // redo は記録された plain data を再生するだけ — execute 時と同一の新地物オブジェクト.
    expect(replayed).toBe(result.state.features.get(drill.newFeatureId));
  });
});

describe('編集基準時刻の受け渡し (FR-57)', () => {
  it('結果の anchorTime は入力の編集基準時刻に一致する', () => {
    const { feature, store } = unitSquare();
    const input = { ...baseInput(feature, store), editBaseTime: timePointYear(1789) };
    const res = drillRegion(input);
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    expect(res.anchorTime).toEqual(timePointYear(1789));
    const proposal = toEditProposal(res.proposal, res.anchorTime);
    expect(proposal.anchorTime).toEqual(timePointYear(1789));
    expect(proposal.featureId).toBe(feature.id);
  });
});

describe('assembleDrillProposal — 直接組み立て (頂点束ね・教訓5.20)', () => {
  it('両側の新頂点を束ね、ID再採番せず初回IDを保持する', () => {
    const { feature } = unitSquare();
    const ids = freshIdPorts();
    const geo = {
      holedOriginal: [[[
        { lon: 0, lat: 0 }, { lon: 10, lat: 0 }, { lon: 10, lat: 10 }, { lon: 0, lat: 10 },
      ], [
        { lon: 3, lat: 3 }, { lon: 7, lat: 3 }, { lon: 7, lat: 7 }, { lon: 3, lat: 7 },
      ]]],
      newRegion: [[[
        { lon: 3, lat: 3 }, { lon: 7, lat: 3 }, { lon: 7, lat: 7 }, { lon: 3, lat: 7 },
      ]]],
    };
    const proposal = assembleDrillProposal({ target: feature, geometry: geo, newProperties: NEW_PROPS, ids });
    // Vertices for both sides are bundled (片落とし禁止 / 教訓5.20).
    expect(proposal.vertices.length).toBeGreaterThanOrEqual(8);
    // The new feature id is minted from the injected port (plain data; redo replays
    // it without re-minting — 教訓5.20).
    expect(proposal.newFeature.id).toMatch(/^drill-f-/);
    expect(proposal.originalFeatureId).toBe(feature.id);
  });
});
