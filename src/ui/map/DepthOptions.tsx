// UI layer (map): 「深さ ▾」ポップオーバー（増分 5a / 設計書 §B.4・§C.4）。
//
// **これが直すもの**: 階層深度のスライダーと個別フォーカスの 4 部品は、起動から終了まで
// アプリバーに出しっぱなしだった。理由は「選択の有無で占有幅が変わると上部バーの折り返し
// 段数が変わり、地図の上端が飛ぶ」（K-3）を **常設＋無効化** で守っていたためで、その結果
// 起動直後から灰色のボタンが 400px 弱の一等地を占めていた（現状分析 N-33 / D-02）。
//
// 設計書 §B.4 の答えは「固定寸法の枠に入れて中身だけ差し替える」であり、**個別フォーカスの
// 4 部品はアプリバーから降ろして、オプションバーの『深さ ▾』ポップオーバーへ移す**。
// アプリバーが 32px 固定になったのはこれが降りたからである。
//
// **中身は `GlobalDepthControl` をそのまま入れる**（役割も testid も変えない＝T-1）。
// 置き方の作法（`position: fixed`／`[hidden]` の打ち消し／背面に板を置かない／状態が
// 移ったら閉じる）は共通の器 `shell/OptionPopover` が持つ ―― 4 枚目の写しを作らない
// （教訓 5.44 / 5.56）。

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { OptionPopover } from '../shell/OptionPopover';
import { DISPLAY_CONTROL_STRINGS } from '../shell/strings';
import type { SessionStore } from '../state/store';

export interface DepthOptionsProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** 開閉の報せ（`focusOwner` の導出。設計書 §D.1）。 */
  readonly onOpenChange?: (open: boolean) => void;
  /** パネルの中身（`GlobalDepthControl` を配線した板）。 */
  readonly children: ReactNode;
}

export function DepthOptions<S>(props: DepthOptionsProps<S>): JSX.Element {
  const { store, children, onOpenChange } = props;
  // K-5「状態が移ったら閉じる」ための指紋。表示 ▾ と同じ 4 つを見る。
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const currentTime = useStore(store, (s) => s.currentTime);
  const projectLoadNonce = useStore(store, (s) => s.projectLoadNonce);

  return (
    <OptionPopover
      label={DISPLAY_CONTROL_STRINGS.depthMenuLabel}
      buttonTestId="option-depth-button"
      panelTestId="option-depth-panel"
      buttonClassName="option-popover__button"
      panelClassName="option-popover__panel option-popover__panel--depth"
      ariaLabel={DISPLAY_CONTROL_STRINGS.depthMenuLabel}
      closeKey={`${mode}|${activeTool ?? ''}|${String(currentTime)}|${projectLoadNonce}`}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {() => children}
    </OptionPopover>
  );
}
