// UI layer (U32 / property panel): edit-intent assembly + no-op guard (FR-97 /
// FR-84, 教訓 5.24 / 5.15).
//
// The property panel does NOT apply edits — it assembles the INTENT (target
// feature, edit time, new values) and hands it to the command base (contracts.
// EditDispatch). Two rules are enforced here, purely and testably:
//   - 教訓 5.15: the edit TIME is **the CURRENT time**（地図が描いている時刻）,
//     never system time. The caller passes it in (already rounded to the year by
//     {@link decideEditPlan}); this module never reads a clock.
//     **増分 2 でここが変わった**: 以前は「選択中の錨の開始時刻」だったので、画面に
//     「1200年」と出ていても保存すると 0 年の錨が黙って書き換わった（設計書 §D.3 /
//     裁定 §N-2 の (A)。FR-57 must が FR-84 should の後半に優先する）。
//   - 教訓 5.24: a confirm whose values equal the baseline (the current feature
//     state) is a no-op — it must NOT be dispatched, so no ghost undo entry is
//     pushed. The baseline is derived from the SAME source the form syncs to
//     (the current feature), via {@link valuesFromFeature}.

import {
  basicAttributesEqual,
  colorInfoEqual,
  createBasicAttributes,
  createColorInfo,
} from '../../domain/attributes';
import type { Feature } from '../../domain/feature';
import type { TimePoint } from '../../domain/time/time-point';

import type { PropertyEditIntent, PropertyEditValues } from './contracts';

/**
 * 2 つの値が **すべての項目で** 等しいか。下書きを作り直すかどうかの判定に使う。
 *
 * 以前は「キーを並べ替えて連結した署名文字列」で比べていたが、詳細文書が値に加わって
 * 上限 10 万字の本文まで毎レンダー連結することになるので、項目ごとの比較に替えた
 * （意味は同じ・費用だけ下がる）。項目が増えたら型エラーになるよう、{@link
 * valuesFromFeature} と同じ形を明示的に並べる。
 */
export function propertyValuesEqual(a: PropertyEditValues, b: PropertyEditValues): boolean {
  return (
    a.name === b.name &&
    a.kindLabel === b.kindLabel &&
    a.detailDocument === b.detailDocument &&
    a.autoColorEnabled === b.autoColorEnabled &&
    a.fillColor === b.fillColor &&
    a.fillOpacity === b.fillOpacity &&
    a.selectedColor === b.selectedColor &&
    a.selectedOpacity === b.selectedOpacity &&
    a.borderColor === b.borderColor &&
    a.paletteTheme === b.paletteTheme
  );
}

/**
 * Project a feature's basic attributes + color into the editable form values
 * (FR-97). This is the SINGLE source both the form's initial sync and the no-op
 * baseline read from, so the baseline can never drift from what the form shows
 * (教訓 5.24).
 */
export function valuesFromFeature(feature: Feature): PropertyEditValues {
  return {
    name: feature.attributes.name,
    // 種別ラベル・詳細文書は「無い」を空文字で表す（ドメイン側では absent）。
    // 唯一の空の形にしておかないと、no-op 判定が undefined と '' で食い違う
    // （教訓 5.18: 空文字も値である）。
    kindLabel: feature.kindLabel ?? '',
    detailDocument: feature.detailDocument ?? '',
    autoColorEnabled: feature.color.autoColorEnabled,
    fillColor: feature.color.fillColor,
    fillOpacity: feature.color.fillOpacity,
    selectedColor: feature.color.selectedColor,
    selectedOpacity: feature.color.selectedOpacity,
    borderColor: feature.color.borderColor,
    paletteTheme: feature.color.paletteTheme,
  };
}

/**
 * True iff `next` equals the feature's current values (the no-op baseline). Uses
 * the domain value-equality helpers so the comparison matches the domain's own
 * notion of equality (教訓 5.24). Compared via real attribute/color objects so a
 * field-by-field drift cannot creep in.
 */
export function isNoOpEdit(feature: Feature, next: PropertyEditValues): boolean {
  // 種別ラベルと詳細文書も保存の対象なので、no-op 判定に必ず含める（設計書 §C.6）。
  // 片方だけ直したときに「何も起きない」ようでは、保存の対象を 4 つと宣言した意味が無い。
  if ((feature.kindLabel ?? '') !== next.kindLabel) return false;
  if ((feature.detailDocument ?? '') !== next.detailDocument) return false;
  // 飾りの開始年／終了年は保存の対象ではない（A7）ので、地物が持っている値をそのまま
  // 使う。ここで下書きの値を混ぜると「触っていない飾りの年」で no-op 判定が動く。
  const nextAttrs = createBasicAttributes(
    next.name,
    feature.attributes.startYear,
    feature.attributes.endYear,
  );
  const nextColor = createColorInfo(
    next.autoColorEnabled,
    next.fillColor,
    next.selectedColor,
    next.borderColor,
    next.paletteTheme,
    next.fillOpacity,
    next.selectedOpacity,
  );
  return (
    basicAttributesEqual(feature.attributes, nextAttrs) &&
    colorInfoEqual(feature.color, nextColor)
  );
}

/**
 * Assemble the edit intent for dispatch (教訓 5.15). `editTime` は **現在時刻を年へ
 * 丸めたもの**で、呼び出し側（{@link decideEditPlan}）が決める。時計は読まない。
 */
export function buildEditIntent(
  feature: Feature,
  editTime: TimePoint,
  values: PropertyEditValues,
): PropertyEditIntent {
  return {
    featureId: feature.id,
    editTime,
    attributes: values,
  };
}
