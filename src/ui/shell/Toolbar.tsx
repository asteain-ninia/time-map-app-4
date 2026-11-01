// UI layer (U20 / shell): 左のレール ―― 道具の 1 段だけ（設計書 §C.3 / 裁定 1）。
//
// **増分 5b で何が変わったか**: 「表示専用／追加モード／編集モード」の 3 ボタンを廃し、
// **鍵 1 個（読むだけ ⇄ 直せる）** ＋ **道具の 1 段** にした。起動して最初にやることが
// 「表示専用を解除する」という否定形の操作でなくなり、面を描くまでの手数が
// 「追加モードに入る → 面を選ぶ」の 2 手から「面を押す」の 1 手になる。
//
// **増分 5 の手直し D1 で、鍵はレールから出てアプリバーの右端へ戻った**（設計書 §C.1 の
// 4「鍵／96 固定」）。レールに鍵を置くと、鍵のボタン 32px ＋ 区切り線 ＋ すき間 16px が
// 道具から高さを奪い、既定の窓（1280×800）でも道具 12 個が縦に入りきらなかった。
// 鍵の部品は {@link LockButton}、置き場は `AppShell` のアプリバーである。
// **ここに残るのは道具 12 個（`ALL_TOOLS` の 11 個 ＋ 測る）だけ**になった。
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
// **縦に入りきる寸法の根拠は `shell.css` の `.toolbar` の注記にある**（12 個 × 32px ＋
// 群の隙間 ＋ 余白 ＝ 442px で、1366×768 の 466.8px に収まる）。ボタンの数と群の数を
// 変えると縦の予算も変わるので、変えるときは `shell-layout.test.ts` の予算の検査を
// 一緒に読むこと（`ALL_TOOLS` と `TOOL_GROUPS` から数を引いて計算している）。
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
import { APP_STRINGS, SHELL_TEXT, TOOL_LABELS, TOOLTIPS } from './strings';

export interface ToolbarProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function Toolbar<S>(props: ToolbarProps<S>): JSX.Element {
  const shell = useShell(props.store);

  return (
    <nav className="toolbar" aria-label={APP_STRINGS.toolbarAriaLabel} data-testid="toolbar">
      <div className="toolbar__tools" role="group" aria-label={SHELL_TEXT.toolSelectAriaLabel} data-testid="toolbar-tools">
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
              // 「選択」は道具を外した状態（`activeTool === null`）でも押されて見える
              // ―― 利用者から見れば同じ状態だからである（設計書 §D.4 の階段の最後）。
              const pressed =
                tool === TOOL_ID.EditSelect
                  ? shell.isSelectToolActive
                  : shell.activeTool === tool;
              return (
                <Tooltip key={tool} text={tip} placement="beside-rail">
                  <button
                    type="button"
                    data-testid={`tool-${tool}`}
                    data-tool={tool}
                    aria-pressed={pressed}
                    // 読むだけのときは道具を構えられない（K-6。`canEdit` 1 本で判定する）。
                    disabled={!shell.editable}
                    onClick={() =>
                      // **「選択」は外れない。** 素の状態が「選択」なので、押して
                      // 外れる先が無い（外したら「選択」になる＝同じところへ戻る）。
                      // ほかの道具はもう一度押すと外れ、「選択」へ戻る。
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
          aria-label={SHELL_TEXT.inspectGroupAriaLabel}
          data-testid="toolbar-group-inspect"
        >
          <SurveyControls store={props.store} />
        </div>
      </div>
    </nav>
  );
}
