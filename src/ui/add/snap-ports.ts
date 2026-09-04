// UI layer (U23): 作図中の吸着（FR-31）と FR-29 の関門の **供給元**（増分 3 / C1）。
//
// 現状分析 C1 が「部品はあるのに配線されていない」と書いた 2 つの口
// （`resolveProximity` / `isInsideTerminal`）に、実際の当たり判定をつなぐ場所である。
// 執筆時に `src/ui` 全体を探しても供給元が 1 つも無かったので、
// `resolveProximity?.(raw) ?? null` は常に null を返し、吸着は一度も効いていなかった。
//
// **新しい当たり判定を書かない**（教訓 5.29 / 5.30）。使うのは既にあるもの 2 つだけ:
//
//   - 近くの頂点 … `liveHitTestAt`（`ui/map/live-hit-test.ts`）。**地図が実際に描いた
//     ものだけ**を候補にする（階層の深さ・表示フィルタ・±360 度の複製まで込み）ので、
//     「見えている ＝ 吸着できる」が構造的に成り立つ。半径だけを吸着の許容 px に差し替える。
//   - 他の面の内側か … `leafAtPoint`（`ui/live-lookup.ts`）。地図クリックの地物解決と
//     同じ 1 本で、**境界の上の点は「内側」に数えない**（`pointInPolygon` が `Boundary` を
//     `Inside` と区別する）。これは吸着にとって決定的で、既存の頂点にぴったり吸い付いた
//     点は必ず境界の上に載るから、もし境界を内側に数えていたら **吸着するたびに FR-29 が
//     断る**ことになる。
//
// **可否と文言を 2 つの経路に割らない**（教訓 5.46）。`isInsideTerminal` と
// `terminalNameAt` は同じ 1 回の解決（`leafAtPoint`）から作る。片方が「内側だ」と言い、
// もう片方が「その面は無い」と言う食い違いが起こりえない形にしてある。

import type { DomainProject } from '../../domain/persistence/index';
import type { FeatureId } from '../../domain/ids';
import { HIT_KIND } from '../../domain/selection/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import type { Camera, Viewport } from '../../render';
import { worldToScreen } from '../../render/vtransform';
import type { WorldCoordinate } from '../../domain/coordinate';

import { featureByIdAt, leafAtPoint, verticesAt } from '../live-lookup';
import { liveHitTestAt } from '../map/live-hit-test';
import type { DisplayControl, SnapSettings } from '../state/session';
import type { FilterState } from '../discovery/index';

import type { AddProximityCandidate } from './useAddTool';

/** 供給元が 1 回の問い合わせで要る「いまの世界」。呼び出しのたびに読み直す（教訓 5.3）。 */
export interface AddSnapContext {
  readonly root: DomainProject;
  readonly time: TimePoint;
  readonly displayControl: DisplayControl;
  readonly filter: FilterState;
  readonly snap: SnapSettings;
}

export interface AddSnapPortsDeps {
  /** いまの世界（毎回読み直す。掴んだ写しを持ち回さない）。 */
  readonly readContext: () => AddSnapContext;
  /**
   * いま描いているカメラと画面の大きさ。地図がまだ載っていなければ null。
   * **描いたのと同じ変換**でなければ「見えている場所」と「吸着する場所」がずれる。
   */
  readonly readCamera: () => { readonly camera: Camera; readonly viewport: Viewport } | null;
}

export interface AddSnapPorts {
  /** FR-31: 許容内にある既存の頂点（無ければ null）。吸着が切ってあるときも null。 */
  readonly resolveProximity: (raw: WorldCoordinate) => AddProximityCandidate | null;
  /** FR-29: その点が他の末端地物の**内側**か（境界の上は内側に数えない）。 */
  readonly isInsideTerminal: (coordinate: WorldCoordinate) => boolean;
  /** FR-29 の断り文に出す相手の名前（引けなければ null。内部 id は出さない＝U-1）。 */
  readonly terminalNameAt: (coordinate: WorldCoordinate) => string | null;
  /** 地物の表示名（吸着の予告「『◯◯』の頂点に合わせます」に使う）。 */
  readonly featureNameOf: (featureId: FeatureId) => string | null;
}

export function createAddSnapPorts(deps: AddSnapPortsDeps): AddSnapPorts {
  const { readContext, readCamera } = deps;

  const resolveProximity = (raw: WorldCoordinate): AddProximityCandidate | null => {
    const ctx = readContext();
    // 吸着の ON/OFF と「頂点」のチェックはここ 1 か所で見る（呼び出し側で二重に見ない）。
    if (!ctx.snap.enabled || !ctx.snap.vertex) return null;
    const view = readCamera();
    if (view === null) return null; // 地図がまだ載っていない ⇒ 画面上の距離が定義できない。
    const toScreen = (world: WorldCoordinate) => worldToScreen(world, view.camera, view.viewport);
    const hit = liveHitTestAt(
      {
        root: ctx.root,
        time: ctx.time,
        displayControl: ctx.displayControl,
        filter: ctx.filter,
        toScreen,
        wrap: { camera: view.camera, viewport: view.viewport },
        point: toScreen(raw),
        radiusPx: ctx.snap.tolerancePx,
        // **辺の中点ハンドルは候補にしない**（選択中の地物にだけ生えるもので、
        // §N-6 が保留している「辺への吸着」とは別物。混ぜると裁定前に辺吸着が
        // 半分だけ入ったことになる）。
        activeFeature: null,
      },
      raw,
    );
    if (hit.kind !== HIT_KIND.Vertex) return null;
    const vertex = getVertex(verticesAt(ctx.root, ctx.time), hit.vertexId);
    if (vertex === undefined) return null;
    return {
      // 吸着先の **既存の頂点そのものの座標**を返す（近似ではない）。同じ値を新しい
      // 地物の頂点にも入れるので、2 つの地物の角が画素どころか値として一致する。
      coordinate: vertex.coordinate,
      featureId: hit.featureId,
      vertexId: hit.vertexId,
    };
  };

  /** FR-29 の 1 回きりの解決。可否も名前もここから作る（二重真実源を作らない）。 */
  const terminalAt = (coordinate: WorldCoordinate): FeatureId | null => {
    const ctx = readContext();
    return leafAtPoint(ctx.root, ctx.time, coordinate);
  };

  const featureNameOf = (featureId: FeatureId): string | null => {
    const ctx = readContext();
    const feature = featureByIdAt(ctx.root, ctx.time, featureId);
    if (feature === undefined) return null;
    const name = feature.attributes.name;
    return name === '' ? null : name;
  };

  return {
    resolveProximity,
    isInsideTerminal: (coordinate) => terminalAt(coordinate) !== null,
    terminalNameAt: (coordinate) => {
      const id = terminalAt(coordinate);
      return id === null ? null : featureNameOf(id);
    },
    featureNameOf,
  };
}
