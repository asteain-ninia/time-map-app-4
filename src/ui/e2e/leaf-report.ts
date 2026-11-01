// 末端地物の中身を E2E から表示と独立に読むための観測（T-2「隠し観測は足す一方」）。
//
// なぜ要るか（増分 8B の手直し / GPT 審査の重 2）: 分割の E2E は、一覧の件数や板の文といった
// **表示** だけを見ていたので、片が 1 つ欠けても・元の地物の id や年表が入れ替わっても・片どうしが
// 重なっても通ってしまった。ここでは **ドメインの値** をそのまま返す ―― 地物の id・名前・種別・色・
// 錨列の開始年・面積、片どうしの重なりの面積、指定した点がどの地物の内側にあるか。
//
// **純関数にしてある**（教訓 5.41: E2E で検証できない範囲は純関数化して単体テストで補う）。
// 登録は App.tsx が行い、E2E ブリッジがあるときだけ window に生える（本番では何も出ない）。
// 面積と重なりは U06 の集合演算とプロジェクトの測地設定で測る（表示の座標変換を通らない）。

import type { ColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { FEATURE_KIND, type LeafFeature } from '../../domain/feature';
import { multiPolygonAreaKm2 } from '../../domain/geo/geodesy';
import { alignMultiPolygon, LONGITUDE_PERIOD, referenceLonForMultiPolygon } from '../../domain/geo/seam';
import { pointInPolygon, POINT_LOCATION, type GeoMultiPolygon } from '../../domain/geometry/index';
import { resolveLeafShape } from '../../domain/hierarchy/resolve-shape';
import type { DomainProject } from '../../domain/persistence/serialize';
import { commonPartsAcrossSeam } from '../../domain/promotion/subtract-across-seam';
import type { TimePoint } from '../../domain/time/time-point';

import { featuresAt, verticesAt } from '../live-lookup';

/** どの末端地物を報告するか。id と名前のどちらに当たっても採る（両方空なら何も採らない）。 */
export interface LeafReportQuery {
  readonly ids?: readonly string[];
  readonly names?: readonly string[];
  /** 「この点はどの地物の内側か」を答えてほしい点（経度・緯度）。 */
  readonly probes?: readonly { readonly lon: number; readonly lat: number }[];
}

export interface LeafReportEntry {
  readonly id: string;
  readonly name: string;
  readonly kindLabel: string | null;
  readonly color: ColorInfo;
  /** 自分の錨列の各区間の開始年（錨列を持たない＝集約地物の系列に入っているなら null）。 */
  readonly anchorStartYears: readonly number[] | null;
  /** 面積（km²。外周 − 穴、プロジェクトの測地設定）。形が引けなければ null。 */
  readonly areaKm2: number | null;
  readonly polygonCount: number;
  readonly ringCount: number;
}

export interface LeafReport {
  readonly entries: readonly LeafReportEntry[];
  /** 報告した地物の面積の合計（km²）。 */
  readonly totalAreaKm2: number;
  /** 報告した地物のどの 2 つの共通部分よりも大きくない面積（km²）。重なりが無ければ 0。 */
  readonly maxPairOverlapKm2: number;
  /** `probes` の各点を内側に持つ地物の id（どれにも入らなければ null）。 */
  readonly probeOwners: readonly (string | null)[];
}

/**
 * 点が面の内側か。**保存された座標のまま判定しない**（B90）。経度 180 の頂点は -180 に畳まれて
 * いるので、輪を連続の座標へ戻し、点は 1 周ぶん前後させても見る。
 */
function insideAny(mp: GeoMultiPolygon, lon: number, lat: number): boolean {
  return mp.some((poly) => {
    const aligned = alignMultiPolygon([poly])[0]!;
    return [-LONGITUDE_PERIOD, 0, LONGITUDE_PERIOD].some(
      (turn) =>
        pointInPolygon(createCoordinate(lon + turn, lat), aligned) === POINT_LOCATION.Inside,
    );
  });
}

/** 指定の時刻で、問い合わせに当たる末端地物を読む。読むだけで何も変えない。 */
export function leafReport(
  project: DomainProject,
  time: TimePoint,
  query: LeafReportQuery,
): LeafReport {
  const ids = new Set(query.ids ?? []);
  const names = new Set(query.names ?? []);
  const store = verticesAt(project, time);
  const geo = project.settings.geo;
  const leaves = featuresAt(project, time).filter(
    (f): f is LeafFeature =>
      f.kind === FEATURE_KIND.Leaf && (ids.has(String(f.id)) || names.has(f.attributes.name)),
  );
  const shapes = leaves.map((f) => resolveLeafShape(f.shape, store));

  const entries: LeafReportEntry[] = leaves.map((f, i) => {
    const mp = shapes[i];
    const history = project.histories.find((h) => h.featureId === f.id);
    return {
      id: String(f.id),
      name: f.attributes.name,
      kindLabel: f.kindLabel ?? null,
      color: f.color,
      anchorStartYears:
        history === undefined ? null : history.series.entries.map((e) => e.start.year),
      areaKm2: mp === undefined ? null : multiPolygonAreaKm2(mp, geo),
      polygonCount: mp?.length ?? 0,
      ringCount: f.shape.rings.length,
    };
  });

  let maxPairOverlapKm2 = 0;
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i];
      const b = shapes[j];
      if (a === undefined || b === undefined) continue;
      // 2 つの面を同じ枝へ揃えてから重ねる（畳んだままだと継ぎ目に接する面が世界を覆う）。±360 の写し
      // とも比べる。揃えるだけだと、幅の広い面の継ぎ目の反対側の重なりが見えない（教訓 5.109）。
      const ref = referenceLonForMultiPolygon(a);
      const parts = commonPartsAcrossSeam(alignMultiPolygon(a, ref), alignMultiPolygon(b, ref));
      if (parts === undefined) continue;
      const overlap = parts.reduce((sum, part) => sum + multiPolygonAreaKm2(part, geo), 0);
      maxPairOverlapKm2 = Math.max(maxPairOverlapKm2, overlap);
    }
  }

  const probeOwners = (query.probes ?? []).map((p) => {
    const k = shapes.findIndex((mp) => mp !== undefined && insideAny(mp, p.lon, p.lat));
    return k < 0 ? null : entries[k]!.id;
  });

  return {
    entries,
    totalAreaKm2: entries.reduce((sum, e) => sum + (e.areaKm2 ?? 0), 0),
    maxPairOverlapKm2,
    probeOwners,
  };
}
