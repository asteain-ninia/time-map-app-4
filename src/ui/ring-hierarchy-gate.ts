// UI layer (U44 binding): 穴・飛び地の形を壊す編集を **確定の前に** 止める関門（増分 8E / G-14）。
//
// **これが直すもの**（現状分析 §6.2 の G-14、§11-5 の申し送り）: 穴・飛び地の頂点の移動・
// 追加・削除は `domain/editing/edit-ops` を直接呼ぶので、U07 の環の整合（包含・非交差・
// 非重複）を確定前に通っていなかった。増分 8E の探針（実機の E2E）で確かめた結果:
//   - 穴の頂点を **親の外周の外** へ引き出す → 通らない（ドラッグ中の拘束が外周の縁で止める）
//   - 穴の頂点を **隣の穴の中** へ入れる → **通ってしまう**。穴どうしの辺が交わった形が
//     「素性の変更を行いました」で記録された（ドラッグ中の拘束は外周しか見ていない）
// 編集の束ね（`createLiveEditBinding`）の `checkConstraints` が空を返していたのが根で、
// 確定の手続き（U13）の「編集制約の再検証」が素通りだった。ここがその中身である。
//
// 判定は輪郭の道具と **同じ 1 本**（`validateCandidate` → U07 `validateRingHierarchy`）を通す
// （教訓 5.26 / 5.29: 実時間の判定と確定前の判定を同じ関数にする）。
//
// **新しく壊したものだけを止める。** 編集の前から整合していなかった形（古いデータ）は、
// 名前を直しただけで保存できなくなると困るので止めない ―― 「この編集で壊れたか」を
// 編集の前の同じ地物と比べて決める（所有者の裁定「削除以外でデータが勝手に消えるのは
// 良くない」の裏側: 直していないものを理由に、関係のない編集を断らない）。
//
// 比べるのは **違反の集合** である（増分 8E の手直し。GPT 重 3）。最初の版は「編集の前に
// 何か 1 つでも違反があったか」で見ていたので、もとから壊れていた面では、別の穴を隣の穴へ
// 入れるような **新しい破損も素通し** していた。いまは違反 1 件ずつ（種類・環・相手の環）を
// 編集の前と後で比べ、**後にだけある違反** があれば、面がもとから壊れていても断る。
// もとからある違反だけが残っている（または減った）なら止めない。「親の外へ出る」違反は、
// 交わる（はみ出す）と完全に外を同じ組の違反と読む（外へ出ていた穴を戻す途中は止めない）。
// ただし、はみ出す → 完全に外 の悪化は新しい破損として断る（再手直し。再検証 2-1）。
//
// 断ったときの文は、**どの面のどの年の形が壊れるか** を添える（増分 8E の手直し。反証 2-2）。
// 壊れるのは引いた面とは別の面（頂点を共有している隣の面の穴）や、画面に見えていない後ろの
// 年（座標の引き継ぎ先）のことがあるので、それを言わないと利用者は何を直せばよいか分からない。
// 呼び名と年の書き方は、関門が違反を見つけた時点の姿から作って記録に入れておく（文を組む
// 側が地物を引き直さなくて済み、App の結線を変えずに済む）。
//
// **1 本の輪そのものの形**（自己交差と長さ 0 の辺。FR-32）も同じ断り方で止める
// （{@link ringShapeViolationsIntroduced}）。穴と飛び地の判定は輪が 2 つ以上の面しか見ないので別の関数に
// した。実データには元から自己交差している輪があるので、こちらも「この編集で増えたか」で比べる。

import { resolveAt } from '../domain/anchor-series';
import type { RejectedResult } from '../domain/consistency/index';
import type { WorldCoordinate } from '../domain/coordinate';
import { FEATURE_KIND, type LeafFeature } from '../domain/feature';
import { unwrapRingClosed } from '../domain/geo/seam';
import { quantizeRing, ringSelfCrossingCount, ringZeroLengthEdgeCount } from '../domain/geometry/index';
import type { FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import { RING_KIND, type Shape } from '../domain/ring';
import { validateCandidate } from '../domain/ring-edit/index';
import { RING_VIOLATION, type RingViolation } from '../domain/ring-hierarchy';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import type { TimePoint } from '../domain/time/time-point';
import { getVertex, type VertexStore } from '../domain/vertex';

import { createdAtOf, participantDisplayName } from './conflict/participant-name';
import { featuresAt, verticesAt } from './live-lookup';
import { formatTimePoint } from './timeline/time-display';
import { RING_BREAK_PHRASE_TEXT, RING_HIERARCHY_GATE_STRINGS } from './strings';

/** 違反の印（確定の手続きの `detail` に入る。画面の文を選ぶのに使う）。 */
export const RING_HIERARCHY_GATE_KIND = 'ring-hierarchy' as const;

/**
 * 壊れ方の大づかみな分類（文の言い方を選ぶのに使う）。U07 の違反の種類と、違反した環が
 * 穴か飛び地かから決める。
 */
export const RING_BREAK = {
  /** 穴と穴が交わる・重なる。 */
  HolesCross: 'holes-cross',
  /** 飛び地と飛び地が交わる・重なる（外周どうし・穴の中の飛び地どうし）。 */
  EnclavesCross: 'enclaves-cross',
  /** 穴が外周からはみ出す（外周と交わる・外周の外へ出る）。 */
  HoleLeavesOuter: 'hole-leaves-outer',
  /** 穴の中の飛び地が穴からはみ出す。 */
  EnclaveLeavesHole: 'enclave-leaves-hole',
  /** それ以外（環の親子の組み方が崩れる）。 */
  Other: 'other',
  /** 1 本の輪が自分自身と交わる（FR-32）。 */
  SelfCross: 'self-cross',
  /** 1 本の輪に長さ 0 の辺ができる（FR-32）。 */
  ZeroLengthEdge: 'zero-length-edge',
} as const;
export type RingBreak = (typeof RING_BREAK)[keyof typeof RING_BREAK];

/** 断った編集の種類（文の動詞を選ぶ）。既定は「動かした」。 */
export const EDIT_OPERATION = {
  Move: 'move',
  DeleteVertex: 'delete-vertex',
} as const;
export type EditOperation = (typeof EDIT_OPERATION)[keyof typeof EDIT_OPERATION];

/** この編集で新しく壊れた面 1 つぶんの違反。 */
export interface RingHierarchyGateViolation {
  readonly kind: typeof RING_HIERARCHY_GATE_KIND;
  readonly featureId: FeatureId;
  readonly at: TimePoint;
  /**
   * **この編集で新しく生まれた** 違反だけ（もとからあったものは入れない）。輪そのものの形の違反
   * （{@link ringShapeViolationsIntroduced}）は U07 の違反ではないので空。
   */
  readonly violations: readonly RingViolation[];
  /** 1 件目の違反の壊れ方（文の言い方）。 */
  readonly breaks: RingBreak;
  /** 壊れる面の呼び名（名前が空なら「名前のない面（1200年に作成）」。内部 ID は出さない）。 */
  readonly featureName: string;
  /** 壊れる年の書き方（「1500年」）。 */
  readonly atLabel: string;
  /** 断った編集の種類（削除の経路が {@link tagRejectionOperation} で付ける）。 */
  readonly operation?: EditOperation;
  /** 削除の経路で、消そうとした頂点の数。 */
  readonly vertexCount?: number;
}

/** 壊れ方ごとの言い方（「〜形になるためです」「〜ので」の〜の部分）。 */
const BREAK_PHRASE: Readonly<Record<RingBreak, string>> = {
  [RING_BREAK.HolesCross]: RING_BREAK_PHRASE_TEXT.holesCross,
  [RING_BREAK.EnclavesCross]: RING_BREAK_PHRASE_TEXT.enclavesCross,
  [RING_BREAK.HoleLeavesOuter]: RING_BREAK_PHRASE_TEXT.holeLeavesOuter,
  [RING_BREAK.EnclaveLeavesHole]: RING_BREAK_PHRASE_TEXT.enclaveLeavesHole,
  [RING_BREAK.Other]: RING_BREAK_PHRASE_TEXT.other,
  [RING_BREAK.SelfCross]: RING_BREAK_PHRASE_TEXT.selfCross,
  [RING_BREAK.ZeroLengthEdge]: RING_BREAK_PHRASE_TEXT.zeroLengthEdge,
};

/** 画面に出す文（何が起きたか → なぜか → 次に何をするか。設計書 §H.5）。 */
export { RING_HIERARCHY_GATE_STRINGS };

function isLeaf(feature: { readonly kind: string }): feature is LeafFeature {
  return feature.kind === FEATURE_KIND.Leaf;
}

/**
 * 環が 2 つ以上ある面だけが、環どうしの関係（包含・交差・重なり）を持つ。外周 1 つだけの
 * 面は調べても違反が出ないので、ここで飛ばす（実データの大半はこれで、確定のたびに
 * 全頂点を引き直す費用を払わずに済む）。
 */
function hasRingRelations(feature: LeafFeature): boolean {
  return feature.shape.rings.length >= 2;
}

/**
 * `before`（編集の前）から `after`（確定しようとしている姿）で **新しく壊れた面** を返す。
 * 空なら通す。
 *
 * 見るのは「参照が変わった系列の、参照が変わった錨」だけである（ドメインは不変なので、
 * 触っていない系列・錨は同じ参照のまま残る）。その錨に載っている面のうち環を 2 つ以上
 * 持つものを、その錨の年の姿で U07 に掛ける。壊れていたら、編集の前の同じ年の同じ面も
 * 掛け、**編集の前には無かった違反**（種類・環・相手の環の組）が 1 つでもあれば断る。
 * 編集の前からあった違反だけなら（古いデータ）止めない。
 */
export function ringHierarchyViolationsIntroduced(
  before: DomainProject,
  after: DomainProject,
): RingHierarchyGateViolation[] {
  if (before === after) return [];
  const beforeById = new Map<FeatureId, FeatureHistory>();
  for (const h of before.histories) beforeById.set(h.featureId, h);

  const out: RingHierarchyGateViolation[] = [];
  for (const history of after.histories) {
    const prior = beforeById.get(history.featureId);
    if (prior === history) continue;
    const priorAnchors = new Set(prior?.series.entries.map((e) => e.anchor) ?? []);
    for (const entry of history.series.entries) {
      if (priorAnchors.has(entry.anchor)) continue;
      const candidates = entry.anchor.snapshot.features.filter(
        (f): f is LeafFeature => isLeaf(f) && hasRingRelations(f),
      );
      if (candidates.length === 0) continue;
      const at = entry.start;
      // 頂点は系列をまたいで共有されうるので、その年に効いている頂点全体で引く
      // （地図に描くのと同じ引き方。教訓 5.29）。
      const effective = new Map(featuresAt(after, at).map((f) => [f.id, f]));
      const store = verticesAt(after, at);
      for (const candidate of candidates) {
        const live = effective.get(candidate.id);
        const leaf = live !== undefined && isLeaf(live) ? live : candidate;
        const result = validateCandidate(leaf.shape, store);
        if (result.valid) continue;
        const prior = violationKeysBefore(before, candidate.id, at);
        const fresh = result.violations.filter((v) => isNewViolation(v, prior));
        if (fresh.length === 0) continue;
        out.push({
          kind: RING_HIERARCHY_GATE_KIND,
          featureId: candidate.id,
          at,
          violations: fresh,
          breaks: breakOf(fresh[0]!, leaf.shape),
          featureName: participantDisplayName(
            leaf,
            createdAtOf(after.histories, candidate.id, getCalendar(after.settings.calendarId)),
          ),
          atLabel: formatTimePoint(at),
        });
      }
    }
  }
  return out;
}

/** 輪 1 本の形の傷の数。 */
interface RingFlaws {
  readonly zeroLength: number;
  readonly crossings: number;
}

const NO_FLAWS: RingFlaws = { zeroLength: 0, crossings: 0 };

/**
 * 輪の座標（`store` から引く）。引けない頂点があれば undefined（壊れた参照は読み込みの検査の仕事）。
 */
function ringCoordinates(
  vertexIds: readonly VertexId[],
  store: VertexStore,
): WorldCoordinate[] | undefined {
  const out: WorldCoordinate[] = [];
  for (const id of vertexIds) {
    const vertex = getVertex(store, id);
    if (vertex === undefined) return undefined;
    out.push(vertex.coordinate);
  }
  return out;
}

/**
 * 輪の傷を数える。保存の座標は経度 180 度で畳まれているので、**連続の座標へ戻してから** 測る（§5.107。
 * 畳んだまま測ると、継ぎ目にかかる輪は元から交差していることになり、新しい交差が隠れる）。長さ 0 の辺は
 * 量子化で消えるので先に数える。
 */
function ringFlaws(coordinates: readonly WorldCoordinate[]): RingFlaws {
  const continuous = unwrapRingClosed(coordinates);
  return {
    zeroLength: ringZeroLengthEdgeCount(continuous),
    crossings: ringSelfCrossingCount(quantizeRing(continuous)),
  };
}

function sameCoordinates(a: readonly WorldCoordinate[], b: readonly WorldCoordinate[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.lon !== b[i]!.lon || a[i]!.lat !== b[i]!.lat) return false;
  }
  return true;
}

/** `flaws` に、`prior` より増えた傷があるか。増えた傷の種類を返す（長さ 0 の辺を先に言う）。 */
function grownFlaw(flaws: RingFlaws, prior: RingFlaws): RingBreak | undefined {
  if (flaws.zeroLength > prior.zeroLength) return RING_BREAK.ZeroLengthEdge;
  if (flaws.crossings > prior.crossings) return RING_BREAK.SelfCross;
  return undefined;
}

/**
 * 面の輪で、この編集で **自己交差か長さ 0 の辺が増えたもの** の種類（無ければ undefined）。
 *
 * 比べる単位は輪の id ごとの傷の数である（§5.97。「前に何か 1 つでも傷があったか」にしない）。もとから
 * 交差している輪でも、交差がさらに増えれば止める。交差が移っただけ・減っただけなら止めない（直している
 * 途中を断らない）。重なりの解決は輪を新しい id で組み直すので、id が前に無い輪は、前にしか無い輪の傷の
 * 合計と比べる（もとから交差している面を削っても、削ったせいで断らない）。
 *
 * 形の変わらない輪は測らない（座標を比べるだけ）。名前の変更や錨の新設では費用がほぼ無い。
 */
function introducedRingFlaw(
  leaf: LeafFeature,
  store: VertexStore,
  prior: { readonly leaf: LeafFeature; readonly store: VertexStore } | undefined,
): RingBreak | undefined {
  const priorRings = new Map<RingId, readonly VertexId[]>();
  for (const ring of prior?.leaf.shape.rings ?? []) priorRings.set(ring.id, ring.vertexIds);
  const flawsOfPrior = (vertexIds: readonly VertexId[]): RingFlaws => {
    if (prior === undefined) return NO_FLAWS;
    const coordinates = ringCoordinates(vertexIds, prior.store);
    return coordinates === undefined ? NO_FLAWS : ringFlaws(coordinates);
  };
  const reborn = { zeroLength: 0, crossings: 0 };
  const stillHere = new Set<RingId>();
  for (const ring of leaf.shape.rings) {
    const coordinates = ringCoordinates(ring.vertexIds, store);
    if (coordinates === undefined) continue;
    const priorIds = priorRings.get(ring.id);
    if (priorIds === undefined) {
      const flaws = ringFlaws(coordinates);
      reborn.zeroLength += flaws.zeroLength;
      reborn.crossings += flaws.crossings;
      continue;
    }
    stillHere.add(ring.id);
    const priorCoordinates = prior === undefined ? undefined : ringCoordinates(priorIds, prior.store);
    if (priorCoordinates !== undefined && sameCoordinates(coordinates, priorCoordinates)) continue;
    const flaws = ringFlaws(coordinates);
    if (flaws.zeroLength === 0 && flaws.crossings === 0) continue;
    const grown = grownFlaw(flaws, flawsOfPrior(priorIds));
    if (grown !== undefined) return grown;
  }
  if (reborn.zeroLength === 0 && reborn.crossings === 0) return undefined;
  const gone = { zeroLength: 0, crossings: 0 };
  for (const [id, vertexIds] of priorRings) {
    if (stillHere.has(id)) continue;
    const flaws = flawsOfPrior(vertexIds);
    gone.zeroLength += flaws.zeroLength;
    gone.crossings += flaws.crossings;
  }
  return grownFlaw(reborn, gone);
}

/** 編集の前の、その年のその面と、それを引く頂点。同じ系列に無ければ（居候から系列へ起きた等）全体から引く。 */
function priorLeafAt(
  before: DomainProject,
  history: FeatureHistory | undefined,
  featureId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): { readonly leaf: LeafFeature; readonly store: VertexStore } | undefined {
  if (history !== undefined) {
    const resolution = resolveAt(history.series, at, calendar);
    if (resolution.kind === 'present') {
      const snapshot = resolution.entry.anchor.snapshot;
      const own = snapshot.features.find((f) => f.id === featureId);
      if (own !== undefined) return isLeaf(own) ? { leaf: own, store: snapshot.vertices } : undefined;
    }
  }
  const found = featuresAt(before, at).find((f) => f.id === featureId);
  return found !== undefined && isLeaf(found) ? { leaf: found, store: verticesAt(before, at) } : undefined;
}

/**
 * `before` から `after` で、**1 本の輪の自己交差か長さ 0 の辺が新しくできた面** を返す（FR-32）。
 *
 * 見る範囲は {@link ringHierarchyViolationsIntroduced} と同じ「参照が変わった系列の、参照が変わった錨」。
 * 外周 1 本の面も見る。頂点はその錨の写しから引く（読み込みの検査が、同じ年の同じ頂点の体が写しごとに
 * 違うことを断るので、地図と同じ座標になる）。年ごとに全部の頂点を集め直すと、後の年へ引き継いだ大きな
 * 編集で確定が重くなる。
 */
export function ringShapeViolationsIntroduced(
  before: DomainProject,
  after: DomainProject,
): RingHierarchyGateViolation[] {
  if (before === after) return [];
  const calendar = getCalendar(after.settings.calendarId);
  const beforeById = new Map<FeatureId, FeatureHistory>();
  for (const h of before.histories) beforeById.set(h.featureId, h);

  const out: RingHierarchyGateViolation[] = [];
  for (const history of after.histories) {
    const priorHistory = beforeById.get(history.featureId);
    if (priorHistory === history) continue;
    const priorAnchors = new Set(priorHistory?.series.entries.map((e) => e.anchor) ?? []);
    for (const entry of history.series.entries) {
      if (priorAnchors.has(entry.anchor)) continue;
      const at = entry.start;
      const { features, vertices } = entry.anchor.snapshot;
      for (const feature of features) {
        if (!isLeaf(feature)) continue;
        const prior = priorLeafAt(before, priorHistory, feature.id, at, calendar);
        const breaks = introducedRingFlaw(feature, vertices, prior);
        if (breaks === undefined) continue;
        out.push({
          kind: RING_HIERARCHY_GATE_KIND,
          featureId: feature.id,
          at,
          violations: [],
          breaks,
          featureName: participantDisplayName(
            feature,
            createdAtOf(after.histories, feature.id, calendar),
          ),
          atLabel: formatTimePoint(at),
        });
      }
    }
  }
  return out;
}

/** 相手の環との関係が対称な（どちらの環の名で記録されてもよい）違反。 */
function isSymmetric(kind: RingViolation['kind']): boolean {
  return kind === RING_VIOLATION.SiblingsOverlap || kind === RING_VIOLATION.EnclavesOverlap;
}

/**
 * 違反 1 件の見分けの鍵（種類・環・相手の環）。対称な違反は 2 つの環を並べ替えて、
 * 「A が B と重なる」と「B が A と重なる」を同じ違反と読む。
 */
export function violationKey(v: RingViolation): string {
  const related = v.relatedRingId ?? '';
  if (isSymmetric(v.kind) && related !== '') {
    const [x, y] = [String(v.ringId), String(related)].sort();
    return `${v.kind}|${x!}|${y!}`;
  }
  return `${v.kind}|${String(v.ringId)}|${String(related)}`;
}

/**
 * 「親の外へ出る」違反の 2 つの種類（**交わる**＝はみ出す／**完全に外**）を 1 つに寄せた種類
 * （増分 8E の再手直し。再検証 2-1）。U07 は同じ（子の環・親の環）の組でも、交わるなら
 * `*-crosses-parent`、完全に外なら `*-not-contained` と別の種類で記録する。種類まで鍵に入れて
 * いた版は、外へ出ていた穴を 1 頂点ずつ戻す途中（完全に外 → はみ出す。**良くなった**）を
 * 「後にだけある違反」と読んで断っていた。
 */
const OUTSIDE_PARENT_KIND: Partial<Record<RingViolation['kind'], string>> = {
  [RING_VIOLATION.HoleCrossesParent]: 'hole-outside-parent',
  [RING_VIOLATION.HoleNotContained]: 'hole-outside-parent',
  [RING_VIOLATION.NestedTerritoryCrossesParent]: 'nested-territory-outside-parent',
  [RING_VIOLATION.NestedTerritoryNotContained]: 'nested-territory-outside-parent',
};

/** 「完全に外」の種類（はみ出す → 完全に外 は **悪化** なので、引き続き新しい破損と読む）。 */
const FULLY_OUTSIDE_KINDS: ReadonlySet<RingViolation['kind']> = new Set([
  RING_VIOLATION.HoleNotContained,
  RING_VIOLATION.NestedTerritoryNotContained,
]);

/**
 * 違反 1 件のゆるい鍵: {@link violationKey} と同じだが、「親の外へ出る」の 2 種類を 1 つに寄せる。
 */
export function looseViolationKey(v: RingViolation): string {
  const merged = OUTSIDE_PARENT_KIND[v.kind];
  return merged === undefined ? violationKey(v) : `${merged}|${String(v.ringId)}|${String(v.relatedRingId ?? '')}`;
}

/** 編集の前の違反の鍵（そのままの鍵と、ゆるい鍵）。 */
export interface PriorViolationKeys {
  readonly exact: ReadonlySet<string>;
  readonly loose: ReadonlySet<string>;
}

/**
 * 編集の後の違反 1 件が **新しい破損** か。
 *   - 同じ組の「親の外へ出る」違反が前に無かった → 新しい
 *   - 前と同じ鍵 → 新しくない（もとからある）
 *   - 同じ組で種類だけ変わった: はみ出す → 完全に外（悪化）は新しい、完全に外 → はみ出す
 *     （戻している途中。良くなった）は新しくない
 */
export function isNewViolation(v: RingViolation, prior: PriorViolationKeys): boolean {
  if (!prior.loose.has(looseViolationKey(v))) return true;
  if (prior.exact.has(violationKey(v))) return false;
  return FULLY_OUTSIDE_KINDS.has(v.kind);
}

/** 編集の前の同じ年の同じ面が持っていた違反の鍵（無ければ空＝壊れていなかった）。 */
function violationKeysBefore(
  before: DomainProject,
  featureId: FeatureId,
  at: TimePoint,
): PriorViolationKeys {
  const prior = featuresAt(before, at).find((f) => f.id === featureId);
  if (prior === undefined || !isLeaf(prior)) return { exact: new Set(), loose: new Set() };
  const result = validateCandidate(prior.shape, verticesAt(before, at));
  return {
    exact: new Set(result.violations.map(violationKey)),
    loose: new Set(result.violations.map(looseViolationKey)),
  };
}

/** 違反 1 件の壊れ方（文の言い方）。違反した環が穴か飛び地かを形から引く。 */
function breakOf(v: RingViolation, shape: Shape): RingBreak {
  const kindOf = (id: RingId | undefined) =>
    id === undefined ? undefined : shape.rings.find((r) => r.id === id)?.kind;
  switch (v.kind) {
    case RING_VIOLATION.SiblingsOverlap:
      return kindOf(v.ringId) === RING_KIND.Hole ? RING_BREAK.HolesCross : RING_BREAK.EnclavesCross;
    case RING_VIOLATION.EnclavesOverlap:
      return RING_BREAK.EnclavesCross;
    case RING_VIOLATION.HoleNotContained:
    case RING_VIOLATION.HoleCrossesParent:
      return RING_BREAK.HoleLeavesOuter;
    case RING_VIOLATION.NestedTerritoryNotContained:
    case RING_VIOLATION.NestedTerritoryCrossesParent:
      return RING_BREAK.EnclaveLeavesHole;
    default:
      return RING_BREAK.Other;
  }
}

function isGateViolation(v: unknown): v is RingHierarchyGateViolation {
  return (
    typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === RING_HIERARCHY_GATE_KIND
  );
}

/** 確定の手続きが返した違反の中に、この関門のものがあるか。 */
export function isRingHierarchyRejection(rejected: RejectedResult): boolean {
  const detail = rejected.detail;
  return Array.isArray(detail) && detail.some(isGateViolation);
}

/**
 * 断られた結果に「どの編集だったか」を付けた写しを返す（削除の経路が使う。文の動詞を
 * 「動かした」から「消すと」へ替えるため）。この関門の違反でなければ元のまま返す。
 */
export function tagRejectionOperation(
  rejected: RejectedResult,
  operation: EditOperation,
  vertexCount: number,
): RejectedResult {
  const detail = rejected.detail;
  if (!Array.isArray(detail) || !detail.some(isGateViolation)) return rejected;
  return {
    ...rejected,
    detail: detail.map((v: unknown) => (isGateViolation(v) ? { ...v, operation, vertexCount } : v)),
  };
}

/**
 * 編集が断られたときに状態行へ出す文。この関門で断ったなら、壊れ方と **どの面のどの年の
 * 形か** を添えた具体的な理由を、そうでなければ確定の手続きの文をそのまま出す。
 */
export function editRejectionMessage(rejected: RejectedResult): string {
  const detail = rejected.detail;
  if (!Array.isArray(detail)) return rejected.message;
  const first = detail.find(isGateViolation);
  if (first === undefined) return rejected.message;
  // 記録の中身が欠けている（古い形の記録）なら、言い方を選ばない一般の文にする。
  if (typeof first.featureName !== 'string' || typeof first.atLabel !== 'string') {
    return RING_HIERARCHY_GATE_STRINGS.refused;
  }
  const phrase = BREAK_PHRASE[first.breaks] ?? BREAK_PHRASE[RING_BREAK.Other];
  const where = RING_HIERARCHY_GATE_STRINGS.where(first.featureName, first.atLabel);
  if (first.operation === EDIT_OPERATION.DeleteVertex) {
    return (first.vertexCount ?? 1) > 1
      ? RING_HIERARCHY_GATE_STRINGS.refusedDeleteMany(phrase, where)
      : RING_HIERARCHY_GATE_STRINGS.refusedDeleteOne(phrase, where);
  }
  return RING_HIERARCHY_GATE_STRINGS.refusedMove(phrase, where);
}
