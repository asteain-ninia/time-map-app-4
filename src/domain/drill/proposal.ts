// U27 — 穴あけ編集案組み立て (FR-45 / FR-94 / FR-59 / FR-57).
//
// Pure domain logic that turns a geometric {@link DrillGeometry} + the新地物の初期
// プロパティ into ONE indivisible {@link DrillEditProposal} for U13 (spec §実装方針 /
// FR-59 完全状態の一体編集). The proposal bundles, as a single value:
//   - the元末端地物への穴形成: the SAME feature id / parent / attributes / anchors の
//     同一性を保ったまま形状だけが「穴を含む形状」へ変化 (FR-45 同一性保持),
//   - the新独立末端地物: a fresh id, the carved region as its領土リング, and上位領域を
//     元末端地物から初期継承 (FR-45 上位領域の初期継承),
//   - every newly-minted vertex BOTH features reference (教訓5.20 依存データも保存),
//   - the touched feature ids for symmetric notify (教訓5.23).
//
// 対概念分離 (教訓2.10 / 5.25 / 5.30): this assembler ALWAYS yields BOTH a holed
// original AND a new feature — it has NO path that produces "形状編集のみ" (that is
// U25's job, FR-23). The new feature id is minted exactly once; redo replays the
// recorded id rather than re-minting (教訓5.20) — the id lives in the returned
// snapshot as plain data.
//
// 集約地物は受け取らない (FR-35 / 教訓5.25): assembly takes a {@link DrillGeometry},
// which is only produced for a leaf target by `drill-geometry`'s gate, AND the
// `target` field is typed as {@link LeafFeature}.

import type { BasicAttributes, ColorInfo } from '../attributes';
import { type WorldCoordinate } from '../coordinate';
import { quantizeCoordinate } from '../geometry/index';
import { normalizeCoordinate } from '../geo/index';
import type { GeoMultiPolygon } from '../geometry/types';
import {
  createLeafFeature,
  withLeafShape,
  type LeafFeature,
} from '../feature';
import { createEditProposal, type EditProposal } from '../consistency/index';
import { pointInPolygon, POINT_LOCATION } from '../geometry/index';
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
import { createVertex, getVertex, type Vertex, type VertexStore } from '../vertex';
import { type DrillGeometry } from './drill-geometry';

// ---------------------------------------------------------------------------
// 新地物の初期プロパティ (re-used from U23's add入力フロー; FR-97)
// ---------------------------------------------------------------------------

/**
 * The基本属性 the new drilled-out feature gets, captured by U23's面情報追加入力フォーム
 * (FR-76 / FR-97). This unit does NOT build a form (教訓5.30 過少共有); it consumes the
 * U23 result. `parentId` is supplied by the assembler (上位領域を元末端から初期継承,
 * FR-45), not by this struct.
 */
export interface NewFeatureProperties {
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  readonly kindLabel?: string;
}

// ---------------------------------------------------------------------------
// ID ports (injected; pure & deterministic)
// ---------------------------------------------------------------------------

export interface DrillIdPorts {
  readonly nextFeatureId: () => FeatureId;
  readonly nextVertexId: () => VertexId;
  readonly nextRingId: () => RingId;
}

// ---------------------------------------------------------------------------
// MultiPolygon → Shape (mint ring + vertex ids; 片落とし禁止 教訓5.1)
// ---------------------------------------------------------------------------

interface BuiltShape {
  readonly shape: Shape;
  readonly vertices: readonly Vertex[];
}

/**
 * 量子化座標のキー。経度は representative 分岐 [-180,180) に畳んでから量子化する:
 * drill-geometry は target 外環の参照経度へ全入力を anchor して連続フレーム (>180° を
 * 取り得る) で boolean 演算するため、シームを跨ぐ辺は boolean 出力上 190° のような連続値
 * になり得る (drill-geometry.ts referenceLonForMultiPolygon / alignMultiPolygon)。一方、
 * 旧頂点ストアは representative で格納される。periodic に同一の点が同じキーに落ちるよう
 * 先に normalize することで、原末端の未変更外周頂点との突き合わせ (buildExistingSeed) が
 * world-turn ズレで取りこぼされない (knife/merge の coordKey と単一真実源)。旧頂点は既に
 * representative なので normalize は恒等。
 */
function coordKey(c: WorldCoordinate): string {
  const q = quantizeCoordinate(normalizeCoordinate(c));
  return `${q.lon},${q.lat}`;
}

/**
 * Build the coordKey → EXISTING VertexId seed from the target leaf's OWN vertices
 * (its ring vertex bodies resolved through `store`). The holed-original side reuses
 * these ids for any output coordinate that quantize-matches an existing target vertex
 * — its UNCHANGED outer boundary — so a boundary vertex the target shares with a
 * neighbour by id keeps that SAME id (共有関係が保存される; data整合・波7同クラス).
 * Truly-new coordinates (the hole ring, carved from the region's interior) are absent
 * from the seed and get a fresh minted id as before. The new-feature side is built
 * WITHOUT this seed (its interior vertices are genuinely new; minting fresh ids there
 * is minimal and correct — 対概念分離). Pure.
 */
function buildExistingSeed(target: LeafFeature, store: VertexStore): Map<string, Vertex> {
  const seed = new Map<string, Vertex>();
  for (const ring of target.shape.rings) {
    for (const vid of ring.vertexIds) {
      const vertex = getVertex(store, vid);
      if (vertex === undefined) continue; // unresolvable ids are checkDrillable's concern.
      // First id per coordinate key wins (deterministic); an old coincident duplicate
      // is not re-introduced (single truth per grid node).
      const key = coordKey(vertex.coordinate);
      if (!seed.has(key)) seed.set(key, vertex);
    }
  }
  return seed;
}

/** A raw ring carried from the boolean output with its minted id + coordinates. */
interface RawRing {
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  readonly coords: GeoMultiPolygon[number][number];
  /** True for a polygon piece's index-0 ring (an outer/territory boundary). */
  readonly isOuter: boolean;
}

/**
 * Build a {@link Shape} from a GeoMultiPolygon, minting a vertex per ring coordinate
 * and a ring id per ring, then RE-PARENTING the rings into a valid 領土→穴→領土→…
 * alternating hierarchy (FR-24) by CONTAINMENT — not by the raw boolean output
 * index. EVERY piece and EVERY ring is materialised (片落とし禁止, 教訓5.1).
 *
 * For the holed-original side this realises the穴: the subtracted region comes back
 * from U06 difference as a HOLE ring nested inside the surviving territory, so the
 * containment re-parent nests it correctly (territory→hole). For the new-feature
 * side the carved region is a single territory piece (no hole).
 *
 * 向き正規化は U06 を信頼し再実装しない (注意点・単一の真実源): we never re-orient
 * rings; containment is decided by U06 `pointInPolygon`.
 *
 * `existing` (holed side only): a coordKey → EXISTING target Vertex seed. When an
 * output coordinate quantize-matches an existing target vertex (the UNCHANGED outer
 * boundary), its EXISTING id + body are REUSED — never re-minted — so a boundary
 * vertex shared with a neighbour by id keeps that id (共有継続; data整合・波7同クラス /
 * Option 1). Only truly-new coordinates (the hole ring) mint a fresh id. The
 * new-feature side passes no seed (its interior vertices are genuinely new).
 */
function buildShapeFromArea(
  area: GeoMultiPolygon,
  ids: DrillIdPorts,
  existing?: ReadonlyMap<string, Vertex>,
): BuiltShape {
  const vertices: Vertex[] = [];
  const byCoord = new Map<string, VertexId>();

  const mintRingVertices = (ring: GeoMultiPolygon[number][number]): VertexId[] => {
    const out: VertexId[] = [];
    for (const c of ring) {
      const key = coordKey(c);
      let vid = byCoord.get(key);
      if (vid === undefined) {
        const reuse = existing?.get(key);
        if (reuse !== undefined) {
          // Unchanged outer-boundary vertex: reuse its existing id AND body so the
          // share (same id cited by a neighbour) survives the drill, and the bundled
          // snapshot self-resolves the id (単一真実源, no dangling ref).
          vid = reuse.id;
          vertices.push(reuse);
        } else {
          vid = ids.nextVertexId();
          vertices.push(createVertex(vid, quantizeCoordinate(normalizeCoordinate(c))));
        }
        byCoord.set(key, vid);
      }
      out.push(vid);
    }
    return out;
  };

  const raws: RawRing[] = [];
  for (const poly of area) {
    poly.forEach((ring, index) => {
      raws.push({
        id: ids.nextRingId(),
        vertexIds: mintRingVertices(ring),
        coords: ring,
        isOuter: index === 0,
      });
    });
  }

  const rings = reparentByContainment(raws);
  return { shape: createShape(rings), vertices };
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

/** True iff `inner`'s representative point lies strictly inside `outer`. */
function ringContains(
  outer: GeoMultiPolygon[number][number],
  inner: GeoMultiPolygon[number][number],
): boolean {
  const probe = inner[0];
  if (probe === undefined) return false;
  return pointInPolygon(probe, [outer]) === POINT_LOCATION.Inside;
}

/**
 * Re-parent raw rings into a valid alternating hierarchy by containment. Each ring's
 * parent is the SMALLEST-area ring of the OPPOSITE kind that strictly contains it;
 * a top-level outer ring is a territory, a hole inside a territory is parented to it,
 * an enclave inside a hole is parented to that hole (FR-24 交互). Pure; no mutation.
 */
function reparentByContainment(raws: readonly RawRing[]): Ring[] {
  const areaOf = new Map<RingId, number>();
  for (const r of raws) areaOf.set(r.id, ringAreaAbs(r.coords));

  const rings: Ring[] = [];
  for (const r of raws) {
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
      if (bestParent === undefined) {
        rings.push(createTerritoryRing(r.id, r.vertexIds));
      } else {
        rings.push(createTerritoryRing(r.id, r.vertexIds, bestParent.id));
      }
    } else if (bestParent === undefined) {
      // No containing territory (should not happen for U06 output): demote to a
      // top-level territory rather than emit an orphan hole (keeps alternation
      // valid; 教訓5.1 片落とし禁止 — never drop the ring).
      rings.push(createTerritoryRing(r.id, r.vertexIds));
    } else {
      rings.push(createHoleRing(r.id, r.vertexIds, bestParent.id));
    }
  }
  return rings;
}

// ---------------------------------------------------------------------------
// DrillEditProposal (spec §成果物)
// ---------------------------------------------------------------------------

/**
 * The indivisible 穴あけ編集案 for U13 (spec §実装方針 / FR-94). Carries the
 * 元末端地物への穴形成 + 新独立末端地物の生成 + 新頂点 as ONE value; U13 confirms ALL of
 * it as a single undo unit (FR-73 / FR-94). 部分確定禁止 (FR-59): every field applies
 * together.
 */
export interface DrillEditProposal {
  /** The original feature kept whole (SAME id; only its shape changes — FR-45). */
  readonly originalFeatureId: FeatureId;
  /** The元末端地物's new shape: the original area with the region as a穴 (FR-45). */
  readonly holedShape: Shape;
  /** The newly-created独立末端地物 (fresh id; FR-45). */
  readonly newFeature: LeafFeature;
  /**
   * The上位領域 the new feature initially inherited from the original末端地物 (FR-45).
   * `undefined` ⇔ the original was top-level, so the new feature is also top-level
   * (FR-39「最上位フラグ真＝親なし」の同値を満たす; 教訓5.18 「親なし」を明示状態として扱う).
   */
  readonly inheritedParentId: FeatureId | undefined;
  /** Every newly-minted vertex BOTH features reference (教訓5.20 依存データ). */
  readonly vertices: readonly Vertex[];
  /** Feature ids the command touches (原末端 + 新規 + 継承親); symmetric notify (教訓5.23). */
  readonly touchedFeatureIds: readonly FeatureId[];
}

export interface AssembleDrillInput {
  /** The original target leaf feature (its identity continues on the holed side). */
  readonly target: LeafFeature;
  /**
   * The vertex store BEFORE the drill (for reusing the target's UNCHANGED outer
   * boundary vertex ids on the holed side — 共有継続 / data整合 Option 1). Mirrors
   * {@link AssembleSplitInput}'s `store`.
   */
  readonly store: VertexStore;
  /** The geometry computed by `drill-geometry` (holed original + carved region). */
  readonly geometry: DrillGeometry;
  /** The new feature's initial properties (from U23's add入力フロー). */
  readonly newProperties: NewFeatureProperties;
  readonly ids: DrillIdPorts;
}

/** The new feature inherits the original's parent (上位領域初期継承; FR-45). */
function newFeatureOptional(
  parentId: FeatureId | undefined,
  kindLabel: string | undefined,
): { kindLabel?: string; parentId?: FeatureId } {
  if (kindLabel === undefined) {
    return parentId === undefined ? {} : { parentId };
  }
  return parentId === undefined ? { kindLabel } : { kindLabel, parentId };
}

/**
 * Assemble the {@link DrillEditProposal} (spec §成果物 主関数). The holed side rebuilds
 * the ORIGINAL feature's shape (same id / parent / attributes / anchors continue —
 * FR-45 同一性保持); the carved region becomes a NEW leaf feature carrying the U23
 * properties and the original's parent (FR-45 上位領域初期継承). All minted vertices
 * from BOTH sides are bundled (教訓5.20).
 *
 * 上位領域の初期継承 (FR-45 / 受け入れ基準2): the new feature's parent is the
 * original's `parentId`. When the original is top-level (parentId absent), the new
 * feature is top-level too — we treat "親なし" as an explicit state (教訓5.18), never
 * a falsy short-circuit, so「最上位⇔親なし」(FR-39) holds for the new feature.
 */
export function assembleDrillProposal(input: AssembleDrillInput): DrillEditProposal {
  const { target, store, geometry, newProperties, ids } = input;

  // 原末端の未変更外周頂点は再採番せず既存 id を再利用する (共有継続 / data整合 Option 1):
  // holed side だけに existing seed を渡す。新地物 (newRegion) の内部頂点は従来どおり新規
  // 採番 (対概念分離) — seed 無しで組み立てる。
  const existing = buildExistingSeed(target, store);
  const builtHoled = buildShapeFromArea(geometry.holedOriginal, ids, existing);
  const builtNew = buildShapeFromArea(geometry.newRegion, ids);

  // 上位領域の初期継承 (FR-45): the new feature's parent == the original's parent.
  const inheritedParentId = target.parentId;

  const newFeatureId = ids.nextFeatureId();
  const optional = newFeatureOptional(inheritedParentId, newProperties.kindLabel);
  const newFeature = createLeafFeature(
    newFeatureId,
    newProperties.attributes,
    newProperties.color,
    builtNew.shape,
    optional,
  );

  // U07 / FR-24: BOTH rebuilt shapes MUST satisfy the領土→穴→領土→… alternation.
  // buildShapeFromArea builds it by containment so this holds by construction; we
  // assert it (教訓5.26: 確定前に同じサービスで検証) so a future change that breaks
  // alternation fails loudly rather than committing a broken shape (U07 validator).
  if (!isAlternationValid(builtHoled.shape) || !isAlternationValid(builtNew.shape)) {
    throw new Error('drill produced an invalid ring hierarchy (FR-24 alternation)');
  }

  return {
    originalFeatureId: target.id,
    holedShape: builtHoled.shape,
    newFeature,
    inheritedParentId,
    vertices: [...builtHoled.vertices, ...builtNew.vertices],
    touchedFeatureIds: touchedIds(target.id, newFeatureId, inheritedParentId),
  };
}

/** Touched ids: the original末端 + the new feature + the継承親 (if any), de-duplicated. */
function touchedIds(
  originalId: FeatureId,
  newId: FeatureId,
  parentId: FeatureId | undefined,
): FeatureId[] {
  const set = new Set<FeatureId>([originalId, newId]);
  if (parentId !== undefined) set.add(parentId);
  return [...set];
}

/**
 * Convenience: produce the holed原末端地物 value (the original with its new shape).
 * The host applies this alongside `newFeature` in the same undo unit (FR-94).
 */
export function holedOriginalFeature(
  target: LeafFeature,
  proposal: DrillEditProposal,
): LeafFeature {
  return withLeafShape(target, proposal.holedShape);
}

// ---------------------------------------------------------------------------
// U13 wiring — adapt DrillEditProposal → EditProposal<Snapshot> (FR-94)
// ---------------------------------------------------------------------------

/**
 * The opaque snapshot a U13 {@link EditProposal} carries for a drill: BOTH the
 * 原末端側 (holed shape on the same feature id) and the新地物側 (new feature) plus
 * every minted vertex, packed as ONE value. U13 never reads inside this (it is
 * generic over `Snapshot`); the host's `applyProposal` port unpacks it to apply
 * 穴形成 + 新規生成 atomically (1 不可分コマンド = 2 地物, FR-94). Packing both features
 * in one snapshot is exactly how U27 expresses "2 地物同時確定 in a single anchor
 * proposal" within U13's 1-proposal model.
 */
export interface DrillSnapshot {
  readonly originalFeatureId: FeatureId;
  readonly holedShape: Shape;
  readonly newFeature: LeafFeature;
  readonly inheritedParentId: FeatureId | undefined;
  readonly vertices: readonly Vertex[];
  readonly touchedFeatureIds: readonly FeatureId[];
}

/** Pack a {@link DrillEditProposal} into a U13 snapshot value. Pure. */
export function toDrillSnapshot(proposal: DrillEditProposal): DrillSnapshot {
  return {
    originalFeatureId: proposal.originalFeatureId,
    holedShape: proposal.holedShape,
    newFeature: proposal.newFeature,
    inheritedParentId: proposal.inheritedParentId,
    vertices: proposal.vertices,
    touchedFeatureIds: proposal.touchedFeatureIds,
  };
}

/**
 * Adapt a {@link DrillEditProposal} into a U13 {@link EditProposal} (FR-94). The
 * anchored feature is the原末端地物 (its identity continues; FR-45 同一性保持); the
 * complete drill (穴形成 + 新地物生成 + 頂点) rides in the opaque snapshot so U13
 * confirms ALL of it as ONE indivisible undo unit. `anchorTime` is the編集基準時刻
 * (現在選択時刻) the edit confirms at (supplied by the caller — UI 文脈優先 / FR-57;
 * U13/U09 record it as the feature's history anchor downstream, 同時刻があれば更新・
 * なければ新規追加 — spec §編集基準時刻).
 */
export function toEditProposal(
  proposal: DrillEditProposal,
  anchorTime: TimePoint,
): EditProposal<DrillSnapshot> {
  return createEditProposal(
    proposal.originalFeatureId,
    anchorTime,
    toDrillSnapshot(proposal),
  );
}
