// U31 deletion — 削除の見方（DeletionState）全体を掃除する 1 か所（所有者の裁定 2026-09-07）。
//
// 錨ごとの掃除結果を返す。`bundling` があれば、**その錨が始まる時刻の全系列の束**を
// 1 回だけ掃除し（同じ時刻に始まる錨は束を共有する）、結果から錨自身の範囲を切り出す。
// 無ければ従来どおり錨 1 枚で掃除する。実行（command.ts）・影響の一覧（impact.ts）・
// 判定（eligibility.ts）は全部ここを通るので、見せる影響と実際に起きることがずれない
// （教訓 5.26 / 5.30）。

import type { Feature } from '../feature';
import type { FeatureId } from '../ids';

import type { DeletionState } from './state';
import { sweepAndPruneAnchor, type AnchorSweepResult } from './sweep';

/** 束 1 つを掃除した結果: 位置ごとの掃除後の地物（消えたら null）と、生き残り全部。 */
interface BundleSweep {
  readonly byPosition: readonly (Feature | null)[];
  readonly survivors: readonly Feature[];
}

/** {@link sweepDeletionState} の結果。 */
export interface DeletionStateSweep {
  /** `state.anchors` と同じ並びの、錨ごとの掃除結果（錨自身の地物に限る）。 */
  readonly perAnchor: readonly AnchorSweepResult[];
  /**
   * 束ごとの掃除後の全地物（束を使わない錨しか無ければ空）。削除後の階層の検査が
   * 「その時刻の世界」を見るのに使う。
   */
  readonly bundleSurvivors: readonly (readonly Feature[] | undefined)[];
}

function sweepBundle(features: readonly Feature[], targets: ReadonlySet<FeatureId>): BundleSweep {
  const swept = sweepAndPruneAnchor(features, targets, { sweepAbsentTargets: true });
  // sweepAndPruneAnchor は順序を保ち、取り除いた id の地物だけを落とす（同じ id の写しが
  // 複数あっても全部落ちる）。元の並びを辿れば位置の対応が取り戻せる。
  const removed = new Set<FeatureId>(swept.removedIds);
  const byPosition: (Feature | null)[] = [];
  let cursor = 0;
  for (const f of features) {
    if (removed.has(f.id)) {
      byPosition.push(null);
      continue;
    }
    byPosition.push(swept.features[cursor] ?? null);
    cursor += 1;
  }
  return { byPosition, survivors: swept.features };
}

/** 削除の見方の全錨を、`targets` について掃除＋連鎖剪定する（純粋）。 */
export function sweepDeletionState(
  state: DeletionState,
  targets: ReadonlySet<FeatureId>,
): DeletionStateSweep {
  const bundling = state.bundling;
  const cache = new Map<number, BundleSweep>();
  const bundleSweep = (k: number): BundleSweep | undefined => {
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const bundle = bundling?.bundles[k];
    if (bundle === undefined) return undefined;
    const done = sweepBundle(bundle.features, targets);
    cache.set(k, done);
    return done;
  };

  const perAnchor: AnchorSweepResult[] = state.anchors.map((anchor, index) => {
    const slot = bundling?.slots[index];
    const sweep = slot === undefined ? undefined : bundleSweep(slot.bundle);
    const bundle = slot === undefined ? undefined : bundling?.bundles[slot.bundle];
    if (slot === undefined || sweep === undefined || bundle === undefined) {
      // 束に載らない錨は錨 1 枚で掃除する（ただし対象への参照は居なくても掃除する）。
      return sweepAndPruneAnchor(anchor.snapshot.features, targets, {
        sweepAbsentTargets: bundling !== undefined,
      });
    }
    const features: Feature[] = [];
    const removedIds = new Set<FeatureId>();
    const editedIds = new Set<FeatureId>();
    for (let j = slot.from; j < slot.to; j += 1) {
      const original = bundle.features[j];
      if (original === undefined) continue;
      const after = sweep.byPosition[j] ?? null;
      if (after === null) {
        removedIds.add(original.id);
        continue;
      }
      if (after !== original) editedIds.add(after.id);
      features.push(after);
    }
    return { features, removedIds, editedIds };
  });

  const bundleSurvivors: (readonly Feature[] | undefined)[] = [];
  for (let k = 0; k < (bundling?.bundles.length ?? 0); k += 1) {
    bundleSurvivors.push(cache.get(k)?.survivors);
  }
  return { perAnchor, bundleSurvivors };
}
