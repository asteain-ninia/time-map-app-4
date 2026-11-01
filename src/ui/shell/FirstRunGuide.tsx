// UI layer (U20 / shell): 初回起動のガイド 4 枚（FR-118 / 設計書 §H.3 の 1〜4。増分 6）。
//
// **器は共有の `GuidePanel`**（重なり解決の使い方と同じ形）。
//
// **「今後表示しない」はアプリ側（userData）に覚える**（司令塔の決定 (2)、2026-09-07）。
// 旧版はプロジェクトの設定（保存ファイルの `uiSettings`）にしか書いていなかったので、
// **押しても次の起動でまた出た** ―― 起動直後は新規プロジェクトなので、押した印の
// 行き先がどこにも無い。アプリ側の覚え書きは U15 の型付き IPC 越しに読み書きする
// （レンダラは `fs` に触らない＝ FR-02）。設定ダイアログの項目は「またこのアプリで
// 出す」の入口として残す ―― そこで真に戻したら、アプリ側の覚え書きも戻す。
//
// **置き場は右パネルの列の中**（地図には重ねない）。K-2 が禁じているのは地図の押下を
// 奪う DOM の覆いなので、地図セルの外に置けばその型の事故は構造的に起こらない。
// 旧版は幅 320px を右から 12px に置いていたので、280px の右パネルから **地図セルへ
// 52px はみ出し**、地図の中のズーム 3 ボタンを 5 つの窓の大きさすべてで覆っていた（実測）。

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AppPrefs, TimeMapApi } from '../../shell/ipc/contract';
import type { SessionStore } from '../state/store';

import { GuidePanel } from './GuidePanel';
import { FIRST_RUN_GUIDE } from './strings';

export interface FirstRunGuideProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U15 の型付き IPC。既定は `window.timeMapApi`（無ければアプリ側には覚えない）。 */
  readonly api?: TimeMapApi;
}

/** 生きている U15 の口を読む（無ければ null ―― jsdom の単体テストがそれ）。 */
function liveApi(injected?: TimeMapApi): TimeMapApi | null {
  if (injected !== undefined) return injected;
  const w = globalThis as { timeMapApi?: TimeMapApi };
  return w.timeMapApi ?? null;
}

export function FirstRunGuide<S>(props: FirstRunGuideProps<S>): JSX.Element | null {
  const { store } = props;
  const api = liveApi(props.api);
  const show = useStore(store, (s) => s.appSettings.showFirstRunGuide);
  // 設定が **利用者の手で** 変わった印（読み込みの `reflectLoadedProject` は出さない）。これを見るので、
  // 「読み込みで既定が真に戻った」と「利用者が設定欄で入れ直した」を取り違えない。
  const lastSettingsChange = useStore(store, (s) => s.lastSettingsChange);
  // 今回だけ閉じる（設定は書かない）。**設定が真に戻れば次の起動でまた出る。**
  const [closed, setClosed] = useState(false);
  // アプリ側の覚え書きを読み終えたか。読み終わるまで出さないので「一瞬出てから消える」
  // ちらつきが起きない。口が無ければ（jsdom の単体テスト）読み終えた扱いにする。
  const [prefsRead, setPrefsRead] = useState(api === null);

  useEffect(() => {
    if (api === null) return;
    let alive = true;
    void api
      .readAppPrefs()
      .then((prefs: AppPrefs) => {
        if (!alive) return;
        setPrefsRead(true);
        // **覚え書きを設定欄へ映す**（2026-09-07）。映さないと、次の起動で
        // 「設定欄は『表示する』と言っているのにガイドが出ない」という嘘になる。
        // この設定は保存ファイルを汚さない区分（`COSMETIC_APP_KEY_SET`）なので、
        // ここで書いてもプロジェクトが「未保存」にはならない。
        if (!prefs.showFirstRunGuide && store.getState().appSettings.showFirstRunGuide) {
          store.getState().updateAppSetting('showFirstRunGuide', false);
        }
      })
      .catch(() => {
        if (alive) setPrefsRead(true);
      });
    return () => {
      alive = false;
    };
  }, [api, store]);

  // **利用者が設定欄で入れ直したら、覚え書きも入れ直す**（設定欄を入口として殺さない）。
  // 見るのは「利用者の手で変わった」印だけなので、読み込みで既定へ戻っただけの
  // ときには書かない ―― プロジェクトファイルがアプリ側の覚え書きを上書きしない。
  useEffect(() => {
    if (lastSettingsChange?.key !== 'showFirstRunGuide') return;
    if (api === null) return;
    void api.writeAppPrefs({ showFirstRunGuide: show });
  }, [lastSettingsChange, show, api]);

  if (!show || closed || !prefsRead) return null;
  return (
    <div className="first-run-guide" data-testid="first-run-guide-root">
      <GuidePanel
        content={FIRST_RUN_GUIDE}
        className="first-run-guide__panel"
        testId="first-run-guide"
        onClose={() => setClosed(true)}
        onSuppress={() => {
          // 設定を書けば、上の見張りがアプリ側の覚え書きへも書く（書き口は 1 つ）。
          store.getState().updateAppSetting('showFirstRunGuide', false);
        }}
      />
    </div>
  );
}
