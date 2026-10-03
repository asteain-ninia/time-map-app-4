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
import {
  intersection,
  isOk,
  pointInPolygon,
  POINT_LOCATION,
  type GeoMultiPolygon,
} from '../../domain/geometry/index';
import { resolveLeafShape } from '../../domain/hierarchy/resolve-shape';
import type { DomainProject } from '../../domain/persistence/serialize';
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
  /** 自分の錨列の各区間の開始年（錨列を持たない＝まとめ役の系列に入っているなら null）。 */
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

function insideAny(mp: GeoMultiPolygon, lon: number, lat: number): boolean {
  const p = createCoordinate(lon, lat);
  return mp.some((poly) => pointInPolygon(p, poly) === POINT_LOCATION.Inside);
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
      const res = intersection(a, b);
      if (!isOk(res)) continue;
      maxPairOverlapKm2 = Math.max(maxPairOverlapKm2, multiPolygonAreaKm2(res.result, geo));
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
