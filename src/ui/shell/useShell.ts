// UI layer (U20 / shell): the store-binding hook for the shell chrome.
//
// **増分 5b でモードの 3 ボタンが鍵 1 個＋道具 1 段になった**（裁定 1）。この hook が
// 見せる軸は 2 本だけである:
//
//   - **鍵**（`locked`）: 読むだけ ⇄ 直せる。K-6 の唯一の判定点で、実体は
//     `store.mode === View` かどうかである（`mode` という値そのものは残す ――
//     `canEdit` / `resolveCommandEnabled` / `app-mode` の観測が全部そこを読む）。
//   - **道具**（`activeTool`）: 常に 1 つ。既定は「選ぶ」＝ 何も構えていない状態。
//
// **内部の `mode` は導出値である**（設計書 §D.1 / `tools.ts` の `modeForTool`）:
//
//     mode = 鍵が閉じている ? 'view' : （面／線／点の道具）? 'add' : 'edit'
//
// 導出そのものはストア（`setActiveTool`）が持つ。道具を構える経路はツールバーだけでは
// ないので、UI 側で `setMode` を並べて呼ぶ形にすると必ずどこかで忘れる（教訓 5.6）。
//
// The shell holds NO map-draw state in React (技術方針 2.3).

import { useCallback } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { EDIT_MODE, type EditMode, type ToolId } from '../state/session';
import { canEdit } from './permissions';
import { isSelectTool } from './tools';

export interface ShellBinding {
  /** 導出された内部モード（`view` / `add` / `edit`）。観測と権限判定はここを読む。 */
  readonly mode: EditMode;
  readonly activeTool: ToolId | null;
  /** 鍵が閉じているか（＝読むだけ）。`mode === View` と同値。 */
  readonly locked: boolean;
  /** True iff editing is permitted in the current mode (教訓 5.13). */
  readonly editable: boolean;
  /**
   * 鍵の開け閉め（設計書 §C.1 の 4）。閉めると `mode` は `view` になり、10 の変更経路が
   * 同時に止まる（K-6）。**選択は捨てない**（裁定 N-4: 読むだけでも選べる・読める・
   * 直せない）。開けたときは「選ぶ」道具に戻す（設計書 §D.2）。
   */
  readonly setLocked: (locked: boolean) => void;
  /** Select / deselect a tool; the store derives `mode` from it (設計書 §D.1). */
  readonly selectTool: (tool: ToolId | null) => void;
  /** 「選ぶ」道具を構えているか（道具を外した状態も「選ぶ」とみなす）。 */
  readonly isSelectToolActive: boolean;
}

export function useShell<S>(store: StoreApi<SessionStore<S>>): ShellBinding {
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const setLocked = useCallback(
    (locked: boolean) => {
      const s = store.getState();
      if (locked) {
        // 閉める。`setMode` は道具を外し、下書きと一時状態を捨てる（K-5）。
        // 選択は保つ（鍵をまたぐ経路では捨てない＝増分 4 の手直し B12）。
        s.setMode(EDIT_MODE.View);
        return;
      }
      if (s.mode !== EDIT_MODE.View) return;
      // 開ける。道具は「選ぶ」＝ 何も構えていない状態から始める（設計書 §D.2）。
      s.setMode(EDIT_MODE.Edit);
    },
    [store],
  );

  const selectTool = useCallback(
    (tool: ToolId | null) => {
      // 「選ぶ」も **押したとおりの値**（`edit.select`）で入れる。
      //
      // 一度は「選ぶ ＝ 道具を外した状態（`null`）」へ寄せたが、それだと
      // **`app-active-tool` の観測が空になる** ―― 利用者は道具を押したのに、
      // 観測の上では「何も構えていない」ことになる。逆に道具の取り消し（Escape）が
      // 戻ってくる先は `null` のままなので、**`null` と `edit.select` はどちらも
      // 「選ぶ」を意味する**。押されて見えるかどうかは {@link isSelectTool} が
      // 1 か所で判定するので、画面が 2 通りに割れることはない。
      store.getState().setActiveTool(tool);
    },
    [store],
  );

  return {
    mode,
    activeTool,
    locked: mode === EDIT_MODE.View,
    editable: canEdit(mode),
    setLocked,
    selectTool,
    isSelectToolActive: isSelectTool(activeTool),
  };
}
