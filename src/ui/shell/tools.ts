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

// --- 道具は 1 段（増分 5b / 設計書 §C.3）------------------------------------------
//
// **裁定 1（2026-09-03）**: モードの 3 ボタンを廃し、鍵 1 個＋道具の 1 段にする。
// モードは道具から **導出** する（下の {@link modeForTool}）ので、「追加モードに入って
// から面を選ぶ」という 2 手が「面を押す」の 1 手になる。
//
// 群は設計書 §C.3 の「近接で 4 群」に **1 つ足して 5 群**にしてある。足したのは
// 「動かす」で、設計書は「選ぶ道具に吸収して廃止」としているが **廃止はまだ済んで
// いない**（`edit.move` は実装にも E2E 8 本にも生きている）。吸収するには Alt＋ドラッグ
// という別の口を作る必要があり、それは増分 5 の「緑に戻す条件」に含まれていない。
// **実装者の判断**（司令塔未確認）として、いまは 1 段の中に残してある。

/** 道具の群（画面では 8px のすき間で区切る）。 */
export interface ToolGroup {
  readonly id: string;
  /** 群の読み上げ名（`role="group"` の `aria-label`）。 */
  readonly label: string;
  readonly tools: readonly ToolId[];
}

/**
 * 1 段に並ぶ道具の全部と、その群分け（設計書 §C.3）。**並び順の単一の真実源**で、
 * ツールバーも「道具を全部回す」検査もここを読む。
 */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: 'select',
    label: '選ぶ',
    tools: [TOOL_ID.EditSelect, TOOL_ID.EditVertex, TOOL_ID.EditMove],
  },
  {
    id: 'draw',
    label: '描く',
    tools: [TOOL_ID.AddArea, TOOL_ID.AddLine, TOOL_ID.AddPoint],
  },
  {
    id: 'shape',
    label: '形を変える',
    tools: [TOOL_ID.EditRing, TOOL_ID.EditKnife, TOOL_ID.EditDrill],
  },
  {
    id: 'relate',
    label: '関係を変える',
    tools: [TOOL_ID.EditReparent, TOOL_ID.EditMerge],
  },
];

/** 1 段に並ぶ道具の全部（群を平らにしたもの）。 */
export const ALL_TOOLS: readonly ToolId[] = TOOL_GROUPS.flatMap((g) => g.tools);

/**
 * **内部の `mode` が `add` になる道具**（面・線・点）。FR-75 の排他はここで保たれる ――
 * 画面からモードの段は消えるが、`mode` という値そのものは残り、`canEdit` も
 * `resolveCommandEnabled` も従来どおり 1 か所で効く。
 */
export function isAddTool(tool: ToolId | null): boolean {
  return tool !== null && ADD_MODE_TOOLS.includes(tool);
}

/**
 * 内部の `mode` の導出式（設計書 §D.1）:
 *
 * ```
 * mode = 鍵が閉じている ? 'view' : （面／線／点の道具）? 'add' : 'edit'
 * ```
 *
 * **`view` を式から落としてはいけない。** `canEdit(mode)` は `mode !== View` の 1 行
 * なので、`view` が出なくなると **読むだけの関門（K-6）が丸ごと消える**（設計書 §A.1 /
 * §D.1 が 2 か所に同じ形で書いている理由がこれである）。
 */
export function modeForTool(locked: boolean, tool: ToolId | null): EditMode {
  if (locked) return EDIT_MODE.View;
  return isAddTool(tool) ? EDIT_MODE.Add : EDIT_MODE.Edit;
}

/**
 * 「選ぶ」道具を構えているか。**道具を外した状態（`null`）も「選ぶ」とみなす** ――
 * 道具のコントローラは取り消し（Escape）で `activeTool` を `null` に戻すので、
 * 「何も構えていない」と「選ぶを構えている」は利用者から見て同じ状態である
 * （設計書 §D.4 の階段の最後「道具が『選ぶ』以外 → 『選ぶ』道具に戻る」）。
 */
export function isSelectTool(tool: ToolId | null): boolean {
  return tool === null || tool === TOOL_ID.EditSelect;
}

/**
 * 頂点ハンドルを出す道具か（設計書 §C.3。旧実装は「編集モードのときだけ」だったが、
 * モードの段が消えたので **道具で決める**）。「選ぶ」「頂点」「動かす」の 3 つが、
 * 選んだ地物の頂点・辺を掴める道具である。
 */
export function toolShowsVertexHandles(tool: ToolId | null): boolean {
  return (
    isSelectTool(tool) || tool === TOOL_ID.EditVertex || tool === TOOL_ID.EditMove
  );
}

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
