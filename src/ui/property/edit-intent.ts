// UI layer (U32 / property panel): edit-intent assembly + no-op guard (FR-97 /
// FR-84, 教訓 5.24 / 5.15).
//
// The property panel does NOT apply edits — it assembles the INTENT (target
// feature, edit time, new values) and hands it to the command base (contracts.
// EditDispatch). Two rules are enforced here, purely and testably:
//   - 教訓 5.15: the edit TIME is the current edit-target anchor's START time
//     (context上の時刻), never system time. The caller passes the anchor start;
//     this module never reads a clock.
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
 * Project a feature's basic attributes + color into the editable form values
 * (FR-97). This is the SINGLE source both the form's initial sync and the no-op
 * baseline read from, so the baseline can never drift from what the form shows
 * (教訓 5.24).
 */
export function valuesFromFeature(feature: Feature): PropertyEditValues {
  return {
    name: feature.attributes.name,
    startYear: feature.attributes.startYear,
    endYear: feature.attributes.endYear,
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
  const nextAttrs = createBasicAttributes(next.name, next.startYear, next.endYear);
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
 * Assemble the edit intent for dispatch (教訓 5.15). `editTime` is the current
 * edit-target anchor's START time — passed in by the caller from the session's
 * current time (which the anchor selection synced), never sampled from a clock.
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
