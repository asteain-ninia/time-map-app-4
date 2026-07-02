// U27 — drill command + proposal tests (受け入れ基準 1 / 2 / 3 / 4 / 7).

import { describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, withLeafShape, FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { RING_KIND, createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore } from '../vertex';
import { timePointYear } from '../time/time-point';
import {
  PROCESS_STATUS,
  createEditProposal,
  startProcess,
  type Command,
  type ConsistencyPorts,
  type EditProposal,
} from '../index';
import type { FeatureSnapshot } from '../editing/edit-flow';
import { applyAddProposal, applyDrillProposal, applyEditProposal } from '../editing/apply-proposal';
import { getCalendar } from '../time/calendar';
import { checkConsistency, INCONSISTENCY } from '../persistence/consistency';
import { createGeoParams } from '../geo/geo-params';
import type { DomainProject } from '../persistence/serialize';
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
    const { store } = unitSquare();
    const proposal = assembleDrillProposal({ target: feature, store, geometry: geo, newProperties: NEW_PROPS, ids });
    // Vertices for both sides are bundled (片落とし禁止 / 教訓5.20).
    expect(proposal.vertices.length).toBeGreaterThanOrEqual(8);
    // The new feature id is minted from the injected port (plain data; redo replays
    // it without re-minting — 教訓5.20).
    expect(proposal.newFeature.id).toMatch(/^drill-f-/);
    expect(proposal.originalFeatureId).toBe(feature.id);
  });
});

// --- data-integrity: 原末端の未変更外周頂点IDを保持する (波7 と同クラス) --------
//
// 穴あけは holed original の OUTER 境界を変えない（穴は内部にできるだけ）。その外周頂点は
// 元から存在し隣接地物と ID 共有し得る（drill-geometry の intersection で内部に閉じるのは
// 新地物の領土だけで、holed original の外周ではない）。旧実装は buildShapeFromArea が
// holed original の全座標へ新 VertexId を再採番し、外周の共有 ID を破壊していた → 隣接地物
// は旧 ID を参照し続け、境界の ID 共有が黙って失われる（後続の連動移動で境界が裂ける／
// save-load で同座標別 ID になる；split の applyVertexRemapToHistories が防ぐのと同型）。
// 最小・正の対処は「未変更外周頂点をそもそも再採番しない」= 元頂点 ID の再利用（Option 1）。
describe('穴あけ後も原末端の外周頂点IDを保持する (data整合 / 波7同クラス)', () => {
  it('holed original の外周リングは元の頂点IDを再利用し、穴リングのみ新規採番する', () => {
    const { feature, store } = unitSquare('sq');
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');

    const originalOuterIds = feature.shape.rings
      .flatMap((r) => r.vertexIds)
      .map((v) => v as string);
    const holedRings = res.proposal.holedShape.rings;
    const territory = holedRings.find((r) => r.kind === RING_KIND.Territory)!;
    const hole = holedRings.find((r) => r.kind === RING_KIND.Hole)!;
    const holedTerritoryIds = territory.vertexIds.map((v) => v as string);
    const holeIds = hole.vertexIds.map((v) => v as string);

    // 外周（territory）は元の頂点IDをそのまま再利用（未変更頂点は再採番しない）.
    for (const oid of originalOuterIds) {
      expect(holedTerritoryIds).toContain(oid);
    }
    // 穴リングは元外周には無い真に新規な座標なので新規採番のまま.
    for (const hid of holeIds) {
      expect(originalOuterIds).not.toContain(hid);
    }
    // 束ねた頂点集合は再利用した外周頂点の body も自己完結で解決できる（単一真実源）.
    const bundledIds = new Set(res.proposal.vertices.map((v) => v.id as string));
    for (const oid of originalOuterIds) expect(bundledIds.has(oid)).toBe(true);
  });

  it('新地物の内部頂点は従来どおり新規採番（原ID衝突なし）', () => {
    const { feature, store } = unitSquare('sq');
    const res = drillRegion(baseInput(feature, store));
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    const originalOuterIds = feature.shape.rings.flatMap((r) => r.vertexIds).map((v) => v as string);
    const newIds = res.proposal.newFeature.shape.rings.flatMap((r) => r.vertexIds).map((v) => v as string);
    // 新地物の領土リングは内部（穴と同座標）で、原外周IDとは別（内部頂点は新規採番）.
    for (const nid of newIds) expect(originalOuterIds).not.toContain(nid);
  });
});

// --- 隣接地物との外周頂点共有が穴あけ後も生存する（end-to-end / data整合） ------
//
// 原末端 sq の右辺頂点 sq-v1(10,0)/sq-v2(10,10) を隣接地物 nbr が SAME VertexId で
// 共有している（実 ID 共有）。穴あけは外周を変えないので、確定後も drilled original は
// これら外周頂点 ID を保持し、nbr の参照は生存頂点（同一 ID）を指し続けねばならない。
// 旧実装は外周を再採番し、nbr は孤立した旧 ID を参照＝共有喪失（境界が黙って裂ける）。
describe('隣接地物と外周頂点を共有する末端の穴あけ (data整合 / FR-95 と同型)', () => {
  const cal = getCalendar('gregorian');

  function emptyProject(): DomainProject {
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

  it('穴あけ後、隣接は生存する共有頂点を指し・偽 divergence を出さない', () => {
    const { feature: target, store: targetStore } = unitSquare('sq');
    // 右隣の四角: 左辺で sq の右辺頂点 sq-v1(10,0)/sq-v2(10,10) を ID 共有.
    const nbrColor = createColorInfo(true, '#111', '#222', '#333');
    const nbrRing = createTerritoryRing(asRingId('r-nbr'), [
      asVertexId('sq-v1'), // (10,0) 共有
      asVertexId('nbr-a'), // (20,0)
      asVertexId('nbr-b'), // (20,10)
      asVertexId('sq-v2'), // (10,10) 共有
    ]);
    const neighbour = createLeafFeature(
      asFeatureId('nbr'),
      createBasicAttributes('隣', 0, 0),
      nbrColor,
      createShape([nbrRing]),
    );
    const nbrStore = createVertexStore([
      createVertex(asVertexId('sq-v1'), createCoordinate(10, 0)),
      createVertex(asVertexId('sq-v2'), createCoordinate(10, 10)),
      createVertex(asVertexId('nbr-a'), createCoordinate(20, 0)),
      createVertex(asVertexId('nbr-b'), createCoordinate(20, 10)),
    ]);

    let root = applyAddProposal(emptyProject(), {
      featureId: target.id,
      anchorTime: timePointYear(1500),
      snapshot: { feature: target, vertices: [...targetStore.byId.values()], sharedCandidateIds: new Map() },
    });
    root = applyAddProposal(root, {
      featureId: neighbour.id,
      anchorTime: timePointYear(1500),
      snapshot: { feature: neighbour, vertices: [...nbrStore.byId.values()], sharedCandidateIds: new Map() },
    });

    const res = drillRegion({
      target,
      store: targetStore,
      region: centralRegion(),
      editBaseTime: timePointYear(1500),
      newProperties: NEW_PROPS,
      ids: freshIdPorts(),
    });
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');

    const next = applyDrillProposal(root, toEditProposal(res.proposal, timePointYear(1500)), cal);

    // drilled original が外周で citing する ID 群.
    const drilledHist = next.histories.find((h) => h.featureId === target.id)!;
    const dSnap = drilledHist.series.entries.find((e) => e.start.year === 1500)!.anchor.snapshot;
    const dFeat = dSnap.features.find((f) => f.id === target.id)!;
    const drilledIds = dFeat.kind === 'leaf'
      ? dFeat.shape.rings.flatMap((r) => r.vertexIds).map((v) => v as string)
      : [];

    // (a) 原外周頂点 ID を保持: drilled original は依然 sq-v1/sq-v2 を citing.
    expect(drilledIds).toContain('sq-v1');
    expect(drilledIds).toContain('sq-v2');

    // (c) 隣接は共有頂点 ID を保持し、drilled original と同一 ID で共有継続.
    const nbrHist = next.histories.find((h) => h.featureId === neighbour.id)!;
    const nSnap = nbrHist.series.entries.find((e) => e.start.year === 1500)!.anchor.snapshot;
    const nFeat = nSnap.features.find((f) => f.id === neighbour.id)!;
    const nbrIds = nFeat.kind === 'leaf'
      ? nFeat.shape.rings.flatMap((r) => r.vertexIds).map((v) => v as string)
      : [];
    // target ∩ neighbour で共有 ID が生き残っている（黙って割れていない）.
    const sharedAfter = drilledIds.filter((id) => nbrIds.includes(id));
    expect(sharedAfter).toContain('sq-v1');
    expect(sharedAfter).toContain('sq-v2');
    // 共有頂点 body は drilled original のスナップショットで解決できる（dangling でない）.
    expect(dSnap.vertices.byId.has(asVertexId('sq-v1'))).toBe(true);
    expect(dSnap.vertices.byId.has(asVertexId('sq-v2'))).toBe(true);

    // (b) checkConsistency が偽の VertexCoordinateDivergence を出さない.
    const report = checkConsistency(next, cal);
    const divergence = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toBeUndefined();
    // MissingVertexReference も無い（隣接の共有参照は生存頂点を指す）.
    const missing = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.MissingVertexReference,
    );
    expect(missing).toBeUndefined();
  });
});

// --- 新地物履歴に原外周/穴頂点の孤児コピーが焼き込まれない（data整合・第10波 HIGH）--
//
// 穴あけの新地物アンカーは、両側束ね vertexStore（原末端の未変更外周頂点 + 穴リング頂点
// を含む）をそのまま焼くと、新地物が cite しない孤児コピーを抱える。後で原末端がその外周
// 頂点を移動すると、原末端の履歴は新座標、新地物の履歴は焼き込んだ旧座標のまま乖離し、
// checkConsistency が偽の VertexCoordinateDivergence を発火させる（load 時に
// ReconcileVertexCoordinate 修復ダイアログに化ける）。merge スライス（applyMergeProposal
// step3, pruneVertexStore）と対称に、新地物アンカーは自参照のみへ剪定されねばならない。
describe('穴あけ新地物アンカーの頂点剪定（偽 VertexCoordinateDivergence 防止 / 第10波）', () => {
  const cal = getCalendar('gregorian');

  function emptyProject(): DomainProject {
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

  /** Add `sq` at 1500 and drill its central region; returns the applied project + proposal. */
  function drilledProject() {
    const { feature: target, store: targetStore } = unitSquare('sq');
    let root = applyAddProposal(emptyProject(), {
      featureId: target.id,
      anchorTime: timePointYear(1500),
      snapshot: {
        feature: target,
        vertices: [...targetStore.byId.values()],
        sharedCandidateIds: new Map(),
      },
    });
    const res = drillRegion({
      target,
      store: targetStore,
      region: centralRegion(),
      editBaseTime: timePointYear(1500),
      newProperties: NEW_PROPS,
      ids: freshIdPorts(),
    });
    if (res.status !== DRILL_STATUS.Drilled) throw new Error('expected drilled');
    root = applyDrillProposal(root, toEditProposal(res.proposal, timePointYear(1500)), cal);
    return { root, res, target };
  }

  it('新地物履歴アンカーの store は新地物が cite する id のみ（原外周/穴頂点の孤児なし）', () => {
    const { root, res, target } = drilledProject();
    const nf = res.proposal.newFeature;
    const nfHist = root.histories.find((h) => h.featureId === nf.id)!;
    const nfSnap = nfHist.series.entries.find((e) => e.start.year === 1500)!.anchor.snapshot;

    const citedIds = nf.shape.rings.flatMap((r) => r.vertexIds);
    const citedStrings = citedIds.map((v) => v as string);
    const storeStrings = [...nfSnap.vertices.byId.keys()].map((v) => v as string);

    // store は cite する id 集合と完全一致（孤児コピー 0）— merge createdIds 経路と対称.
    expect([...storeStrings].sort()).toEqual([...citedStrings].sort());
    // 新地物アンカー store は原外周頂点 id を含まない（孤児コピー混入の直接検証）.
    for (const outerId of target.shape.rings.flatMap((r) => r.vertexIds)) {
      expect(nfSnap.vertices.byId.has(outerId)).toBe(false);
    }
    // それでも新地物は自己完結（cite する全 id が store で解決できる — dangling 無し）.
    for (const cid of citedIds) {
      expect(nfSnap.vertices.byId.has(cid)).toBe(true);
    }
  });

  it('穴あけ後に原末端の外周頂点を移動しても偽 VertexCoordinateDivergence が出ない', () => {
    const { root, target } = drilledProject();

    // drilled original の 1500 スナップショットとその外周頂点 sq-v0 を取り出す.
    const origHist = root.histories.find((h) => h.featureId === target.id)!;
    const oSnap = origHist.series.entries.find((e) => e.start.year === 1500)!.anchor.snapshot;
    const oFeat = oSnap.features.find((f) => f.id === target.id)!;
    if (oFeat.kind !== 'leaf') throw new Error('expected leaf');
    const movedId = asVertexId('sq-v0'); // 原外周の左下角（穴あけで不変・共有 body）.
    const oldBody = oSnap.vertices.byId.get(movedId)!;
    expect(oldBody).toBeDefined();

    // 原末端の外周頂点 sq-v0 を (0,0) → (-5,-5) へ移動する通常の形状編集（同 id・新 body）.
    const movedBody = createVertex(movedId, createCoordinate(-5, -5));
    const movedFeature = withLeafShape(oFeat, oFeat.shape); // 形状（id 列）は不変、body だけ移動.
    const snapshot: FeatureSnapshot = { feature: movedFeature, vertices: [movedBody] };
    const next = applyEditProposal(
      root,
      createEditProposal(target.id, timePointYear(1500), snapshot),
      cal,
    );

    // 原末端の履歴は移動後座標を持つ.
    const nHist = next.histories.find((h) => h.featureId === target.id)!;
    const nSnap = nHist.series.entries.find((e) => e.start.year === 1500)!.anchor.snapshot;
    expect(nSnap.vertices.byId.get(movedId)!.coordinate.lon).toBeCloseTo(-5);
    expect(nSnap.vertices.byId.get(movedId)!.coordinate.lat).toBeCloseTo(-5);

    // 偽の VertexCoordinateDivergence が発火しない（新地物履歴に sq-v0 の孤児旧コピーが無い）.
    const report = checkConsistency(next, cal);
    const divergence = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toBeUndefined();
  });
});
