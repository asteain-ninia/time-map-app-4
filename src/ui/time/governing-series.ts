// UI layer (U21/U32 共有): 「その地物の歴史はどの系列に書かれているか」を 1 か所で解く
// （設計書 §C.6「集約地物の下位領域の錨」/ 裁定 §N-15）。
//
// **2 つの画面が同じ問いを持つ**ので 1 本に出した（教訓 5.44: 共通ロジックの写しを残さない）。
//   - 素性欄の錨表（増分 2。`SidebarContent` が `AnchorSeriesLookup` として配線する）。
//   - 時刻レールの錨レーン（増分 6。選択中の 1 地物の錨だけを描く）。
// 写しを 2 枚持つと、集約地物の下位領域（実データで 86 件）の扱いが画面ごとに割れる ―― 錨表には
// 出るのにレーンには出ない、という食い違いが**同じ画面の中で**起きる。
//
// 判定は **ドメインと同じ関数** を呼ぶ（`findHistoryContaining`）。属性の編集
// （`applyEditProposal`）はその時刻に自分を含む履歴＝親の系列へ書くので、画面がそこを
// 見なければ「上書きなのか新設なのか」を正しく言えない（教訓 5.46）。

import { resolveAt } from '../../domain/anchor-series';
import { findHistoryContaining } from '../../domain/editing/apply-proposal';
import { featureDisplayName } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import type { GoverningAnchorSeries } from '../property/contracts';

/**
 * その地物の編集が実際に書き込まれる系列を引く。自分の履歴があればそれ、無ければ
 * **その時刻に自分を含む親（集約地物）の系列**。どこにも居なければ null。
 *
 * `unknownOwnerName` は「持ち主の名前が実効スナップショットから引けなかったとき」に
 * 出す文字である。**文言は呼び出し側が持つ**（画面の言葉の置き場は `strings.ts` 側の
 * 1 か所で、ここはロジックだけを持つ）。
 */
export function resolveGoverningSeries(
  root: DomainProject,
  featureId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
  unknownOwnerName: string,
): GoverningAnchorSeries | null {
  const found = findHistoryContaining(root, featureId, at, calendar);
  if (found === undefined) return null;
  const owner = found.history;
  const resolved = resolveAt(owner.series, at, calendar);
  const effectiveSize =
    resolved.kind === 'present'
      ? {
          featureCount: resolved.entry.anchor.snapshot.features.length,
          vertexCount: resolved.entry.anchor.snapshot.vertices.byId.size,
        }
      : null;
  if (owner.featureId === featureId) {
    return {
      series: owner.series,
      ownerFeatureId: featureId,
      ownerName: null,
      effectiveSize,
    };
  }
  // 借り物（親の系列）。持ち主の名前はその時刻の実効スナップショットから引く。
  const ownerFeature =
    resolved.kind === 'present'
      ? resolved.entry.anchor.snapshot.features.find((f) => f.id === owner.featureId)
      : undefined;
  return {
    series: owner.series,
    ownerFeatureId: owner.featureId,
    ownerName:
      ownerFeature === undefined ? unknownOwnerName : featureDisplayName(ownerFeature),
    effectiveSize,
  };
}
