// UI layer (shell): **地図に焦点があるときだけ効く打鍵**（増分 8C の手直し / GPT #2。設計書 §I.2）。
//
// 設計書 §I.2 は道具の打鍵（`U` で測る）を「地図にフォーカスがあるときのみ」としている。
// ところが地図そのものは焦点を持たない（`map-input-layer` は tabIndex を持たず、地図を押すと
// 焦点は本文 `body` へ移る）ので、「地図に焦点がある」を直接は判定できない。そこで次のように
// 近づける（実装者の判断。配下 README の B-3）:
//
//   効く:   焦点がどこにも無い（`body` / `html`）＝地図を押した直後・起動直後
//           焦点が地図の区画（`.map-area`。地図の上の浮いた操作を含む）の中にある
//           焦点が道具のレール（`.toolbar`）の中にある ―― 「📏 測る」を押した直後に `U` で
//           終えられるように（レールは道具そのものの置き場で、文字や行を扱う区画ではない）
//   効かない: 一覧・素性欄・時刻レール・オプションバー・メニューなど、それ以外の区画に焦点がある
//
// 入力欄（文字を打つ欄・つまみ）はこれより前に、打鍵の割り振りの入口が止めている。
// 打鍵の割り振り（`useShortcuts`）だけがこの関門を見る ―― メニューの項目から選んだときは
// 焦点の場所に依らず効く（メニューは押した場所が意図そのものだから）。

import { COMMAND_ID, type CommandId } from './commands';

/** 地図に焦点があるとき（上の「効く」）だけ打鍵で効くコマンド。 */
export const MAP_FOCUS_ONLY_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.ToolsSurvey,
]);

/**
 * **押しっぱなし（キーリピート）で繰り返さない** 打鍵（増分 8C の手直し / 反証 #5）。
 * 「持つ／終える」の切り替えは、押しっぱなしだと回数の偶奇で最後の状態が毎回変わる。
 */
export const NO_REPEAT_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.ToolsSurvey,
]);

/** 地図の区画と、道具のレール（上の説明）。 */
const MAP_FOCUS_SCOPE_SELECTOR = '.map-area, .toolbar';

/**
 * 打鍵を受けた要素（`KeyboardEvent.target` ＝焦点のある要素）が「地図に焦点がある」に
 * 当たるか。焦点がどこにも無い（本文・文書そのもの・null）も当たるとする。
 */
export function focusIsOnMap(target: EventTarget | null): boolean {
  if (target === null) return true;
  if (typeof Element === 'undefined' || !(target instanceof Element)) return true;
  const doc = target.ownerDocument;
  if (target === doc.body || target === doc.documentElement) return true;
  return target.closest(MAP_FOCUS_SCOPE_SELECTOR) !== null;
}
