// UI layer (U20 / shell): 道具が掴んでいる面が、いまの年・いまの記録にまだ居るか（B112）。
//
// 輪郭・穴あけは対象の id を自分で持つ。年や記録が変わったら引き直す。引く関数は描いているかの関門も
// 通すので（隠した面は選んでいるあいだだけ描く。B134）、選択と表示条件も鍵に入れる。頂点を打つたびの
// 再描画では引き直さない。

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
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);
  return useMemo(
    () => {
      // 引く関数は呼ぶときの値を読むので、読むものを鍵に入れてある。
      void time;
      void domain;
      void activeFeature;
      void filter;
      void displayControl;
      return targetId === null || resolveFeature(targetId) !== undefined;
    },
    [targetId, resolveFeature, time, domain, activeFeature, filter, displayControl],
  );
}
