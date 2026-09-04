// UI layer (U23): 作図中の吸着（FR-31）と FR-29 の関門の **供給元**（増分 3 / C1）。
//
// 現状分析 C1 が「部品はあるのに配線されていない」と書いた 2 つの口
// （`resolveProximity` / `isInsideTerminal`）に、実際の当たり判定をつなぐ場所である。
// 執筆時に `src/ui` 全体を探しても供給元が 1 つも無かったので、
// `resolveProximity?.(raw) ?? null` は常に null を返し、吸着は一度も効いていなかった。
//
// **新しい当たり判定を書かない**（教訓 5.29 / 5.30）。使うのは既にあるもの 2 つだけ:
//
//   - 近くの頂点 … `liveHitTestAt`（`ui/map/live-hit-test.ts`）。**描かれる候補の集合**を
//     そのまま使う（階層の深さ・表示フィルタ・±360 度の複製まで込み）。ただし
//     「見えている ＝ 吸着できる」は **厳密には成り立たない**: ハンドルの描画には上限
//     （2,000 個）があり、上限を超えて 1 つも描かれない倍率でも当たり判定は候補を返す
//     （バグ狩り #9 で実測）。予告の輪と地物名は出るので操作は追えるが、
//     「描かれたものだけ」ではないことをここに書いておく。半径は吸着の許容 px に差し替える。
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
import { FEATURE_KIND } from '../../domain/feature';
import { HIT_KIND } from '../../domain/selection/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex } from '../../domain/vertex';
import type { Camera, Viewport } from '../../render';
import { worldToScreen } from '../../render/vtransform';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { LONGITUDE_PERIOD } from '../../domain/geo/seam';

import {
  featureByIdAt,
  featuresAt,
  leafAtPointIncludingBoundary,
  verticesAt,
} from '../live-lookup';
import { liveHitTestAt } from '../map/live-hit-test';
import type { DisplayControl, SnapSettings } from '../state/session';
import type { FilterState } from '../discovery/index';

import type { LeafPointHit } from '../live-lookup';

import type { AddProximityCandidate, AddTerminalHit } from './useAddTool';

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
  /**
   * FR-29: その点が **どの末端地物の内側か**（内側でも境界の上でもなければ null）。
   * 可否も断り文の名前も **この 1 回の解決**から作る（教訓 5.46: 判定を 2 経路に割らない）。
   *
   * **境界の上も返す**（増分 3 の手直し B1）。断るかどうかは内側のときだけだが、
   * 入れ子の見分け（「打った頂点が全部、同じ末端の内側または境界の上か」）には
   * 「どの面の線の上に載ったか」が要る ―― 親の角へ吸着した頂点は必ず境界の上に載るので、
   * ここを落とすと **吸着した瞬間に入れ子と認められなくなる**。
   */
  readonly terminalAt: (coordinate: WorldCoordinate) => AddTerminalHit | null;
  /** 地物の表示名（吸着の予告「『◯◯』の頂点に合わせます」に使う）。 */
  readonly featureNameOf: (featureId: FeatureId) => string | null;
  /**
   * FR-77 / GPT #4: **いま描いた形を丸ごと含む面**の id を、**内側から外側の順**で返す。
   * 呼び出し側は先頭（＝最も内側の面）を上位領域の既定にする。
   *
   * **なぜ必要か**: **入れ子として通した形が、既定では「上位領域なし」で保存され、
   * 最上位の面として重なり競合になっていた**（GPT #4）。**候補の一覧は絞らない**
   * ―― 離れた場所にある子を持つ上位領域（集約地物の実領域は子の和なので、親自身の形の
   * 外に子が居てよい）も選べる必要があるため。
   *
   * **なぜ「一意なら」ではなく「最も内側」か**（増分 3 の手直し 2 回目）。含む面は
   * ふつう 1 つではない ―― 2 人目の子は「1 人目の子（の中に描いたなら）＋親」、
   * 修復で集約化したあとは「親 直轄領＋親」のように **必ず 2 つ以上**になる。
   * 「一意なら」だと **最初の子のときしか既定が入らず**、2 人目以降は黙って
   * 「上位領域なし」で保存されていた（実測）。いちばん内側を選べば、利用者が
   * 「その面の中に描いた」と思っている面がそのまま入る。
   *
   * **数え方**: ある点を含む面は「その点に当たる末端」と「その先祖」で尽きる（集約地物の
   * 実領域は子の和なので、子に当たらない点は親にも当たらない）。だから点ごとに末端を 1 回
   * 引いて先祖をたどり、**全部の点に共通するもの**を返す。全域を走査して面ごとに実領域を
   * 組み立てる（`resolveFeatureArea` を 776 回呼ぶ）必要はない。
   * 境界の上に載った点も「含まれる」に数える（親の角へ吸着した頂点は必ず境界に載る）。
   * **子を持っている面も数える**（末端でなくなっても、自分の形の中にあることは変わらない）。
   */
  readonly facesContaining: (
    coordinates: readonly WorldCoordinate[],
  ) => readonly FeatureId[];
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
    // **点情報の頂点には吸着しない**（増分 3 の手直し D6。司令塔の決定 3。所有者が覆せる）。
    // FR-30 が共有を定めているのは「複数の面情報や線情報」であって点情報は入っていない。
    // 国境の角を都市（点情報）と共有すると、国境を動かすたびに都市が動く。線の頂点には
    // 吸着してよい（線と面が境界を共有するのは正しい使い方である）。
    const owner = featureByIdAt(ctx.root, ctx.time, hit.featureId);
    if (owner?.kind === FEATURE_KIND.Point) return null;
    const vertex = getVertex(verticesAt(ctx.root, ctx.time), hit.vertexId);
    if (vertex === undefined) return null;
    return {
      // **押した位置と同じ周回へ寄せて返す。** 当たり判定は ±360 度の複製まで見て
      // 「見えているものは掴める」を成り立たせているが、保存されている座標は 1 つの周回に
      // しかない。そのまま返すと、地図を日付変更線の向こうへパンして描いているときに
      // 下書きの中で 360 度ちょうどの飛びが生まれ、**利用者から見れば小さな形なのに
      // N-51 が「世界を半周以上します」と断る**（案内どおり途中に点を打っても直らない）。
      coordinate: createCoordinate(
        vertex.coordinate.lon +
          LONGITUDE_PERIOD * Math.round((raw.lon - vertex.coordinate.lon) / LONGITUDE_PERIOD),
        vertex.coordinate.lat,
      ),
      // 保存する体は **元の値**（共有頂点は同じ id を 2 つの地物が指すので、体が食い違って
      // はいけない。読み込み側はリングごとに連続へ戻すので形は正しく復元される）。
      bodyCoordinate: vertex.coordinate,
      featureId: hit.featureId,
      vertexId: hit.vertexId,
    };
  };

  /**
   * FR-29 の 1 回きりの解決。可否も名前もここから作る（二重真実源を作らない）。
   *
   * **「末端地物」は子を持たない leaf である**（FR-27 の定義。ドメイン側の
   * `spatial/terminals.ts` が「A feature is a terminal for exclusion purposes when it
   * OWNS a shape and has no sub-regions — i.e. a childless LEAF」と書いている同じ規則）。
   * 子を持つ面は排他検証の対象から外れているので、FR-29 でも塞がない ―― でないと
   * 「排他違反にならない場所なのに頂点が置けない」という食い違いが生まれる。
   *
   * クリック 1 回につき 1 度だけ走る（カーソル移動では呼ばない）。
   */
  const terminalAt = (coordinate: WorldCoordinate): LeafPointHit | null => {
    const ctx = readContext();
    const hit = leafAtPointIncludingBoundary(ctx.root, ctx.time, coordinate);
    if (hit === null) return null;
    const hasChild = featuresAt(ctx.root, ctx.time).some((f) => f.parentId === hit.featureId);
    return hasChild ? null : hit;
  };

  const featureNameOf = (featureId: FeatureId): string | null => {
    const ctx = readContext();
    const feature = featureByIdAt(ctx.root, ctx.time, featureId);
    if (feature === undefined) return null;
    const name = feature.attributes.name;
    return name === '' ? null : name;
  };

  /**
   * 断り文に出す **その面の呼び方**（増分 3 の手直し B3。バグ狩り #13）。
   *
   * 実データは集約地物の下に州が並ぶので、名前だけを出すと「ここは『ガロアミド州』の
   * 内側です」となり、**どこの州なのかが分からない**（同名の州が別の国にもありうる）。
   * 上位領域の名前と種別ラベルが引けるときは「デーレ共和国の州『ガロアミド州』」の形にする。
   * 引けない項は黙って落とす（内部 id は出さない ―― U-1）。
   */
  const describeTerminal = (featureId: FeatureId): string | null => {
    const name = featureNameOf(featureId);
    if (name === null) return null;
    const ctx = readContext();
    const feature = featureByIdAt(ctx.root, ctx.time, featureId);
    const kind = feature?.kindLabel ?? '';
    const parentId = feature?.parentId;
    const parentName = parentId === undefined ? null : featureNameOf(parentId);
    if (parentName === null) return kind === '' ? `「${name}」` : `${kind}「${name}」`;
    return kind === '' ? `${parentName}の「${name}」` : `${parentName}の${kind}「${name}」`;
  };

  /** その id の面と、その先祖を根まで（自分を含む）。 */
  const selfAndAncestors = (
    featureId: FeatureId,
    parentOf: ReadonlyMap<FeatureId, FeatureId | undefined>,
  ): FeatureId[] => {
    const out: FeatureId[] = [];
    const seen = new Set<FeatureId>();
    let at: FeatureId | undefined = featureId;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at); // 環になったデータでも止まる（教訓 5.28）。
      out.push(at);
      at = parentOf.get(at);
    }
    return out;
  };

  const facesContaining = (
    coordinates: readonly WorldCoordinate[],
  ): readonly FeatureId[] => {
    if (coordinates.length === 0) return [];
    const ctx = readContext();
    const features = featuresAt(ctx.root, ctx.time);
    const parentOf = new Map<FeatureId, FeatureId | undefined>(
      features.map((f) => [f.id, f.parentId]),
    );
    let common: Set<FeatureId> | null = null;
    // 1 点目の連なり（末端 → 先祖）を **並びの基準**にする。先頭がいちばん内側である。
    let innermostFirst: readonly FeatureId[] = [];
    for (const c of coordinates) {
      const hit = leafAtPointIncludingBoundary(ctx.root, ctx.time, c);
      if (hit === null) return []; // 1 点でもどの面にも入っていなければ、共通の親は無い。
      const chain = selfAndAncestors(hit.featureId, parentOf);
      if (common === null) {
        common = new Set<FeatureId>(chain);
        innermostFirst = chain;
      } else {
        const here = new Set<FeatureId>(chain);
        for (const id of [...common]) if (!here.has(id)) common.delete(id);
      }
      if (common.size === 0) return [];
    }
    if (common === null) return [];
    const inCommon = common;
    return innermostFirst.filter((id) => inCommon.has(id));
  };

  return {
    resolveProximity,
    facesContaining,
    terminalAt: (coordinate) => {
      const hit = terminalAt(coordinate);
      if (hit === null) return null;
      return {
        featureId: hit.featureId,
        name: featureNameOf(hit.featureId),
        where: describeTerminal(hit.featureId),
        onBoundary: hit.onBoundary,
      };
    },
    featureNameOf,
  };
}
