// U26 — split edit-proposal assembly (FR-44 / FR-93 / FR-94 / FR-95).
//
// Pure domain logic that turns a geometric {@link SplitResult} + the user's
// 継承先選択 (InheritanceChoice) + the非継承側 properties (from U23's add flow) into
// ONE indivisible {@link SplitEditProposal} for U13 (spec §実装方針 8 / FR-59 一体
// 性). The proposal bundles, as a single value:
//   - the継承先側 feature: SAME feature id / parent / anchors の同一性を保ったまま形状
//     だけが分割後へ変化 (FR-44),
//   - the非継承側 new terminal feature: a fresh id, U23 properties, and上位領域を元
//     末端地物から初期継承 (FR-44 と整合),
//   - every newly-minted vertex (両側のリングが参照する; 教訓5.20 依存データも保存),
//   - 旧→新頂点対応写像 (VertexRemap) — the material U11's `transferSharing` consumes
//     to引き継ぐ共有頂点関係 (FR-95). This unit GENERATES the map; U11 owns the rule.
//
// 集約地物は受け取らない (FR-44 / 教訓5.25): assembly takes the geometry SplitResult,
// which is only produced for a leaf target by split-geometry's gate.
//
// ID minting is delegated to injected ports so the proposal stays pure and
// deterministic (NFR 5.8 / 教訓5.37); redo replays the recorded ids rather than
// re-minting (教訓5.20) — the ids live in the returned snapshot as plain data.

import type { BasicAttributes, ColorInfo } from '../attributes';
import { type WorldCoordinate } from '../coordinate';
import { quantizeCoordinate } from '../geometry/index';
import type { GeoMultiPolygon } from '../geometry/types';
import {
  createLeafFeature,
  withLeafShape,
  type LeafFeature,
} from '../feature';
import { createEditProposal, type EditProposal } from '../consistency/index';
import { ringStrictlyContains } from '../geometry/index';
import type { TimePoint } from '../time/time-point';
import type { FeatureId, RingId, VertexId } from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
  type Ring,
  type Shape,
} from '../ring';
import { containerKey, type SharedEdgeCutSpec, type VertexRemap } from '../shared-vertex';
import { createVertex, type Vertex } from '../vertex';
import { type EdgeCutPoint, type SplitResult, type SplitSide } from './split-geometry';

// ---------------------------------------------------------------------------
// 継承先選択 (spec §成果物 InheritanceChoice 相当)
// ---------------------------------------------------------------------------

export const INHERITANCE_SIDE = {
  A: 'a',
  B: 'b',
} as const;

export type InheritanceSide = (typeof INHERITANCE_SIDE)[keyof typeof INHERITANCE_SIDE];

/**
 * Which side keeps the original feature's identity (FR-93). The non-chosen side
 * becomes a new terminal feature. The UI seeds this from the小さい方 preview but
 * the user confirms it (教訓5.3/5.4: UI 文脈を第一候補に, never a fixed default).
 */
export interface InheritanceChoice {
  readonly inherit: InheritanceSide;
}

export function createInheritanceChoice(inherit: InheritanceSide): InheritanceChoice {
  return { inherit };
}

// ---------------------------------------------------------------------------
// 非継承側 properties (re-used from U23's add入力フロー; FR-93 / FR-97)
// ---------------------------------------------------------------------------

/**
 * The基本属性 the非継承側 new feature gets, captured by U23's面情報追加入力フォーム
 * (FR-76 / FR-97). This unit does NOT build a form (教訓5.30 過少共有); it consumes
 * the U23 result. `parentId` is supplied by the assembler (上位領域を元末端から初期
 * 継承), not by this struct.
 */
export interface NonInheritedProperties {
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  readonly kindLabel?: string;
}

// ---------------------------------------------------------------------------
// ID ports (injected; pure & deterministic)
// ---------------------------------------------------------------------------

export interface SplitIdPorts {
  readonly nextFeatureId: () => FeatureId;
  readonly nextVertexId: () => VertexId;
  readonly nextRingId: () => RingId;
}

// ---------------------------------------------------------------------------
// MultiPolygon → Shape (mint ring + vertex ids; 片落とし禁止 教訓5.1)
// ---------------------------------------------------------------------------

interface BuiltShape {
  readonly shape: Shape;
  /** Coordinate (quantized) → minted vertex id, for old→new remap matching. */
  readonly byCoord: ReadonlyMap<string, VertexId>;
}

function coordKey(c: WorldCoordinate): string {
  const q = quantizeCoordinate(c);
  return `${q.lon},${q.lat}`;
}

/** A raw ring carried from the boolean output with its minted id + coordinates. */
interface RawRing {
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  /** The coordinate ring (for containment tests during re-parenting). */
  readonly coords: GeoMultiPolygon[number][number];
  /** True for a polygon piece's index-0 ring (an outer/territory boundary). */
  readonly isOuter: boolean;
}

/**
 * Build a {@link Shape} from a side's GeoMultiPolygon, minting a vertex per ring
 * coordinate and a ring id per ring, then RE-PARENTING the rings into a valid
 * 領土→穴→領土→… alternating hierarchy (FR-24 / FR-91) by CONTAINMENT — not by the
 * raw boolean output index. EVERY piece and EVERY ring is materialised (片落とし
 * 禁止, 教訓5.1).
 *
 * FR-91 reorganization is realised here, not assumed:
 *   - (a) A穴 the cut crossed comes back from U06 as a concavity of an outer ring
 *     (not a hole ring) on each side — it is automatically a territory boundary.
 *   - (b) An enclave that sat inside a destroyed hole comes back as its OWN outer
 *     polygon piece; containment re-parenting finds it sits inside NO surviving
 *     hole, so it stays a top-level territory — i.e. promoted one level (穴 → 外周
 *     直下) exactly as FR-91 requires.
 *   - (c) An UNTOUCHED hole comes back as a hole ring; an UNTOUCHED enclave inside
 *     it comes back as a separate outer piece. Containment re-parenting nests the
 *     enclave back INSIDE that hole (territory→hole→territory), restoring the
 *     parent-child relationship the flat boolean output cannot express.
 *
 * Re-parenting uses U06 `pointInPolygon` (delegated containment; 教訓5.30) and is
 * finite: each ring's parent is the SMALLEST-area ring of the opposite kind that
 * strictly contains it, so the chain alternates territory/hole and cannot loop.
 *
 * Vertex IDs are minted from a SHARED `pool` (a coordKey→VertexId registry common
 * to BOTH sides) so a coordinate lying on the shared cut SEAM resolves to the SAME
 * minted VertexId on the inheritor side and the new-feature side (Codex H2: a
 * per-side registry minted two different ids for one physical seam node, which
 * silently breaks U11 ID-based共有/transferSharing — moving the seam vertex on one
 * feature would not move it on the other, opening gaps/overlaps on later edits).
 * Each Vertex value is materialised exactly once (the first side to reach a key
 * pushes it into the shared `pool.vertices`; 片落とし禁止 教訓5.1, no duplicates). The
 * returned per-side `byCoord` records which seam/ring keys this side referenced,
 * for the old→new remap match — ids in it are the shared pool's ids.
 */
interface VertexPool {
  /** coordKey → minted VertexId, shared across both split sides (seam identity). */
  readonly byKey: Map<string, VertexId>;
  /** Every minted Vertex, each materialised once across both sides. */
  readonly vertices: Vertex[];
}

function createVertexPool(): VertexPool {
  return { byKey: new Map(), vertices: [] };
}

function buildShapeFromSide(side: SplitSide, ids: SplitIdPorts, pool: VertexPool): BuiltShape {
  // Keys this side referenced → their (shared-pool) ids, for old→new remap match.
  const byCoord = new Map<string, VertexId>();

  const mintRingVertices = (ring: GeoMultiPolygon[number][number]): VertexId[] => {
    const out: VertexId[] = [];
    for (const c of ring) {
      const key = coordKey(c);
      let vid = pool.byKey.get(key);
      if (vid === undefined) {
        // First time this physical coordinate is seen on EITHER side: mint once.
        vid = ids.nextVertexId();
        pool.byKey.set(key, vid);
        pool.vertices.push(createVertex(vid, quantizeCoordinate(c)));
      }
      byCoord.set(key, vid);
      out.push(vid);
    }
    return out;
  };

  // 1. Mint ids + vertices for every ring, tagging outer (index 0) vs hole.
  const raws: RawRing[] = [];
  for (const poly of side.area) {
    poly.forEach((ring, index) => {
      raws.push({
        id: ids.nextRingId(),
        vertexIds: mintRingVertices(ring),
        coords: ring,
        isOuter: index === 0,
      });
    });
  }

  // 2. Re-parent by containment into the alternating hierarchy (FR-24 / FR-91).
  const rings = reparentByContainment(raws);
  return { shape: createShape(rings), byCoord };
}

/** Signed-area magnitude of a coordinate ring (for "smallest enclosing" choice). */
function ringAreaAbs(ring: GeoMultiPolygon[number][number]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return Math.abs(sum) / 2;
}

/**
 * True iff `inner` ring lies strictly inside `outer` ring.
 *
 * Delegates to the shared {@link ringStrictlyContains} predicate (单一真实源,
 * same logic that backs U06's hole↔outer invariant). A lone `inner[0]` vertex
 * probe was fragile: after a split, ring vertices are quantized and an
 * enclave/hole's first vertex frequently lands exactly ON a shared seam boundary
 * of the candidate outer/hole, where `pointInPolygon` returns Boundary (not
 * Inside) — so the old probe reported "not contained" for a genuinely nested
 * ring, and {@link reparentByContainment} would wrongly promote/demote it to a
 * top-level territory (mis-classifying an untouched enclave/hole, FR-91). The
 * robust predicate tests no-vertex-outside + no-edge-stretch-outside + has-real-
 * interior-inside, so an on-boundary seam vertex no longer fools it.
 */
function ringContains(
  outer: GeoMultiPolygon[number][number],
  inner: GeoMultiPolygon[number][number],
): boolean {
  return ringStrictlyContains(outer, inner);
}

/**
 * Re-parent raw rings into a valid alternating hierarchy by containment. Each
 * ring's parent is the SMALLEST-area ring of the OPPOSITE kind that contains it;
 * an outer ring contained in a hole becomes an enclave territory parented to that
 * hole, a hole contained in a territory is parented to that territory, and a ring
 * with no opposite-kind container is a top-level territory (FR-91 一段昇格 falls out
 * of "no surviving hole contains me"). Pure; no mutation of inputs.
 */
function reparentByContainment(raws: readonly RawRing[]): Ring[] {
  const areaOf = new Map<RingId, number>();
  for (const r of raws) areaOf.set(r.id, ringAreaAbs(r.coords));

  const rings: Ring[] = [];
  for (const r of raws) {
    // Find the smallest-area OPPOSITE-kind ring that strictly contains r.
    let bestParent: RawRing | undefined;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const cand of raws) {
      if (cand.id === r.id) continue;
      if (cand.isOuter === r.isOuter) continue; // parent must alternate kind.
      if (!ringContains(cand.coords, r.coords)) continue;
      const a = areaOf.get(cand.id) ?? Number.POSITIVE_INFINITY;
      if (a < bestArea) {
        bestArea = a;
        bestParent = cand;
      }
    }

    if (r.isOuter) {
      // An outer ring is a territory: top-level, or an enclave inside a hole.
      if (bestParent === undefined) {
        rings.push(createTerritoryRing(r.id, r.vertexIds));
      } else {
        rings.push(createTerritoryRing(r.id, r.vertexIds, bestParent.id));
      }
    } else {
      // A hole must sit inside a territory; the smallest containing outer.
      if (bestParent === undefined) {
        // No containing territory (should not happen for U06 output): demote to a
        // top-level territory rather than emit an orphan hole (keeps alternation
        // valid; 教訓5.1 片落とし禁止 — never drop the ring).
        rings.push(createTerritoryRing(r.id, r.vertexIds));
      } else {
        rings.push(createHoleRing(r.id, r.vertexIds, bestParent.id));
      }
    }
  }
  return rings;
}

// ---------------------------------------------------------------------------
// 旧→新頂点対応写像 (FR-95; U11 `transferSharing` consumes it)
// ---------------------------------------------------------------------------

/**
 * Build the old→new vertex remap by matching each ORIGINAL target vertex's
 * quantized coordinate to a newly-minted vertex at the same grid node on either
 * rebuilt side. A vertex that survived the split (its coordinate appears in a new
 * ring) maps to the new id; an old vertex with no surviving coordinate (e.g. an
 * unrelated corner consumed by the boolean op) is simply absent — U11 leaves
 * absent ids as-is (FR-95 引き継ぎは対応がある頂点のみ). The map repoints shared
 * citations onto the new vertices so共有関係が新頂点へ転写される (教訓: U11 owns the
 * actual transfer; we only supply the mapping material).
 */
function buildRemap(
  originalStore: ReadonlyMap<VertexId, Vertex>,
  targetVertexIds: ReadonlySet<VertexId>,
  byCoordSides: readonly ReadonlyMap<string, VertexId>[],
): VertexRemap {
  const remap = new Map<VertexId, VertexId>();
  for (const oldId of targetVertexIds) {
    const old = originalStore.get(oldId);
    if (old === undefined) continue;
    const key = coordKey(old.coordinate);
    for (const byCoord of byCoordSides) {
      const newId = byCoord.get(key);
      if (newId !== undefined) {
        remap.set(oldId, newId);
        break;
      }
    }
  }
  return remap;
}

// ---------------------------------------------------------------------------
// SplitEditProposal (spec §成果物 SplitEditProposal 相当)
// ---------------------------------------------------------------------------

/**
 * A共有辺途中切断点 carried on the proposal (FR-95). It pins the cut coordinate to a
 * specific edge of the ORIGINAL target feature (by container key + edge start),
 * so the host can resolve the共有相手 (partner) edge from the U11 reverse index and
 * drive `insertSharedEdgeCut`. The two edge endpoint vertex ids let the host match
 * the partner edge (an edge of another container citing BOTH endpoints — i.e. a
 * shared edge). This is the material U26 generates; U11 owns the actual insertion.
 */
export interface SplitSharedEdgeCut {
  /** The original target feature whose edge the cut crosses. */
  readonly featureId: FeatureId;
  /** The ring of that feature carrying the crossed edge. */
  readonly ringId: RingId;
  /** Index of the edge's start vertex within the ring's vertexId list. */
  readonly edgeStartIndex: number;
  /** The crossed edge's endpoint vertex ids (for partner-edge matching). */
  readonly edgeStartVertexId: VertexId;
  readonly edgeEndVertexId: VertexId;
  /** The quantize-aligned cut-point coordinate (same node on both features). */
  readonly cutCoordinate: WorldCoordinate;
}

/**
 * The indivisible split edit案 for U13 (spec §実装方針 8 / FR-94). Carries the
 * 継承先側更新 + 非継承側新規生成 + 新頂点 as ONE value; U13 applies it (and any
 * 競合解決) as a single undo unit (FR-73 / FR-94). The proposal is opaque to U13:
 * the host's U13 port reads these fields to apply the change and to wire共有頂点
 * via U11 (using `vertexRemap`). 部分確定禁止 (FR-59): every field is applied together.
 */
export interface SplitEditProposal {
  /** The feature kept whole (SAME id; only its shape changes — FR-44). */
  readonly inheritorFeatureId: FeatureId;
  /** The継承先側 feature's new shape (form change of the original feature). */
  readonly inheritorShape: Shape;
  /** The newly-created非継承側 terminal feature (fresh id; FR-44). */
  readonly newFeature: LeafFeature;
  /** Every newly-minted vertex BOTH features reference (教訓5.20 依存データ). */
  readonly vertices: readonly Vertex[];
  /** 旧→新頂点対応写像 (FR-95) — U11 `transferSharing` consumes this. */
  readonly vertexRemap: VertexRemap;
  /**
   * 共有辺途中切断点情報 (FR-95) — the cut points where the分断線 crossed an existing
   * target edge mid-way. The host resolves each to a {@link SharedEdgeCutSpec}
   * (via {@link toSharedEdgeCutSpecs}) and drives U11 `insertSharedEdgeCut`. Empty
   * when no edge was cut mid-way (closed cut, or all crossings hit existing nodes).
   */
  readonly sharedEdgeCuts: readonly SplitSharedEdgeCut[];
  /** Feature ids the command touches (継承先 + 新規); for symmetric notify (教訓5.23). */
  readonly touchedFeatureIds: readonly FeatureId[];
}

export interface AssembleSplitInput {
  /** The original target leaf feature (its identity continues on the継承先側). */
  readonly target: LeafFeature;
  /** The vertex store BEFORE the split (for old-vertex coordinate lookup). */
  readonly store: ReadonlyMap<VertexId, Vertex>;
  readonly result: SplitResult;
  readonly choice: InheritanceChoice;
  readonly nonInherited: NonInheritedProperties;
  readonly ids: SplitIdPorts;
}

/** The non-inherited side inherits the original's parent (上位領域初期継承; FR-44). */
function newFeatureOptional(
  target: LeafFeature,
  kindLabel: string | undefined,
): { kindLabel?: string; parentId?: FeatureId } {
  const parentId = target.parentId;
  if (kindLabel === undefined) {
    return parentId === undefined ? {} : { parentId };
  }
  return parentId === undefined ? { kindLabel } : { kindLabel, parentId };
}

/**
 * Assemble the {@link SplitEditProposal} (spec §成果物 主関数 3). The継承先 side is
 * decided by `choice.inherit`; that side rebuilds the ORIGINAL feature's shape
 * (same id / parent / attributes / anchors continue — FR-44), and the other side
 * becomes a NEW leaf feature carrying the U23 properties and the original's parent
 * (FR-44 と整合). All minted vertices from BOTH sides are bundled (教訓5.20), and the
 * old→new vertex remap is produced for U11 (FR-95).
 */
export function assembleSplitProposal(input: AssembleSplitInput): SplitEditProposal {
  const { target, store, result, choice, nonInherited, ids } = input;

  const inheritSide = choice.inherit === INHERITANCE_SIDE.A ? result.sideA : result.sideB;
  const newSide = choice.inherit === INHERITANCE_SIDE.A ? result.sideB : result.sideA;

  // ONE shared vertex pool across both sides so a shared-seam coordinate resolves
  // to the SAME minted VertexId on both the inheritor and the new feature (FR-95 /
  // Codex H2). Build the inheritor side first so the seam ids it mints are reused
  // (not re-minted) by the new side.
  const pool = createVertexPool();
  const builtInherit = buildShapeFromSide(inheritSide, ids, pool);
  const builtNew = buildShapeFromSide(newSide, ids, pool);

  // 継承先: keep the original feature, swap only its shape (form change; FR-44).
  const inheritorShape = builtInherit.shape;

  // 非継承側: new terminal feature, U23 properties, inherited parent.
  const newFeatureId = ids.nextFeatureId();
  const optional = newFeatureOptional(target, nonInherited.kindLabel);
  const newFeature = createLeafFeature(
    newFeatureId,
    nonInherited.attributes,
    nonInherited.color,
    builtNew.shape,
    optional,
  );

  const targetVertexIds = collectVertexIds(target);
  const vertexRemap = buildRemap(store, targetVertexIds, [
    builtInherit.byCoord,
    builtNew.byCoord,
  ]);

  // U07 / FR-24: the re-parented hierarchy on BOTH sides MUST satisfy the
  // 領土→穴→領土→… alternation. buildShapeFromSide builds it by containment so this
  // holds by construction; we assert it (教訓5.26: 確定前に同じサービスで検証) so a
  // future change that breaks alternation fails loudly rather than committing a
  // broken shape. Delegated to U07's ring-hierarchy validator (過少共有 5.30).
  if (!isAlternationValid(inheritorShape) || !isAlternationValid(builtNew.shape)) {
    throw new Error('split produced an invalid ring hierarchy (FR-24 alternation)');
  }

  // FR-95: carry the共有辺途中切断点情報 from the geometry result onto the proposal,
  // pinned to the ORIGINAL target's edges so the host can resolve the partner edge.
  const sharedEdgeCuts = result.edgeCuts.map((cut) =>
    toSplitSharedEdgeCut(target.id, cut),
  );

  return {
    inheritorFeatureId: target.id,
    inheritorShape,
    newFeature,
    vertices: pool.vertices,
    vertexRemap,
    sharedEdgeCuts,
    touchedFeatureIds: [target.id, newFeatureId],
  };
}

/** Convert a geometry {@link EdgeCutPoint} into a proposal {@link SplitSharedEdgeCut}. */
function toSplitSharedEdgeCut(featureId: FeatureId, cut: EdgeCutPoint): SplitSharedEdgeCut {
  return {
    featureId,
    ringId: cut.ringId,
    edgeStartIndex: cut.edgeStartIndex,
    edgeStartVertexId: cut.edgeStartVertexId,
    edgeEndVertexId: cut.edgeEndVertexId,
    cutCoordinate: cut.coordinate,
  };
}

/** Every vertex id referenced by the target leaf's rings. */
function collectVertexIds(target: LeafFeature): ReadonlySet<VertexId> {
  const set = new Set<VertexId>();
  for (const ring of target.shape.rings) {
    for (const vid of ring.vertexIds) set.add(vid);
  }
  return set;
}

/**
 * Convenience: produce the继承先 feature value (the original with its new shape).
 * The host applies this alongside `newFeature` in the same undo unit (FR-94).
 */
export function inheritorFeature(target: LeafFeature, proposal: SplitEditProposal): LeafFeature {
  return withLeafShape(target, proposal.inheritorShape);
}

// ---------------------------------------------------------------------------
// U11 wiring — resolve共有辺途中切断点 → SharedEdgeCutSpec (FR-95, §実装方針6)
// ---------------------------------------------------------------------------

/**
 * Resolve a partner edge for a cut: given the primary edge's two endpoint vertex
 * ids, find the container key + edge-start index of ANOTHER container whose
 * consecutive pair cites the SAME two vertex ids (in either order) — i.e. the
 * 共有辺 (shared edge) on the partner feature. Returns undefined when no partner
 * shares the edge (the cut edge is not shared; no U11 insertion is needed).
 *
 * The container vertexId lists are supplied by the host from the U11 state (this
 * unit does not own that state — 過少共有 5.30). Pure.
 */
export type EdgeContainerLists = ReadonlyMap<string, readonly VertexId[]>;

interface PartnerEdge {
  readonly containerKey: string;
  readonly edgeStart: number;
}

/**
 * Whether a container key names an OPEN path (a line) rather than a CLOSED ring.
 * The kind is encoded in the key by {@link containerKey}: `ring:<feature>:<ring>`
 * is closed (last↔first edge real); `line:<feature>` is an open path with NO
 * closing edge. Resolving openness from the key (the single key format) keeps
 * this in lock-step with U11's container model without widening the type that
 * the host supplies (it carries only vertexId lists).
 */
function isOpenContainerKey(key: string): boolean {
  return key.startsWith('line:');
}

function findPartnerEdge(
  primaryKey: string,
  startVid: VertexId,
  endVid: VertexId,
  containers: EdgeContainerLists,
): PartnerEdge | undefined {
  for (const [key, ids] of containers) {
    if (key === primaryKey) continue;
    const n = ids.length;
    // A closed ring has edges 0..n-1 (the n-1↔0 closing edge is real); an OPEN
    // line path has edges 0..n-2 — it has NO wrap edge, so the last→first pair is
    // phantom and must never be matched as a partner (would target edgeStart n-1
    // on a non-existent edge; bug-hunt: line containers treated as closed rings).
    const open = isOpenContainerKey(key);
    const edgeCount = open ? n - 1 : n;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = ids[i];
      const b = ids[(i + 1) % n];
      if (a === undefined || b === undefined) continue;
      if ((a === startVid && b === endVid) || (a === endVid && b === startVid)) {
        return { containerKey: key, edgeStart: i };
      }
    }
  }
  return undefined;
}

/**
 * Turn the proposal's共有辺途中切断点 into U11 {@link SharedEdgeCutSpec}s (FR-95 /
 * §実装方針6). For each cut, the primary container is the ring on the target leaf
 * (`ring:<featureId>:<ringId>`, matching U11's {@link containerKey}); the partner
 * edge is resolved from `containers` (the host's U11 container vertexId lists) by
 * matching the cut edge's two endpoint vertex ids. Cuts whose edge is NOT shared
 * (no partner) yield no spec — they need no共有相手 insertion. The host feeds each
 * returned spec to `insertSharedEdgeCut`; both-side契約 is固定 by test (§5.34).
 */
export function toSharedEdgeCutSpecs(
  proposal: SplitEditProposal,
  containers: EdgeContainerLists,
): SharedEdgeCutSpec[] {
  const specs: SharedEdgeCutSpec[] = [];
  for (const cut of proposal.sharedEdgeCuts) {
    const primaryKey = containerKey({
      kind: 'ring',
      featureId: cut.featureId,
      ringId: cut.ringId,
    });
    const partner = findPartnerEdge(
      primaryKey,
      cut.edgeStartVertexId,
      cut.edgeEndVertexId,
      containers,
    );
    if (partner === undefined) continue; // edge not shared → no partner insertion.
    specs.push({
      primary: { containerKey: primaryKey, edgeStart: cut.edgeStartIndex },
      partner,
      cutCoordinate: cut.cutCoordinate,
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// U13 wiring — adapt SplitEditProposal → EditProposal<Snapshot> (FR-94, §実装方針8)
// ---------------------------------------------------------------------------

/**
 * The opaque snapshot a U13 {@link EditProposal} carries for a split: BOTH the
 * 継承先側 (updated shape on the same feature id) and the非継承側 (new feature) plus
 * every minted vertex and the共有頂点継続 material, packed as ONE value. U13 never
 * reads inside this (it is generic over `Snapshot`); the host's `applyProposal`
 * port unpacks it to apply継承先更新 + 新規生成 atomically (1 不可分コマンド = 2 地物,
 * FR-94). Packing both features in one snapshot is exactly how U26 expresses "2
 * 地物同時確定 in a single anchor proposal" within U13's 1-proposal model.
 */
export interface SplitSnapshot {
  readonly inheritorFeatureId: FeatureId;
  readonly inheritorShape: Shape;
  readonly newFeature: LeafFeature;
  readonly vertices: readonly Vertex[];
  readonly vertexRemap: VertexRemap;
  readonly sharedEdgeCuts: readonly SplitSharedEdgeCut[];
  readonly touchedFeatureIds: readonly FeatureId[];
}

/** Pack a {@link SplitEditProposal} into a U13 snapshot value. Pure. */
export function toSplitSnapshot(proposal: SplitEditProposal): SplitSnapshot {
  return {
    inheritorFeatureId: proposal.inheritorFeatureId,
    inheritorShape: proposal.inheritorShape,
    newFeature: proposal.newFeature,
    vertices: proposal.vertices,
    vertexRemap: proposal.vertexRemap,
    sharedEdgeCuts: proposal.sharedEdgeCuts,
    touchedFeatureIds: proposal.touchedFeatureIds,
  };
}

/**
 * Adapt a {@link SplitEditProposal} into a U13 {@link EditProposal} (FR-94 /
 * §実装方針8). The anchored feature is the継承先 (its identity continues); the
 * complete split (継承先更新 + 非継承側新規 + 頂点 + 共有継続) rides in the opaque
 * snapshot so U13 confirms ALL of it as ONE indivisible undo unit. `anchorTime` is
 * the start the edit confirms at (supplied by the caller — UI 文脈優先, 教訓5.3).
 */
export function toEditProposal(
  proposal: SplitEditProposal,
  anchorTime: TimePoint,
): EditProposal<SplitSnapshot> {
  return createEditProposal(
    proposal.inheritorFeatureId,
    anchorTime,
    toSplitSnapshot(proposal),
  );
}
