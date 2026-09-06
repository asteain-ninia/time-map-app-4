// UI layer (U20 / shell): 左のレール ―― 鍵 1 個と、道具の 1 段（設計書 §C.3 / 裁定 1）。
//
// **増分 5b で何が変わったか**: 「表示専用／追加モード／編集モード」の 3 ボタンを廃し、
// **鍵 1 個（読むだけ ⇄ 直せる）** ＋ **道具の 1 段** にした。起動して最初にやることが
// 「表示専用を解除する」という否定形の操作でなくなり、面を描くまでの手数が
// 「追加モードに入る → 面を選ぶ」の 2 手から「面を押す」の 1 手になる。
//
// **内部の `mode` は消えていない。** 道具から導出する（`tools.ts` の `modeForTool`）:
//
//     mode = 鍵が閉じている ? 'view' : （面／線／点）? 'add' : 'edit'
//
// `canEdit(mode)` は 1 か所のまま、`app-mode` の観測も `aria-pressed` も生きている
// （T-2 / T-4）。**`mode-view` の testid は据え置く**（役割＝編集を止めるトグルは同じ。
// T-1「役割で維持し、改名しない」）。消えるのは `mode-add` / `mode-edit` の 2 つで、
// これは裁定 1 の帰結として避けられない。
//
// 群の区切りは 8px のすき間（近接によるまとまり）で作る。**枠は入れない** ―― 88px の
// レールに枠を足すと、道具のラベルに使える幅がさらに減る。
//
// 「測る」だけは `ToolId` の軸ではなく `store.survey` の軸に居る（U37 §2.1: 補助モードで、
// **読むだけでも使える**）。設計書 §C.3 は「道具に移す」としているが、`ToolId` にすると
// 鍵で無効化されて「読むだけでは測れない」になる ―― 測るのは編集ではないので、
// **1 段の中に並べつつ軸は別のまま**にした（実装者の判断。司令塔未確認）。

import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { SurveyControls } from '../survey/SurveyControls';
import { Tooltip } from './Tooltip';
import { TOOL_GROUPS, TOOL_ID } from './tools';
import { useShell } from './useShell';
import { LOCK_LABELS, TOOL_LABELS, TOOLTIPS } from './strings';

export interface ToolbarProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function Toolbar<S>(props: ToolbarProps<S>): JSX.Element {
  const shell = useShell(props.store);

  return (
    <nav className="toolbar" aria-label="ツールバー" data-testid="toolbar">
      {/* 鍵（設計書 §C.1 の 4）。**K-6 の唯一の判定点**で、閉めると 10 の変更経路が
          同時に止まる。2 状態とも同じ文字数の枠に収める。
          HB-16: 吹き出しは付けない（ホバーの泡が押下を邪魔していた＝ユーザー決定
          2026-06-21）。testid は `mode-view` のまま据え置く（T-1）。 */}
      <div className="toolbar__lock" data-testid="toolbar-modes" role="group" aria-label="鍵">
        <button
          type="button"
          data-testid="mode-view"
          aria-pressed={shell.locked}
          onClick={() => shell.setLocked(!shell.locked)}
          title={shell.locked ? LOCK_LABELS.lockedHint : LOCK_LABELS.unlockedHint}
        >
          {shell.locked ? LOCK_LABELS.locked : LOCK_LABELS.unlocked}
        </button>
      </div>

      <div className="toolbar__tools" role="group" aria-label="ツール選択" data-testid="toolbar-tools">
        {TOOL_GROUPS.map((group) => (
          <div
            key={group.id}
            className="toolbar__group"
            role="group"
            aria-label={group.label}
            data-testid={`toolbar-group-${group.id}`}
          >
            {group.tools.map((tool) => {
              const label = TOOL_LABELS[tool as keyof typeof TOOL_LABELS] ?? tool;
              const tip = TOOLTIPS[tool] ?? label;
              // 「選ぶ」は道具を外した状態（`activeTool === null`）でも押されて見える
              // ―― 利用者から見れば同じ状態だからである（設計書 §D.4 の階段の最後）。
              const pressed =
                tool === TOOL_ID.EditSelect
                  ? shell.isSelectToolActive
                  : shell.activeTool === tool;
              return (
                <Tooltip key={tool} text={tip}>
                  <button
                    type="button"
                    data-testid={`tool-${tool}`}
                    data-tool={tool}
                    aria-pressed={pressed}
                    // 読むだけのときは道具を構えられない（K-6。`canEdit` 1 本で判定する）。
                    disabled={!shell.editable}
                    onClick={() =>
                      // **「選ぶ」は外れない。** 素の状態が「選ぶ」なので、押して
                      // 外れる先が無い（外したら「選ぶ」になる＝同じところへ戻る）。
                      // ほかの道具はもう一度押すと外れ、「選ぶ」へ戻る。
                      shell.selectTool(
                        tool === TOOL_ID.EditSelect ? tool : pressed ? null : tool,
                      )
                    }
                  >
                    {label}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}

        {/* 調べる（測る）。`ToolId` ではなく survey の軸なので、部品ごと持ってくる。
            **読むだけでも押せる**（無効化しない＝U37 §2.1）。testid は `survey-toggle`
            のまま据え置く（T-1: 役割は「測量モードの入口」で変わっていない）。 */}
        <div
          className="toolbar__group"
          role="group"
          aria-label="調べる"
          data-testid="toolbar-group-inspect"
        >
          <SurveyControls store={props.store} />
        </div>
      </div>
    </nav>
  );
}
