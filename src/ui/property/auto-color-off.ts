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
// ここで **規則の在りかを 1 本にして明示的に通す**: 保存済みの自動配色を **初めて** OFF に
// した瞬間の色は、下書きの値ではなく **地物にいま塗られている色**
// （`manualColorsOnDisable(feature.color)`）から取る。下書きの色が何かの理由で地図とずれて
// いても、OFF にした結果は「いま見えている色」になる。
//
// **切り替えの往復で手動色を失わない**（増分 8E の手直し。GPT 重 3）。最初の版は ON → OFF の
// たびに地物の保存済みの色で上書きしていたので、OFF の地物で手動色を打ち込み、ON → OFF と
// 往復すると打ち込んだ色と透過が消えていた（保存済みの自動配色の地物で、1 度 OFF にして色を
// 打ち、ON → OFF と戻した場合も同じ）。ON にしている間も下書きの色はそのまま残っている
// （ON の間は色の欄を触れない）ので、**下書きがすでに手動色を持っているときは何もしない**:
//   - 保存されている姿が OFF（手動色）: 下書きの色は保存済みの手動色か、利用者が打った色 → そのまま
//   - 保存されている姿が ON で、この下書きで 1 度 OFF にした: 下書きの色は手動色 → そのまま
//   - 保存されている姿が ON で、この下書きで初めて OFF にする: 地物にいま塗られている色を入れる
// 「この下書きで 1 度 OFF にしたか」は、宿主の部品が覚えておく（{@link useAutoColorToggle}）。
// 覚えは地物の色の記録（`feature.color` の参照）ごとで、保存や自動配色で地物の色が変われば
// 自然に忘れる（そのときは下書きも作り直される）。
//
// `PropertyPanel.tsx` は触らない（本体で増分 7 の手直しが同じファイルを書き換えている）。
// 呼ぶのは「見た目」の欄を持つ `BasicInfoForm.tsx` の 1 か所である。

import { useCallback, useRef } from 'react';

import { manualColorsOnDisable } from '../../domain/coloring';
import type { ColorInfo } from '../../domain/attributes';
import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';

import type { StyleValues } from './style-section';

/**
 * 「見た目」の欄が返した次の値を、自動配色の切り替えに合わせて整える。
 *
 * - **保存済みの自動配色を、この下書きで初めて OFF にした** ときだけ、色（通常表示色・
 *   選択表示色と、それぞれの透過）を地物にいま塗られている色で置き換える。パレットの選択は
 *   利用者が触った値をそのまま残す。
 * - 下書きがすでに手動色を持っている（保存済みが OFF・この下書きで 1 度 OFF にした）なら、
 *   ON → OFF でも何もしない（打ち込んだ色と透過を残す）。
 * - それ以外（OFF → ON・色やパレットの変更）は何もしない。OFF → ON の色は確定のときに
 *   自動配色が決める（`recolor-binding`。同じ取り消し単位に入る）。
 *
 * @param draftAlreadyManual この下書きで、すでに 1 度 OFF にしたか。
 */
export function styleOnAutoColorToggle(
  feature: Feature,
  current: StyleValues,
  next: StyleValues,
  draftAlreadyManual = false,
): StyleValues {
  if (!(current.autoColorEnabled && !next.autoColorEnabled)) return next;
  if (!feature.color.autoColorEnabled || draftAlreadyManual) return next;
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

/**
 * {@link styleOnAutoColorToggle} に「この下書きで 1 度 OFF にしたか」の覚えを添えて返す
 * 部品用の口。覚えは地物（id）とその色の記録（参照）の組ごとで、どちらかが変われば忘れる。
 */
export function useAutoColorToggle(
  feature: Feature,
): (current: StyleValues, next: StyleValues) => StyleValues {
  const wentManual = useRef<{ readonly id: FeatureId; readonly color: ColorInfo } | null>(null);
  return useCallback(
    (current: StyleValues, next: StyleValues): StyleValues => {
      const memo = wentManual.current;
      const already = memo !== null && memo.id === feature.id && memo.color === feature.color;
      const out = styleOnAutoColorToggle(feature, current, next, already);
      if (!out.autoColorEnabled) wentManual.current = { id: feature.id, color: feature.color };
      return out;
    },
    [feature],
  );
}
