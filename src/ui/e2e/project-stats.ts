// 実データの規模を E2E から測るための観測（T-2「隠し観測は仕様として残し、足す一方にする」）。
//
// なぜ要るか: UI 再設計の受け入れ条件は「775 行の一覧」「表示名が完全に重複する 12 件」
// 「2,230 頂点の地物」「錨 689 件」のように**実データの規模で書かれている**（実装計画 §1、
// 現状分析 §7.1）。これらは画面からは数えられない——一覧の行は名前しか運ばず、頂点数は
// どこにも出ず、錨は全部「0年 → 継続中」で 1 本ずつだからである。ドメインの値を素直に
// 数える口をひとつ開けておけば、以降の増分の受け入れ条件が実データで測れる。
//
// **純関数にしてある**（教訓 5.41: E2E で検証できない範囲は純関数化して単体テストで補う）。
// 登録は App.tsx が行い、E2E ブリッジがあるときだけ window に生える（本番では何も出ない）。
//
// 数え方の注意（現状分析 §7.1 の申し送り）: 「履歴（錨列）の数」と「地物の数」は別物である。
// 集約の子は親のスナップショットにも入るので、**id で畳んだ地物の数のほうが多くなる**
// （実データで錨列 689 に対し地物 775）。どちらを見ているか揃えずに比較しないこと。

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { DomainProject } from '../../domain/persistence/serialize';

/** 同じ表示名を持つ地物のかたまり。 */
export interface DuplicateNameGroup {
  readonly name: string;
  readonly count: number;
}

/** いちばん頂点の多い地物。地物が 1 つも無ければ null。 */
export interface HeaviestFeature {
  readonly id: string;
  readonly name: string;
  /** リング参照の合計（実体の頂点数ではない）。 */
  readonly vertexCount: number;
  readonly ringCount: number;
}

export interface ProjectStats {
  /** 履歴（錨列）の数。地物ごとに 1 本。 */
  readonly historyCount: number;
  /** 錨の総数（全錨列の区間の合計）。 */
  readonly anchorCount: number;
  /** id で畳んだ地物の数（集約の子は親のスナップショットにも入るので錨列より多い）。 */
  readonly featureCount: number;
  readonly leafCount: number;
  readonly aggregateCount: number;
  /** 表示名のユニーク数。 */
  readonly uniqueNameCount: number;
  /** 2 件以上が同じ表示名を持つかたまり（多い順）。 */
  readonly duplicateNameGroups: readonly DuplicateNameGroup[];
  /** 上のかたまりに属する地物の総数（＝画面で区別できない地物の数）。 */
  readonly duplicateNamedFeatureCount: number;
  readonly heaviestFeature: HeaviestFeature | null;
}

function vertexCountOf(feature: Feature): { vertexCount: number; ringCount: number } {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return { vertexCount: 1, ringCount: 0 };
    case FEATURE_KIND.Line:
      return { vertexCount: feature.vertexIds.length, ringCount: 0 };
    case FEATURE_KIND.Leaf: {
      const rings = feature.shape.rings;
      let total = 0;
      for (const ring of rings) total += ring.vertexIds.length;
      return { vertexCount: total, ringCount: rings.length };
    }
    case FEATURE_KIND.Aggregate:
      // 集約は自前の形を持たない（面積は子から導出する）。
      return { vertexCount: 0, ringCount: 0 };
    default:
      return { vertexCount: 0, ringCount: 0 };
  }
}

/**
 * プロジェクトの規模を数える。**同じ id の地物は最初に出会ったものを採る**（錨ごとの
 * スナップショットに同じ id が何度も現れるため）。
 */
export function projectStats(project: DomainProject): ProjectStats {
  const byId = new Map<string, Feature>();
  let anchorCount = 0;

  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      anchorCount += 1;
      for (const feature of entry.anchor.snapshot.features) {
        const id = String(feature.id);
        if (!byId.has(id)) byId.set(id, feature);
      }
    }
  }

  const nameCounts = new Map<string, number>();
  let leafCount = 0;
  let aggregateCount = 0;
  let heaviest: HeaviestFeature | null = null;

  for (const [id, feature] of byId) {
    if (feature.kind === FEATURE_KIND.Leaf) leafCount += 1;
    if (feature.kind === FEATURE_KIND.Aggregate) aggregateCount += 1;

    const name = feature.attributes.name;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);

    const { vertexCount, ringCount } = vertexCountOf(feature);
    if (heaviest === null || vertexCount > heaviest.vertexCount) {
      heaviest = { id, name, vertexCount, ringCount };
    }
  }

  const duplicateNameGroups: DuplicateNameGroup[] = [];
  for (const [name, count] of nameCounts) {
    if (count > 1) duplicateNameGroups.push({ name, count });
  }
  duplicateNameGroups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    historyCount: project.histories.length,
    anchorCount,
    featureCount: byId.size,
    leafCount,
    aggregateCount,
    uniqueNameCount: nameCounts.size,
    duplicateNameGroups,
    duplicateNamedFeatureCount: duplicateNameGroups.reduce((sum, g) => sum + g.count, 0),
    heaviestFeature: heaviest,
  };
}
