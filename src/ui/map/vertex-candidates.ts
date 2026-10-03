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
//   - 一覧から選んだ頂点は、**直後の左ドラッグ 1 回だけ**優先して掴まれる
//     （{@link preferListPick}。手直しで「すべての押下」から絞った）。そうしないと
//     「一覧から選ぶ → ドラッグ」で最寄りの別の頂点が動いてしまい、V9 の経路が成り立たない。
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
import { VERTEX_CANDIDATE_ROW_STRINGS, VERTEX_CANDIDATE_ROW_TEXT } from './strings';

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
  /** 頂点の座標（行に乗っている間、地図の上でその頂点を強調するのに使う）。 */
  readonly coordinate: WorldCoordinate;
}

/** 一覧そのもの（出ていないときは null）。 */
export interface VertexCandidateState {
  /** 地図セルの左上からの位置（px）。一覧はこの右下 8px に出す。 */
  readonly x: number;
  readonly y: number;
  /**
   * 掴める距離に居る頂点の **全部**（近い順）。一覧はまず {@link VERTEX_CANDIDATE_MAX_ROWS}
   * 行だけ描き、残りは「もっと見る」で出す（増分 8A の手直し・GPT #1: 21 件目より先にも
   * 選ぶ道を残す。同じ座標に 21 個以上あると拡大しても絞れないため）。
   */
  readonly rows: readonly VertexCandidateRow[];
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
    this.setHover(null);
    if (this.state === null) return;
    this.state = null;
    this.emit();
  }

  // --- 行に乗っている頂点（増分 8A の手直し・設計適合 2-3） -----------------------
  //
  // 一覧の行に乗っている（または焦点がある）間、その頂点を地図の上で強調する。行の座標と
  // 距離だけでは、密な所で「どの点か」が地図と結びつかないため。一覧が畳まれたら必ず消える
  // （`clear` が先にここを空にする）。

  private hover: WorldCoordinate | null = null;
  private readonly hoverListeners = new Set<(hover: WorldCoordinate | null) => void>();

  getHover(): WorldCoordinate | null {
    return this.hover;
  }

  setHover(hover: WorldCoordinate | null): void {
    if (this.hover === hover) return;
    this.hover = hover;
    for (const l of this.hoverListeners) l(hover);
  }

  subscribeHover(listener: (hover: WorldCoordinate | null) => void): () => void {
    this.hoverListeners.add(listener);
    return () => {
      this.hoverListeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}

/** 一覧を出すのは候補が 2 つ以上あるときだけ（1 つならそのまま掴めばよい）。 */
export const VERTEX_CANDIDATE_MIN = 2;

/**
 * 一覧に **最初に** 描く行数（と「もっと見る」1 回で足す行数）。世界全体表示では掴める距離の
 * 中に数十の頂点が入る（隣まで 0.4px 台）ので、全部並べると選べない。近い順に並べて
 * ここで畳み、残りの件数と「もっと見る」を出す。
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
export { VERTEX_CANDIDATE_ROW_STRINGS };

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
    const shown = others.slice(0, SHARED_NAMES_MAX).map(named).join(VERTEX_CANDIDATE_ROW_TEXT.separator);
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
    label: VERTEX_CANDIDATE_ROW_TEXT.label(VERTEX_CANDIDATE_ROW_STRINGS.vertex(vertexNumberOf(c.vertexId)), parts.join(VERTEX_CANDIDATE_ROW_TEXT.separator)),
    distancePx: c.distancePx,
    coordinate: c.coordinate,
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
  // 名前は地物ごとに 1 回だけ引く（全体表示では数百行になりうる）。
  const names = new Map<FeatureId, string>();
  const cachedNameOf = (id: FeatureId): string => {
    let n = names.get(id);
    if (n === undefined) {
      n = nameOf(id);
      names.set(id, n);
    }
    return n;
  };
  return {
    x: at.x,
    y: at.y,
    rows: found.map((c) => buildCandidateRow(c, activeFeature, cachedNameOf)),
  };
}

// ---------------------------------------------------------------------------
// 一覧から選んだ頂点を、直後の左ドラッグ 1 回だけ優先して掴む
// ---------------------------------------------------------------------------

/** {@link preferListPick} が読む選択の形（U22 の選択の一部）。 */
export interface VertexSelectionView {
  readonly vertexIds: ReadonlySet<VertexId>;
  readonly vertexOwner: FeatureId | null;
}

/** 一覧から選んだ頂点の印（使い捨て）。 */
export interface ListPick {
  readonly featureId: FeatureId;
  readonly vertexId: VertexId;
  /** 印を立てたときの、候補の顔ぶれを決めている状態（どれかが替わっていたら効かせない）。 */
  readonly context: CandidateRelevantState;
}

/**
 * 一覧から選んだときに立てる **使い捨ての印**（増分 8A の手直し・反証 重 3）。
 *
 * **次の押下で必ず消える**（どのボタンの押下でも、効かせたかどうかに関わらず）。押下の
 * たびに {@link ListPickOnce.take} を 1 回だけ呼び、返った印をその押下にだけ使う。
 */
export interface ListPickOnce {
  /** 一覧から 1 つ選んだ。前の印は捨てる。 */
  arm(pick: ListPick): void;
  /** 押下ごとに 1 回呼ぶ。印を消し、立っていた印を返す（無ければ null）。 */
  take(): ListPick | null;
  /** 印を捨てる（地図が降りる等）。 */
  clear(): void;
}

export function createListPickOnce(): ListPickOnce {
  let armed: ListPick | null = null;
  return {
    arm(pick) {
      armed = pick;
    },
    take() {
      const p = armed;
      armed = null;
      return p;
    },
    clear() {
      armed = null;
    },
  };
}

/** 候補の顔ぶれを決めている状態が 2 つの時点で同じか（同一性で比べる＝教訓 5.6）。 */
export function sameCandidateContext(
  a: CandidateRelevantState,
  b: CandidateRelevantState,
): boolean {
  return RELEVANT_KEYS.every((k) => a[k] === b[k]);
}

/**
 * **一覧から選んだ直後の左ドラッグ 1 回だけ**、その頂点を最寄りより優先して掴む。
 *
 * 候補一覧から選んだ頂点をドラッグしようとして押すと、当たり判定は「いちばん近い頂点」を
 * 返すので、密な所では **選んだのとは別の頂点**が掴まれて動く（V9 の「一覧から選ぶ →
 * ドラッグ」が成り立たない）。そこで一覧から選んだときだけ印を立て、次の押下に限って効かせる。
 *
 * 増分 8A の当初は「選んでいる頂点すべて・すべての押下」に効いていたので、頂点 X を選んだまま
 * 隣の Y を右クリックで消すと X が消え、Y を Shift+クリックで足すと X が外れた（反証 重 3）。
 * いまは次のときだけ効く（どれか 1 つでも外れたら当たり判定の結果をそのまま返す）:
 *
 * - 印が立っている（一覧から選んだ直後の押下である）。
 * - 修飾キーが 1 つも押されていない（Shift・Ctrl・Alt・Meta つきは足す・外す等の別の操作）。
 * - 当たりが頂点である（本体・辺・空なら、掴める距離に頂点が無かった）。
 * - 印を立ててから世界・年・道具・表示・カメラが替わっていない。
 * - 選んだ頂点がいまも選択に入っていて、持ち主も同じ。
 * - 選んだ頂点が掴める距離に居る（`near` は遅延で呼ぶ）。
 *
 * 呼ぶのは左ボタンの編集ドラッグの入口（`editSession.begin` に渡す当たり）だけである。
 * 右クリックのメニュー・選択の書き込みには、当たり判定の結果をそのまま渡す。
 */
export function preferListPick(
  hit: HitResult,
  pick: ListPick | null,
  modifiers: {
    readonly shift: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly meta: boolean;
  },
  now: { readonly context: CandidateRelevantState; readonly selection: VertexSelectionView },
  near: () => readonly NearVertexCandidate[],
): HitResult {
  if (pick === null) return hit;
  if (modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta) return hit;
  if (hit.kind !== HIT_KIND.Vertex) return hit;
  if (!sameCandidateContext(pick.context, now.context)) return hit;
  if (now.selection.vertexOwner !== pick.featureId) return hit;
  if (!now.selection.vertexIds.has(pick.vertexId)) return hit;
  if (hit.featureId === pick.featureId && hit.vertexId === pick.vertexId) return hit;
  for (const c of near()) {
    if (c.vertexId === pick.vertexId) return vertexHit(pick.featureId, pick.vertexId);
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

/**
 * 押下 → 移動 → 解放の 1 本ぶんの口（`mount/input.ts` が地図の入力層から呼ぶ）。
 *
 * **指（ポインタ）を見分ける**（増分 8A の手直し・GPT #2）。保留は 1 本だけで、押した
 * ポインタと同じ id の移動・解放・取り消しだけを数える。保留中に別のポインタが押しても
 * 保留は上書きしない（先に押したほうが勝つ ―― ディスパッチャが 2 本目の選択・編集の押下を
 * 捨てるのと同じ並び）。
 */
export interface VertexCandidateGesture {
  /** 押下。押すたびにまず畳む（地図の他所のクリックで必ず消える）。左ボタンのときだけ保留する。 */
  press(point: ScreenPoint, leftButton: boolean, pointerId: number): void;
  move(point: ScreenPoint, pointerId: number): void;
  /** 解放。動かさずに離したときだけ、候補が 2 つ以上なら一覧を出す。 */
  release(point: ScreenPoint, pointerId: number): void;
  /**
   * 取り消し。id を渡したら（pointercancel）そのポインタの保留だけを捨てる。渡さなければ
   * （状態の変化・Escape・地図が降りる）保留も出ている一覧も捨てる。
   */
  cancel(pointerId?: number): void;
  /**
   * 地図の外へ出た（pointerleave）。**保留だけ**を捨てる ―― 出ている一覧は残す（一覧へ
   * ポインタを動かすと入力層から出たことになるので、ここで畳むと一覧に触れない）。
   */
  leave(): void;
}

export function createVertexCandidateGesture(
  options: VertexCandidateGestureOptions,
): VertexCandidateGesture {
  const { store } = options;
  let pending: {
    readonly at: ScreenPoint;
    readonly pointerId: number;
    readonly state: VertexCandidateState | null;
  } | null = null;
  let dragged = false;
  return {
    press(point, leftButton, pointerId) {
      store.clear();
      // 別のポインタの保留が生きている間は上書きしない（先に押したほうが勝つ）。
      if (pending !== null && pending.pointerId !== pointerId) return;
      pending = null;
      dragged = false;
      if (!leftButton) return;
      // 候補は **押した瞬間の世界**で数える（離すまでに選択が変わっても、押したときに
      // 見えていた頂点の顔ぶれを出す）。
      const found = options.probe(point);
      pending = {
        at: point,
        pointerId,
        state: buildCandidateState(point, found, options.activeFeature(), options.nameOf),
      };
    },
    move(point, pointerId) {
      if (pending === null || dragged || pending.pointerId !== pointerId) return;
      // しきい値はディスパッチャのクリック／ドラッグ判定と同じ 1 本（教訓 5.30）。
      if (exceedsDragThreshold(pending.at.x, pending.at.y, point.x, point.y)) dragged = true;
    },
    release(point, pointerId) {
      const p = pending;
      if (p === null || p.pointerId !== pointerId) return;
      pending = null;
      if (dragged || exceedsDragThreshold(p.at.x, p.at.y, point.x, point.y)) return;
      if (p.state !== null) store.set(p.state);
    },
    cancel(pointerId) {
      if (pointerId !== undefined) {
        // pointercancel: そのポインタの保留だけを捨てる（一覧は押した時点で既に畳んである）。
        if (pending !== null && pending.pointerId === pointerId) {
          pending = null;
          dragged = false;
        }
        return;
      }
      pending = null;
      dragged = false;
      store.clear();
    },
    leave() {
      pending = null;
      dragged = false;
    },
  };
}
