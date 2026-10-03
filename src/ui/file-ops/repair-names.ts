// UI layer (増分 8D の手直し / N-22・設計書 §H.1): 修復ダイアログが対象の地物を **名前で** 呼ぶ
// ための下ごしらえ。
//
// 整合検査の報告（U14 の `Inconsistency`）は地物の ID と「名前の欄」しか持たず、時間の矛盾・
// 孤立した歴史・重複した歴史の 3 種類は名前の欄に ID を入れてくる。そのため修復ダイアログは
// 名前のある地物まで「名前のない地物 1 件」と書いていた（事実と違う。しかもそれは歴史を捨てる
// 行だった）。ここでは **読み込んだプロジェクトそのもの** から、地物ごとに
//   - いちばん新しい名前（空・ID と同じなら「名前が無い」）
//   - 種類（面・線・点）
//   - 最初に現れた年（設計書 §H.1 の「名前のない面（1500年に作成）」の年）
// を引けるようにする。孤立した歴史は持ち主が **どの年にも居ない** のが定義なので、中に入っている
// 地物の名前で「どの歴史か」を言えるようにする。
//
// 純粋（React なし）。プロジェクトを 1 回なめて表を作るだけで、元の値は変えない。

import { idToString, type FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';

/** 1 つの地物について、呼び名を作るのに要るもの。 */
export interface RepairTargetInfo {
  /** 名前。空・ID と同じ（＝実質名前が無い）なら null。 */
  readonly name: string | null;
  /** 種類の呼び名（面・線・点。分からなければ「地物」）。 */
  readonly kindLabel: string;
  /** 最初に現れた年。どの年にも居なければ null。 */
  readonly createdYear: number | null;
}

/** 修復ダイアログの呼び名の引き先（{@link buildRepairNamer} が作る）。 */
export interface RepairNamer {
  /** 地物 1 つの素性。プロジェクトのどこにも居なければ名前も年も無い。 */
  readonly featureInfo: (id: FeatureId) => RepairTargetInfo;
  /**
   * その地物を持ち主とする歴史に入っている、**持ち主以外の** 地物（現れた順）。歴史が無ければ
   * null。孤立した歴史（持ち主がどの年にも居ない）を、中身の名前で呼ぶために使う。
   */
  readonly historyMembers: (ownerId: FeatureId) => readonly FeatureId[] | null;
}

/** 地物の種類 → 画面の呼び名。まとめ役も面として呼ぶ（地図の上では面に見える）。 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  point: '点',
  line: '線',
  leaf: '面',
  aggregate: '面',
};

/** 地物の種類が分からないときの呼び名。 */
const UNKNOWN_KIND_LABEL = '地物';

interface Gathered {
  name: string | null;
  nameYear: number;
  kindLabel: string;
  createdYear: number;
}

/** 読み込んだプロジェクトから、修復ダイアログの呼び名の引き先を作る（純粋）。 */
export function buildRepairNamer(project: DomainProject): RepairNamer {
  const byId = new Map<FeatureId, Gathered>();
  const membersByOwner = new Map<FeatureId, FeatureId[]>();
  for (const history of project.histories) {
    let members = membersByOwner.get(history.featureId);
    const recordMembers = members === undefined;
    if (members === undefined) members = [];
    for (const entry of history.series.entries) {
      const year = entry.start.year;
      for (const feature of entry.anchor.snapshot.features) {
        const raw = feature.attributes.name.trim();
        const name = raw.length === 0 || raw === idToString(feature.id) ? null : raw;
        const kindLabel = KIND_LABEL[feature.kind] ?? UNKNOWN_KIND_LABEL;
        const seen = byId.get(feature.id);
        if (seen === undefined) {
          byId.set(feature.id, { name, nameYear: year, kindLabel, createdYear: year });
        } else {
          if (year < seen.createdYear) seen.createdYear = year;
          // 名前は **いちばん新しい年** のものを使う（いま地図で見えている名前）。
          if (year >= seen.nameYear) {
            seen.nameYear = year;
            seen.name = name ?? seen.name;
          }
        }
        if (recordMembers && feature.id !== history.featureId && !members.includes(feature.id)) {
          members.push(feature.id);
        }
      }
    }
    if (recordMembers) membersByOwner.set(history.featureId, members);
  }
  return {
    featureInfo: (id) => {
      const found = byId.get(id);
      if (found === undefined) {
        return { name: null, kindLabel: UNKNOWN_KIND_LABEL, createdYear: null };
      }
      return { name: found.name, kindLabel: found.kindLabel, createdYear: found.createdYear };
    },
    historyMembers: (ownerId) => membersByOwner.get(ownerId) ?? null,
  };
}

/**
 * 地物 1 つの呼び名（設計書 §H.1）。名前があれば名前、無ければ「名前のない面（1500年に作成）」。
 * `withYear` なら名前があっても年を添える（同じ名前の地物を見分けるため）。
 */
export function repairTargetLabel(info: RepairTargetInfo, withYear = false): string {
  const year = info.createdYear === null ? '' : `（${String(info.createdYear)}年に作成）`;
  if (info.name === null) return `名前のない${info.kindLabel}${year}`;
  return withYear ? `${info.name}${year}` : info.name;
}
