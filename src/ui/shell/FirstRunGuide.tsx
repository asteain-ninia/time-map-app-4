// UI layer (U20 / shell): 初回起動のガイド 4 枚（FR-118 / 設計書 §H.3 の 1〜4。増分 6）。
//
// **器は共有の `GuidePanel`**（重なり解決の使い方と同じ形）。出すかどうかはアプリ全体の
// 設定 1 つ（`showFirstRunGuide`）で、「今後表示しない」を押すとそこへ書く ―― 押したきり
// 二度と出せない、を作らないために **設定ダイアログにも同じ項目**を置いてある。
//
// **置き場は右パネルの下**（地図には重ねない）。K-2 が禁じているのは地図の押下を奪う
// DOM の覆いなので、地図セルの外に置けばその型の事故は構造的に起こらない。

import { useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

import { GuidePanel } from './GuidePanel';
import { FIRST_RUN_GUIDE } from './strings';

export interface FirstRunGuideProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function FirstRunGuide<S>(props: FirstRunGuideProps<S>): JSX.Element | null {
  const { store } = props;
  const show = useStore(store, (s) => s.appSettings.showFirstRunGuide);
  // 今回だけ閉じる（設定は書かない）。**設定が真に戻れば次の起動でまた出る。**
  const [closed, setClosed] = useState(false);
  if (!show || closed) return null;
  return (
    <div className="first-run-guide" data-testid="first-run-guide-root">
      <GuidePanel
        content={FIRST_RUN_GUIDE}
        className="first-run-guide__panel"
        testId="first-run-guide"
        onClose={() => setClosed(true)}
        onSuppress={() => store.getState().updateAppSetting('showFirstRunGuide', false)}
      />
    </div>
  );
}
