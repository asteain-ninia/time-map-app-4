// UI layer (U16 / 地図): 頂点の候補一覧の状態（設計書 §B.5 の台帳 #12 / V9）。
//
// **なぜ要るか**（§F.3 の実測）: 実データでは隣の頂点までの画面上の距離の中央値が
// **世界全体表示で 0.40〜0.44px**、×4 で 1.6〜1.75px、×16 で 6.4〜7.0px しかない。
// 掴める距離は 8px 以上なので、拡大しない限り **必ず隣も入る** ―― いちばん近い 1 つを
// 黙って掴む形だと「どれを掴んだのか分からないまま形が動く」。**候補が 2 つ以上ある
// ときは一覧を出して選ばせる。**
//
// React の外に置く理由は `CursorPositionStore` と同じ: 押し込むのは pointer の
// 経路（React の外）で、購読するのは一覧の 1 ノードだけである。
//
// 増分 8A で中身を入れた（器は増分 6）:
//   - 1 行の書式（「頂点 #412（34.10°N 12.51°E・アルラーク国と共有）」）。
//   - **出すのはクリックのときだけ**（押して動かさずに離したとき）。ドラッグは最寄りを
//     掴んで動かす操作なので、一覧は出さない（増分 6 では押した瞬間に出て、ドラッグの
//     あとも居座っていた）。
//   - 一覧から選んだ頂点は、**次にその近くを押したときに優先して掴まれる**
//     （{@link preferSelectedVertex}）。そうしないと「一覧から選ぶ → ドラッグ」で
//     最寄りの別の頂点が動いてしまい、V9 の 12.0 秒の経路が成り立たない。
//   - 世界・年・道具・表示・カメラが変わったら畳む（古い候補を押させない＝教訓 5.2）。

import type { FeatureId, VertexId } from '../../domain/ids';
import type { WorldCoordinate } from '../../domain/coordinate';
import { buildReverseIndex, createSharedVertexState } from '../../domain/shared-vertex';
import { getVertex } from '../../domain/vertex';
import { HIT_KIND, vertexHit, type HitResult } from '../../domain/selection';
import type { ScreenPoint } from '../../render';

import { exceedsDragThreshold } from './dispatch';
import type { DisplayResolution } from './display-resolution-cache';
import type { NearVertexCandidate } from './live-hit-test';
import { containersOf } from './shared-vertex-derivation';

/** 一覧に出す候補 1 つ。 */
export interface VertexCandidateRow {
  /** 選んだときに選択の持ち主にする地物（いま選んでいる地物が引いていればそれ）。 */
  readonly featureId: FeatureId;
  readonly vertexId: VertexId;
  /** 持ち主の表示名（引けなければ空文字）。 */
  readonly featureName: string;
  /** 1 行の本文（「頂点 #412（34.10°N 12.51°E・アルラーク国と共有）」）。 */
  readonly label: string;
  /** クリック位置からの画面上の距離（px）。 */
  readonly distancePx: number;
}

/** 一覧そのもの（出ていないときは null）。 */
export interface VertexCandidateState {
  /** 地図セルの左上からの位置（px）。一覧はこの右下 8px に出す。 */
  readonly x: number;
  readonly y: number;
  readonly rows: readonly VertexCandidateRow[];
  /** 行数の上限で畳んだ残りの件数（0 なら全部出ている）。 */
  readonly more: number;
}

export type VertexCandidateListener = (state: VertexCandidateState | null) => void;

/** 一覧 1 個を持つ極小 pub/sub。スナップショットの同一性は保つ。 */
export class VertexCandidateStore {
  private state: VertexCandidateState | null = null;
  private readonly listeners = new Set<VertexCandidateListener>();

  get(): VertexCandidateState | null {
    return this.state;
  }

  subscribe(listener: VertexCandidateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(state: VertexCandidateState): void {
    this.state = state;
    this.emit();
  }

  /**
   * 畳む。**Escape と地図の他所のクリックで必ず消える**（§B.5 の台帳 #12 の条件）ので、
   * 呼び出し側はその 2 つの経路から必ずここを通す。
   */
  clear(): void {
    if (this.state === null) return;
    this.state = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}

/** 一覧を出すのは候補が 2 つ以上あるときだけ（1 つならそのまま掴めばよい）。 */
export const VERTEX_CANDIDATE_MIN = 2;

/**
 * 一覧に並べる行の上限。世界全体表示では掴める距離の中に数十の頂点が入る（隣まで
 * 0.4px 台）ので、全部並べると選べない。近い順に並べて上限で畳み、残りの件数を出す。
 */
export const VERTEX_CANDIDATE_MAX_ROWS = 20;

// ---------------------------------------------------------------------------
// 掴める距離に居る頂点の「持ち主の全部」（現状.md B42 / 設計書 §E.1 V9）
// ---------------------------------------------------------------------------

/** 掴める距離に居る頂点 1 つに、座標と「引いている地物の全部」を足したもの。 */
export interface DescribedVertexCandidate extends NearVertexCandidate {
  readonly coordinate: WorldCoordinate;
  /**
   * この頂点を引いている地物の全部（重複なし・データの並び）。当たり判定の索引は
   * 共有頂点について **最初の持ち主しか覚えていない**（現状.md B42）ので、一覧の
   * 「…と共有」はここから作る。共有の判定は描画（琥珀の塗り）・右クリックの「共有を解く」と
   * 同じ 1 本（`containersOf` → `buildReverseIndex`）を通る（教訓 5.29）。
   */
  readonly citers: readonly FeatureId[];
}

const citerCache = new WeakMap<DisplayResolution, ReadonlyMap<VertexId, readonly FeatureId[]>>();

/**
 * 頂点 id → それを引いている地物の一覧。解決の束ごとに 1 回だけ作る（`sharedVertexIdsFor`
 * と同じ作法。束の同一性を鍵にする WeakMap）。深さで畳まれた地物も数える ―― 共有は
 * 表示の深さに依らない（`shared-vertex-derivation.ts` の注記）。
 */
export function vertexCitersFor(
  resolution: DisplayResolution,
): ReadonlyMap<VertexId, readonly FeatureId[]> {
  const cached = citerCache.get(resolution);
  if (cached !== undefined) return cached;
  const index = buildReverseIndex(
    createSharedVertexState(resolution.vertices, containersOf(resolution.features)),
  );
  const out = new Map<VertexId, FeatureId[]>();
  for (const [vid, refs] of index) {
    const ids: FeatureId[] = [];
    for (const ref of refs) {
      if (!ids.includes(ref.container.featureId)) ids.push(ref.container.featureId);
    }
    out.set(vid, ids);
  }
  citerCache.set(resolution, out);
  return out;
}

/** 候補に座標と持ち主の全部を足す（引けない頂点は落とす＝教訓 5.18）。 */
export function describeNearVertices(
  resolution: DisplayResolution,
  near: readonly NearVertexCandidate[],
): DescribedVertexCandidate[] {
  const citers = vertexCitersFor(resolution);
  const out: DescribedVertexCandidate[] = [];
  for (const c of near) {
    const v = getVertex(resolution.vertices, c.vertexId);
    if (v === undefined) continue;
    const all = citers.get(c.vertexId) ?? [];
    out.push({
      ...c,
      coordinate: v.coordinate,
      citers: all.includes(c.featureId) ? all : [c.featureId, ...all],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1 行の書式
// ---------------------------------------------------------------------------

/** 画面に出る言葉（教訓 5.64: 検査に直書きさせない）。 */
export const VERTEX_CANDIDATE_ROW_STRINGS = {
  vertex: (number: string): string => `頂点 #${number}`,
  sharedWith: (names: string): string => `${names}と共有`,
  othersSuffix: (count: number): string => `ほか ${String(count)} 件`,
  unknownFeature: '（名前なし）',
} as const;

/** 共有の相手を名前で並べる上限（それより多ければ「ほか N 件」）。 */
const SHARED_NAMES_MAX = 2;

/**
 * 頂点の番号。実データの頂点 id は `v412` の形なので、頭の `v` を落として数字だけ出す。
 * 形が違う id（合成データ・将来の採番）はそのまま出す ―― 番号を作り出さない。
 */
export function vertexNumberOf(vertexId: VertexId): string {
  const m = /^v(\d+)$/.exec(vertexId);
  return m === null ? vertexId : m[1]!;
}

/** 「34.10°N 12.51°E」（設計書 §E.1 V9 の書式。小数 2 桁）。 */
export function formatCandidateCoordinate(c: WorldCoordinate): string {
  const lat = `${Math.abs(c.lat).toFixed(2)}°${c.lat < 0 ? 'S' : 'N'}`;
  // 経度は [-180, 180) へ畳んでから出す（連続経度の複製を見せない）。
  const folded = ((((c.lon + 180) % 360) + 360) % 360) - 180;
  const lon = `${Math.abs(folded).toFixed(2)}°${folded < 0 ? 'W' : 'E'}`;
  return `${lat} ${lon}`;
}

/**
 * 1 行ぶんを組む。
 *
 * - **主になる地物**: いま選んでいる地物がこの頂点を引いていればそれ、いなければ当たり判定が
 *   返した持ち主。選んだときに **選択の持ち主になる地物**でもある ―― 共有頂点の最初の持ち主が
 *   隣の国だと、一覧から選んだ瞬間に選んでいた地物が隣へ替わってしまう。
 * - 主がいま選んでいる地物でなければ、その名前を書く（どの地物の頂点かを言う）。
 * - ほかに引いている地物があれば「…と共有」を書く。
 */
export function buildCandidateRow(
  c: DescribedVertexCandidate,
  activeFeature: FeatureId | null,
  nameOf: (featureId: FeatureId) => string,
): VertexCandidateRow {
  const main =
    activeFeature !== null && c.citers.includes(activeFeature) ? activeFeature : c.featureId;
  const named = (id: FeatureId): string => {
    const n = nameOf(id);
    return n === '' ? VERTEX_CANDIDATE_ROW_STRINGS.unknownFeature : n;
  };
  const parts: string[] = [formatCandidateCoordinate(c.coordinate)];
  if (main !== activeFeature) parts.push(named(main));
  const others = c.citers.filter((id) => id !== main);
  if (others.length > 0) {
    const shown = others.slice(0, SHARED_NAMES_MAX).map(named).join('・');
    const rest = others.length - SHARED_NAMES_MAX;
    parts.push(
      VERTEX_CANDIDATE_ROW_STRINGS.sharedWith(
        rest > 0 ? `${shown} ${VERTEX_CANDIDATE_ROW_STRINGS.othersSuffix(rest)}` : shown,
      ),
    );
  }
  return {
    featureId: main,
    vertexId: c.vertexId,
    featureName: nameOf(main),
    label: `${VERTEX_CANDIDATE_ROW_STRINGS.vertex(vertexNumberOf(c.vertexId))}（${parts.join('・')}）`,
    distancePx: c.distancePx,
  };
}

/** 候補の並び（近い順）から一覧の状態を作る。2 つ未満なら null（一覧は出さない）。 */
export function buildCandidateState(
  at: ScreenPoint,
  found: readonly DescribedVertexCandidate[],
  activeFeature: FeatureId | null,
  nameOf: (featureId: FeatureId) => string,
): VertexCandidateState | null {
  if (found.length < VERTEX_CANDIDATE_MIN) return null;
  const shown = found.slice(0, VERTEX_CANDIDATE_MAX_ROWS);
  return {
    x: at.x,
    y: at.y,
    rows: shown.map((c) => buildCandidateRow(c, activeFeature, nameOf)),
    more: found.length - shown.length,
  };
}

// ---------------------------------------------------------------------------
// 選んだ頂点を優先して掴む
// ---------------------------------------------------------------------------

/** {@link preferSelectedVertex} が読む選択の形（U22 の選択の一部）。 */
export interface VertexSelectionView {
  readonly vertexIds: ReadonlySet<VertexId>;
  readonly vertexOwner: FeatureId | null;
}

/**
 * **選んでいる頂点が掴める距離に居れば、最寄りの別の頂点よりそちらを掴む。**
 *
 * 候補一覧から選んだ頂点をドラッグしようとして押すと、当たり判定は「いちばん近い頂点」を
 * 返すので、密な所では **選んだのとは別の頂点**が掴まれて動く（V9 の「一覧から選ぶ →
 * ドラッグ」が成り立たない）。選択は利用者が明示した意図なので、掴める距離の中では
 * 距離より優先する。
 *
 * 頂点を返した当たりのときだけ見る（本体・辺・空の当たりは、掴める距離に頂点が 1 つも
 * 無かったという意味なので、選んだ頂点もその中に居ない）。`near` は遅延で呼ぶ ―― 選択が
 * 空の大多数の押下では索引を引き直さない。
 */
export function preferSelectedVertex(
  hit: HitResult,
  selection: VertexSelectionView,
  near: () => readonly NearVertexCandidate[],
): HitResult {
  if (hit.kind !== HIT_KIND.Vertex) return hit;
  if (selection.vertexIds.size === 0 || selection.vertexOwner === null) return hit;
  if (hit.featureId === selection.vertexOwner && selection.vertexIds.has(hit.vertexId)) {
    return hit;
  }
  // `near` は近い順。最初に見つかった「選んでいる頂点」がいちばん近い選択である。
  for (const c of near()) {
    if (selection.vertexIds.has(c.vertexId)) {
      return vertexHit(selection.vertexOwner, c.vertexId);
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// 状態が移ったら畳む
// ---------------------------------------------------------------------------

/**
 * 候補の顔ぶれを決めている状態（セッションストアの一部）。どれかが **別の値に替わったら**
 * 一覧は古いので畳む（教訓 5.2 / 5.6: 結果状態の同一性で判定する）。選択は入れない ――
 * 一覧が出るクリックそのものが選択を変えるので、入れると出た瞬間に畳まれる。
 */
export interface CandidateRelevantState {
  readonly domain: unknown;
  readonly currentTime: unknown;
  readonly mode: unknown;
  readonly activeTool: unknown;
  readonly displayControl: unknown;
  readonly filter: unknown;
  readonly camera: unknown;
}

const RELEVANT_KEYS: readonly (keyof CandidateRelevantState)[] = [
  'domain',
  'currentTime',
  'mode',
  'activeTool',
  'displayControl',
  'filter',
  'camera',
];

/**
 * ストアを購読し、候補の顔ぶれを決めている状態が替わったら `onStale` を呼ぶ。
 * 戻り値は購読の解除。
 */
export function watchCandidateStaleness<T extends CandidateRelevantState>(
  store: {
    readonly getState: () => T;
    readonly subscribe: (listener: (state: T) => void) => () => void;
  },
  onStale: () => void,
): () => void {
  let prev: CandidateRelevantState = store.getState();
  return store.subscribe((s) => {
    const changed = RELEVANT_KEYS.some((k) => s[k] !== prev[k]);
    prev = s;
    if (changed) onStale();
  });
}

// ---------------------------------------------------------------------------
// クリックのときだけ出す（押下 → 移動 → 解放）
// ---------------------------------------------------------------------------

/** {@link createVertexCandidateGesture} の入力。 */
export interface VertexCandidateGestureOptions {
  readonly store: VertexCandidateStore;
  /** 押した位置の候補（近い順。座標と持ち主の全部つき）。 */
  readonly probe: (point: ScreenPoint) => readonly DescribedVertexCandidate[];
  /** いま選んでいる地物（行の「主」を決める）。 */
  readonly activeFeature: () => FeatureId | null;
  readonly nameOf: (featureId: FeatureId) => string;
}

/** 押下 → 移動 → 解放の 1 本ぶんの口（`mount/input.ts` が地図の入力層から呼ぶ）。 */
export interface VertexCandidateGesture {
  /** 左ボタンの押下。押すたびにまず畳む（地図の他所のクリックで必ず消える）。 */
  press(point: ScreenPoint, leftButton: boolean): void;
  move(point: ScreenPoint): void;
  /** 解放。動かさずに離したときだけ、候補が 2 つ以上なら一覧を出す。 */
  release(point: ScreenPoint): void;
  /** 取り消し（pointercancel・状態の変化）。保留中の候補も一覧も捨てる。 */
  cancel(): void;
}

export function createVertexCandidateGesture(
  options: VertexCandidateGestureOptions,
): VertexCandidateGesture {
  const { store } = options;
  let pending: { readonly at: ScreenPoint; readonly state: VertexCandidateState | null } | null =
    null;
  let dragged = false;
  return {
    press(point, leftButton) {
      store.clear();
      pending = null;
      dragged = false;
      if (!leftButton) return;
      // 候補は **押した瞬間の世界**で数える（離すまでに選択が変わっても、押したときに
      // 見えていた頂点の顔ぶれを出す）。
      const found = options.probe(point);
      pending = {
        at: point,
        state: buildCandidateState(point, found, options.activeFeature(), options.nameOf),
      };
    },
    move(point) {
      if (pending === null || dragged) return;
      // しきい値はディスパッチャのクリック／ドラッグ判定と同じ 1 本（教訓 5.30）。
      if (exceedsDragThreshold(pending.at.x, pending.at.y, point.x, point.y)) dragged = true;
    },
    release(point) {
      const p = pending;
      pending = null;
      if (p === null) return;
      if (dragged || exceedsDragThreshold(p.at.x, p.at.y, point.x, point.y)) return;
      if (p.state !== null) store.set(p.state);
    },
    cancel() {
      pending = null;
      dragged = false;
      store.clear();
    },
  };
}
