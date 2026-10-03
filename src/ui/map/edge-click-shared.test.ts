// 増分 8A の手直し（反証 重 2 / GPT #5）: 辺の中点のクリックで頂点を足す経路を、App と同じ
// 組み方（実の U13 結線 `createLiveEditBinding` ＋ `buildEditSnapshot` ＋ `edgeAddMidpoint`）で
// 確定から取り消し・やり直し・保存と読み直しまで **データ全体で** 見る。
//
// - 隣と共有している辺なら、足した頂点は両方の輪に **同じ頂点**として入る（T 字にしない）。
// - 足した頂点をあとで動かしても、両方の境界が一緒に動く（隙間ができない）。
// - 取り消し 1 回で、足す前のプロジェクトと **まるごと同じ値**に戻る。やり直しで戻る。
// - 保存して読み直しても同じ。経度 180° をまたぐ辺でも同じ。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { PROCESS_STATUS } from '../../domain/consistency';
import { createCoordinate } from '../../domain/coordinate';
import { RELEASE_OUTCOME } from '../../domain/editing';
import { FEATURE_KIND, createLeafFeature, type Feature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../../domain/ids';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import {
  isParsed,
  manifestToProject,
  parseManifest,
  serialize,
  type DomainProject,
} from '../../domain/persistence/index';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { EMPTY_SELECTION, edgeHit, vertexHit } from '../../domain/selection';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore, getVertex, type Vertex } from '../../domain/vertex';
import { createLiveEditBinding } from '../consistency-binding';
import { featuresAt, verticesAt } from '../live-lookup';
import { DEFAULT_DISPLAY_CONTROL } from '../state/session';
import { resolveDisplayFor } from './display-resolution-cache';
import { edgeAddMidpoint } from './edge-click';
import { createEditSessionPort } from './edit-session-adapter';
import { buildEditSnapshot, buildMovingRings, ringIdForLeafVertex } from './edit-session-snapshot';
import { NO_MODIFIERS } from './ports';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090', 'default', 1, 1);
const TIME = timePointYear(0);
const NEW = asVertexId('new-1');
const v = (id: string, lon: number, lat: number): Vertex =>
  createVertex(asVertexId(id), createCoordinate(lon, lat));
const leaf = (id: string, ids: readonly string[]): Feature =>
  createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(`${id}国`, 0, 100),
    COLOR,
    createShape([createTerritoryRing(asRingId(`${id}-r`), ids.map((x) => asVertexId(x)))]),
  );

/** A=(0,0)-(10,10)、B=(10,0)-(20,10)。共有辺は s1(10,0)–s2(10,10)。 */
function sharedEdgeProject(): DomainProject {
  const s1 = v('s1', 10, 0);
  const s2 = v('s2', 10, 10);
  return {
    histories: [
      singleAnchorHistory('A', [leaf('A', ['a0', 's1', 's2', 'a3'])], createVertexStore([v('a0', 0, 0), s1, s2, v('a3', 0, 10)]), 0),
      singleAnchorHistory('B', [leaf('B', ['s1', 'b1', 'b2', 's2'])], createVertexStore([s1, v('b1', 20, 0), v('b2', 20, 10), s2]), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/**
 * 経度 180° をまたぐ共有辺: s1(179,0)–s2(−179,0)。A は北側、B は南側。
 */
function seamProject(): DomainProject {
  const s1 = v('s1', 179, 0);
  const s2 = v('s2', -179, 0);
  return {
    histories: [
      singleAnchorHistory('A', [leaf('A', ['s1', 's2', 'a2', 'a3'])], createVertexStore([s1, s2, v('a2', -179, 10), v('a3', 179, 10)]), 0),
      singleAnchorHistory('B', [leaf('B', ['s2', 's1', 'b2', 'b3'])], createVertexStore([s2, s1, v('b2', 179, -10), v('b3', -179, -10)]), 0),
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

interface Harness {
  readonly port: ReturnType<typeof createEditSessionPort<DomainProject>>;
  readonly root: () => DomainProject;
  readonly commands: { undo: (s: DomainProject) => DomainProject; redo: (s: DomainProject) => DomainProject }[];
}

/** App と同じ組み方（`mount/hit-test.ts` の `createEditSessionPort` の結線を写したもの）。 */
function harness(initial: DomainProject, newIds: readonly VertexId[] = [NEW]): Harness {
  let root = initial;
  const commands: Harness['commands'] = [];
  const pending = [...newIds];
  const binding = createLiveEditBinding({ getRoot: () => root });
  const ctx = { getRoot: () => root, getTime: () => TIME };
  const port = createEditSessionPort<DomainProject>({
    screenToWorld: (p) => createCoordinate(p.x, p.y),
    ringIdForVertex: (hit) => ringIdForLeafVertex(ctx, hit.featureId, hit.vertexId),
    nextVertexId: () => pending.shift() ?? asVertexId('spare'),
    vertexSelection: () => EMPTY_SELECTION,
    anchorTime: () => TIME,
    currentState: () => root,
    ports: binding.ports,
    buildSnapshot: (session) => buildEditSnapshot(ctx, session),
    movingRings: (session) => buildMovingRings(ctx, session),
    onReleased: (outcome) => {
      if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
      if (outcome.result.status !== PROCESS_STATUS.Committed) return;
      const command = outcome.result.command;
      root = outcome.result.state;
      commands.push({
        undo: (s) => command.undo(s).state,
        redo: (s) => command.redo(s).state,
      });
    },
    edgeClickPoint: (session) =>
      edgeAddMidpoint(resolveDisplayFor(root, TIME, DEFAULT_DISPLAY_CONTROL), session),
  });
  return { port, root: () => root, commands };
}

function ringOf(root: DomainProject, id: string): string[] {
  const f = featuresAt(root, TIME).find((x) => x.id === asFeatureId(id));
  if (f === undefined || f.kind !== FEATURE_KIND.Leaf) return [];
  return f.shape.rings.flatMap((r) => r.vertexIds.map(String));
}

/** 履歴 `historyId` の写しが持つ頂点 `id` の座標（隣の写しにも体が届いているかを見る）。 */
function bodyIn(root: DomainProject, historyId: string, id: VertexId) {
  const h = root.histories.find((x) => x.featureId === asFeatureId(historyId))!;
  const entry = h.series.entries[0]!;
  return getVertex(entry.anchor.snapshot.vertices, id)?.coordinate;
}

describe('辺の中点のクリック × 隣と共有している辺（App と同じ組み方）', () => {
  it('足した頂点は A と B の両方の輪に同じ頂点として入り、確定は 1 回だけ', () => {
    const before = sharedEdgeProject();
    const h = harness(before);
    h.port.begin(edgeHit(asFeatureId('A'), asVertexId('s1'), asVertexId('s2'), asRingId('A-r')), { x: 10, y: 4 }, NO_MODIFIERS);
    h.port.release({ x: 10, y: 4 }, false);
    expect(h.commands).toHaveLength(1);
    const after = h.root();
    expect(ringOf(after, 'A')).toEqual(['a0', 's1', 'new-1', 's2', 'a3']);
    expect(ringOf(after, 'B')).toEqual(['s1', 'b1', 'b2', 's2', 'new-1']);
    // 足した座標は押した点（10,4）ではなく辺のちょうど中点（10,5）。両方の写しに同じ体。
    expect(bodyIn(after, 'A', NEW)).toEqual(createCoordinate(10, 5));
    expect(bodyIn(after, 'B', NEW)).toEqual(createCoordinate(10, 5));
    // 足したもの以外は何も変わっていない（頂点の数・ほかの頂点の座標）。
    const vb = verticesAt(before, TIME);
    const va = verticesAt(after, TIME);
    expect(va.byId.size).toBe(vb.byId.size + 1);
    for (const [id, body] of vb.byId) expect(getVertex(va, id)).toEqual(body);
  });

  it('取り消し 1 回で足す前とまるごと同じ値に戻り、やり直しで足したあとに戻る', () => {
    const before = sharedEdgeProject();
    const h = harness(before);
    h.port.begin(edgeHit(asFeatureId('A'), asVertexId('s1'), asVertexId('s2'), asRingId('A-r')), { x: 10, y: 5 }, NO_MODIFIERS);
    h.port.release({ x: 10, y: 5 }, false);
    const after = h.root();
    const undone = h.commands[0]!.undo(after);
    expect(undone).toEqual(before);
    expect(h.commands[0]!.redo(undone)).toEqual(after);
  });

  it('足した頂点をあとでドラッグすると、A と B の境界が一緒に動く（隙間ができない）', () => {
    const h = harness(sharedEdgeProject());
    h.port.begin(edgeHit(asFeatureId('A'), asVertexId('s1'), asVertexId('s2'), asRingId('A-r')), { x: 10, y: 5 }, NO_MODIFIERS);
    h.port.release({ x: 10, y: 5 }, false);
    // 足した頂点を A の内側へ 3 動かす。
    h.port.begin(vertexHit(asFeatureId('A'), NEW), { x: 10, y: 5 }, NO_MODIFIERS);
    h.port.update({ x: 7, y: 5 });
    h.port.release({ x: 7, y: 5 }, true);
    expect(h.commands).toHaveLength(2);
    const moved = h.root();
    expect(bodyIn(moved, 'A', NEW)).toEqual(createCoordinate(7, 5));
    expect(bodyIn(moved, 'B', NEW)).toEqual(createCoordinate(7, 5));
    expect(ringOf(moved, 'B')).toContain('new-1');
  });

  it('保存して読み直しても、両方の輪が同じ頂点を引いたまま', () => {
    const h = harness(sharedEdgeProject());
    h.port.begin(edgeHit(asFeatureId('A'), asVertexId('s1'), asVertexId('s2'), asRingId('A-r')), { x: 10, y: 5 }, NO_MODIFIERS);
    h.port.release({ x: 10, y: 5 }, false);
    // 保存（manifest を JSON の文字列へ）→ 開く（Zod の境界を通して読み直す）。
    const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(h.root()))));
    if (!isParsed(parsed)) throw new Error(`読み直せない: ${parsed.message}`);
    const reopened = manifestToProject(parsed.manifest);
    expect(ringOf(reopened, 'A')).toEqual(['a0', 's1', 'new-1', 's2', 'a3']);
    expect(ringOf(reopened, 'B')).toEqual(['s1', 'b1', 'b2', 's2', 'new-1']);
    expect(getVertex(verticesAt(reopened, TIME), NEW)?.coordinate).toEqual(createCoordinate(10, 5));
  });

  it('経度 180° をまたぐ共有辺でも、中点（経度 ±180°）が両方に入り、取り消しで戻る', () => {
    const before = seamProject();
    const h = harness(before);
    h.port.begin(edgeHit(asFeatureId('A'), asVertexId('s1'), asVertexId('s2'), asRingId('A-r')), { x: 180, y: 0 }, NO_MODIFIERS);
    h.port.release({ x: 180, y: 0 }, false);
    expect(h.commands).toHaveLength(1);
    const after = h.root();
    expect(ringOf(after, 'A')).toEqual(['s1', 'new-1', 's2', 'a2', 'a3']);
    expect(ringOf(after, 'B')).toEqual(['s2', 'new-1', 's1', 'b2', 'b3']);
    const at = bodyIn(after, 'B', NEW)!;
    expect(Math.abs(at.lon)).toBeCloseTo(180, 9);
    expect(at.lat).toBeCloseTo(0, 9);
    expect(h.commands[0]!.undo(after)).toEqual(before);
  });
});
