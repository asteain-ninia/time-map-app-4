// UI layer (U20 / shell): the left toolbar (FR-75 / FR-111).
//
// Mode toggle (追加 / 編集 exclusive) + the tool buttons for the active mode.
// The mode→tools mapping comes from the single definition (tools.ts); the
// toolbar never enumerates tools inline (教訓 5.30). Editing controls are gated
// by the single permission predicate (canEdit) — in view-only mode the mode
// toggles and all tools disable together (教訓 5.13). Each button shows a
// Japanese tooltip (FR-112). Tools provide selected state only; behaviour is a
// later unit's (spec スコープ).

import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { Tooltip } from './Tooltip';
import { toolsForMode } from './tools';
import { useShell } from './useShell';
import { MODE_LABELS, TOOL_LABELS, TOOLTIPS } from './strings';

export interface ToolbarProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function Toolbar<S>(props: ToolbarProps<S>): JSX.Element {
  const shell = useShell(props.store);
  const tools = toolsForMode(shell.mode);

  return (
    <nav className="toolbar" aria-label="ツールバー" data-testid="toolbar">
      <div className="toolbar__modes" role="group" aria-label="モード切替">
        {/* 表示専用 ↔ 編集 の出入り口 (FR-75 / 教訓 5.13): View mode disables the
            add/edit toggles, so this single control is the live導線 in/out of the
            display-only state. In View it enables editing (lands in 編集モード via
            setViewOnly(false)); in an editing mode it returns to View. */}
        {/* HB-16: mode toggles carry NO tooltip — the hover bubble was getting in
            the way of the click target (ユーザー決定 2026-06-21). The tool buttons
            below keep their FR-112 tooltips. */}
        <button
          type="button"
          data-testid="mode-view"
          aria-pressed={shell.mode === EDIT_MODE.View}
          onClick={() => shell.setViewOnly(shell.mode !== EDIT_MODE.View)}
        >
          {MODE_LABELS.view}
        </button>
        <button
          type="button"
          data-testid="mode-add"
          aria-pressed={shell.mode === EDIT_MODE.Add}
          // View-only disables editing-mode entry (教訓 5.13).
          disabled={shell.mode === EDIT_MODE.View}
          onClick={() => shell.toggleMode('add')}
        >
          {MODE_LABELS.add}
        </button>
        <button
          type="button"
          data-testid="mode-edit"
          aria-pressed={shell.mode === EDIT_MODE.Edit}
          disabled={shell.mode === EDIT_MODE.View}
          onClick={() => shell.toggleMode('edit')}
        >
          {MODE_LABELS.edit}
        </button>
      </div>

      <div className="toolbar__tools" role="group" aria-label="ツール選択" data-testid="toolbar-tools">
        {tools.map((tool) => {
          const label = TOOL_LABELS[tool as keyof typeof TOOL_LABELS] ?? tool;
          const tip = TOOLTIPS[tool] ?? label;
          return (
            <Tooltip key={tool} text={tip}>
              <button
                type="button"
                data-testid={`tool-${tool}`}
                data-tool={tool}
                aria-pressed={shell.activeTool === tool}
                disabled={!shell.editable}
                onClick={() =>
                  shell.selectTool(shell.activeTool === tool ? null : tool)
                }
              >
                {label}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
}
