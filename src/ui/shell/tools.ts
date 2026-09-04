// UI layer (U20 / shell): tool identifiers and the mode -> tools mapping (FR-75).
//
// Each editing mode exposes a fixed set of tools in the toolbar. The mapping
// from mode to tool set is derived from a SINGLE definition here (教訓 5.30:
// 同じ判定は同じ実装を共有), and tool branching uses these constants, never
// bare literals (教訓 5.19). This unit provides only the tool BUTTONS and their
// selected state; each tool's behaviour is implemented by a later unit
// (spec スコープ「やらないこと」).

import { EDIT_MODE, asToolId, type EditMode, type ToolId } from '../state/session';
import { EDIT_TOOL_STRINGS } from './strings';

/** The canonical tool-id vocabulary. */
export const TOOL_ID = {
  // add mode (点 / 線 / 面, FR-75)
  AddPoint: asToolId('add.point'),
  AddLine: asToolId('add.line'),
  AddArea: asToolId('add.area'),
  // edit mode (選択 / 頂点編集 / 地物移動 / ナイフ / 所属変更 / 結合, FR-75)
  EditSelect: asToolId('edit.select'),
  EditVertex: asToolId('edit.vertex'),
  EditMove: asToolId('edit.move'),
  EditKnife: asToolId('edit.knife'),
  EditReparent: asToolId('edit.reparent'),
  EditMerge: asToolId('edit.merge'),
  // FR-22 / FR-24 穴・飛び地の追加 / リング削除 (U25 ring-edit)
  EditRing: asToolId('edit.ring'),
  // FR-45 穴あけによる新地物生成 (U27 drill)
  EditDrill: asToolId('edit.drill'),
} as const;

/** The tools shown in 追加モード, in toolbar order. */
const ADD_MODE_TOOLS: readonly ToolId[] = [
  TOOL_ID.AddPoint,
  TOOL_ID.AddLine,
  TOOL_ID.AddArea,
];

/** The tools shown in 編集モード, in toolbar order. */
const EDIT_MODE_TOOLS: readonly ToolId[] = [
  TOOL_ID.EditSelect,
  TOOL_ID.EditVertex,
  TOOL_ID.EditMove,
  TOOL_ID.EditKnife,
  TOOL_ID.EditReparent,
  TOOL_ID.EditMerge,
  TOOL_ID.EditRing,
  TOOL_ID.EditDrill,
];

const NO_TOOLS: readonly ToolId[] = [];

/**
 * The tools available for a mode (FR-75). View mode shows no editing tools
 * (it is the display-only permission state). The mapping is the single source
 * the toolbar reads from; adding a tool means editing only this table.
 */
export function toolsForMode(mode: EditMode): readonly ToolId[] {
  switch (mode) {
    case EDIT_MODE.Add:
      return ADD_MODE_TOOLS;
    case EDIT_MODE.Edit:
      return EDIT_MODE_TOOLS;
    case EDIT_MODE.View:
      return NO_TOOLS;
    default: {
      // Exhaustiveness: a new mode must extend this table (教訓 5.19).
      const _never: never = mode;
      return _never;
    }
  }
}

/** True if the tool belongs to the given mode's tool set. */
export function toolBelongsToMode(tool: ToolId, mode: EditMode): boolean {
  return toolsForMode(mode).includes(tool);
}

// --- 編集道具の日本語名（オプションバーの 112px の区画。設計書 §C.4）-------------
//
// **なぜ対応表がここ（tools.ts）にあるか**: `TOOL_ID` は道具の語彙の単一の場所で、
// 道具を足すときに必ず触る場所でもある。名前の表を同じ場所へ置くと「道具を足したのに
// 名前を付け忘れた」が下の `Record` の網羅性でコンパイルエラーになる（教訓 5.19 /
// 5.29）。**文言そのもの**は `strings.ts` に集約したまま（技術方針 5.5）で、ここが持つ
// のは「どの ToolId がどの文言か」の対応だけである。

/**
 * `TOOL_ID` のキーのうち **編集モードの道具**（`Edit…`）だけ。`Record` の鍵にすると
 * 道具の増減がそのまま名前表の網羅性検査になる（`ToolId` は全部が同じ型なので
 * `Record<ToolId, string>` では網羅性が効かない ―― `asToolId` を通した時点で
 * 個別の文字列リテラル型ではなくなるため）。
 */
type EditToolKey = Extract<keyof typeof TOOL_ID, `Edit${string}`>;

/** 編集道具の名前（キーは {@link TOOL_ID} の名前）。抜けはコンパイルエラーになる。 */
const EDIT_TOOL_NAMES: Readonly<Record<EditToolKey, string>> = {
  EditSelect: EDIT_TOOL_STRINGS.select,
  EditVertex: EDIT_TOOL_STRINGS.vertex,
  EditMove: EDIT_TOOL_STRINGS.move,
  EditKnife: EDIT_TOOL_STRINGS.knife,
  EditReparent: EDIT_TOOL_STRINGS.reparent,
  EditMerge: EDIT_TOOL_STRINGS.merge,
  EditRing: EDIT_TOOL_STRINGS.ring,
  EditDrill: EDIT_TOOL_STRINGS.drill,
};

/** 引く側の索引（ToolId → 名前）。上の表を 1 度だけ舐めて作るので二重に書かない。 */
const EDIT_TOOL_NAME_BY_ID: ReadonlyMap<ToolId, string> = new Map(
  Object.entries(EDIT_TOOL_NAMES).map(([key, name]) => [TOOL_ID[key as EditToolKey], name]),
);

/**
 * 道具の日本語名。**編集モードの 8 つの道具だけ**が名前を持ち、追加モードの 3 つ
 * （点・線・面）は `null` を返す ―― 追加の名前は追加の道具（`ui/add/strings.ts` の
 * `toolNameFace` など）が自分で押し込むので、ここに書くと同じ文言が 2 か所へ割れる。
 * `null` は「この道具の帯はここでは面倒を見ない」の意味でもある。
 */
export function editToolName(tool: ToolId): string | null {
  return EDIT_TOOL_NAME_BY_ID.get(tool) ?? null;
}
