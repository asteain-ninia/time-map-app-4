// UI 層（素性欄の「見た目」）: 自動配色を OFF にしたとき、**いま塗られている色を手動色として残す**
// （増分 8E / G-15。FR-100）。
//
// FR-100 の対概念（教訓 2.10 / 5.5）: ON → OFF では、自動で決まっていた色を **捨てずに** 手動の
// 出発点として残す（既定色へ戻さない）。ドメインにはその規則が `manualColorsOnDisable` として
// 在ったが、**画面からは 1 度も呼ばれていなかった**（調査 08 の 20 番。結線漏れ）。
//
// 実際の振る舞いとしては、下書きの色は地物の色（＝地図に塗られている色）から作られ、自動配色
// ON の間は色の欄を触れないので、これまでも結果として同じ色が残っていたはずである
// （コードを読んでの判断。直す前の実機では確かめていない）。
// ここで **規則の在りかを 1 本にして明示的に通す**: OFF にした瞬間の色は、下書きの値ではなく
// **地物にいま塗られている色**（`manualColorsOnDisable(feature.color)`）から取る。下書きの色が
// 何かの理由で地図とずれていても、OFF にした結果は「いま見えている色」になる。
//
// `PropertyPanel.tsx` は触らない（本体で増分 7 の手直しが同じファイルを書き換えている）。
// 呼ぶのは「見た目」の欄を持つ `BasicInfoForm.tsx` の 1 か所である。

import { manualColorsOnDisable } from '../../domain/coloring';
import type { Feature } from '../../domain/feature';

import type { StyleValues } from './style-section';

/**
 * 「見た目」の欄が返した次の値を、自動配色の切り替えに合わせて整える。
 *
 * - **ON → OFF** のときだけ、色（通常表示色・選択表示色と、それぞれの透過）を地物にいま
 *   塗られている色で置き換える。パレットの選択は利用者が触った値をそのまま残す。
 * - それ以外（OFF → ON・色やパレットの変更）は何もしない。OFF → ON の色は確定のときに
 *   自動配色が決める（`recolor-binding`。同じ取り消し単位に入る）。
 */
export function styleOnAutoColorToggle(
  feature: Feature,
  current: StyleValues,
  next: StyleValues,
): StyleValues {
  if (!(current.autoColorEnabled && !next.autoColorEnabled)) return next;
  const kept = manualColorsOnDisable(feature.color);
  return {
    ...next,
    autoColorEnabled: kept.autoColorEnabled,
    fillColor: kept.fillColor,
    fillOpacity: kept.fillOpacity,
    selectedColor: kept.selectedColor,
    selectedOpacity: kept.selectedOpacity,
  };
}
