// UI layer (U20 / shell): 道具が掴んでいる面が、いまの年・いまの記録にまだ居るか（B112）。
//
// 輪郭・穴あけは対象の id を自分で持つ。年や記録が変わったら引き直す。頂点を打つたびの再描画では
// 引き直さない（年と記録だけを鍵にする）。

import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { FeatureId } from '../../domain/ids';
import type { SessionStore } from '../state/store';

export function useTargetStillThere<S>(
  store: StoreApi<SessionStore<S>>,
  targetId: FeatureId | null,
  resolveFeature: (id: FeatureId) => unknown,
): boolean {
  const time = useStore(store, (s) => s.currentTime);
  const domain = useStore(store, (s) => s.domain);
  return useMemo(
    () => {
      // 引く関数は呼ぶときの年と記録を読むので、その 2 つを鍵に入れてある。
      void time;
      void domain;
      return targetId === null || resolveFeature(targetId) !== undefined;
    },
    [targetId, resolveFeature, time, domain],
  );
}
