// HB3-15(c) — merge (結合) / reparent (所属変更) target-highlight render-batch builder
// (FR-46〜FR-52 / FR-21, 教訓 5.2 / 5.18 / 5.29).
//
// Render layer: turns the pure tool selection (a set of chosen leaf shapes) into a
// declarative list of `DrawPrimitive`s for the MapRenderer (U17), mirroring the knife
// target emphasis (knife-batch.ts) but in a TOOL-SPECIFIC colour so the user can SEE
// which feature(s) the merge / reparent tool currently holds.
//
// WHY THIS FILE EXISTS (HB3-15(c) + HB3-16 tension): HB3-16 routes merge / reparent
// target picking through `leafAtPoint`, so an INDIVIDUAL leaf inside an aggregate can
// be chosen even though only the aggregate is DRAWN. Without a highlight the user would
// have no on-map feedback that an undrawn leaf was picked (描画されていないものが選ばれる,
// the regression the prior bughunt feared). This builder closes that: each picked
// target's resolved leaf shape (host resolves it via the SAME live-lookup `leafShapeAt`
// the knife emphasis uses, so what highlights == what is committed — 単一真実源) is drawn
// with an emphasis fill + thick screen-fixed outline. 穴は透過 / 飛び地は独立 fall out of
// the even-odd `shape` primitive (FR-21).
//
// REPARENT distinguishes the TARGET (the feature being moved) from the chosen NEW PARENT
// (the destination region) in two different colours so the two roles read apart on the
// map (FR-46〜FR-49). MERGE highlights EVERY toggled target uniformly (FR-50〜FR-52).
//
// 教訓 5.18: an empty selection yields a real, valid EMPTY frame (`[]`), never skipped by
// a falsy short-circuit. 教訓 5.2: when the session resets the next build naturally
// produces `[]`, so the highlight disappears on every exit path with no extra clearing
// code. The builder owns NO Canvas API and NO ±360° / world↔screen math — U17 transforms
// positions and wrap-replicates across the seam (FR-07).

import type { GeoMultiPolygon } from '../domain/geometry/types';

import type { DrawPrimitive, PolygonShapePrimitive } from './map-renderer';
import type { WorldPoint } from './vtransform';

// --- Style (the single place the highlight colours / sizes live; FR-17 screen-fixed) --

export interface TargetHighlightStyle {
  /** Selected-target emphasis fill (translucent so the base map reads through). */
  readonly fill: string;
  /** Selected-target emphasis outline (screen-fixed width). */
  readonly stroke: string;
  readonly strokeWidthPx: number;
}

/**
 * Default MERGE (結合) highlight: a teal/green emphasis distinct from the knife's amber
 * (#ffc107) and from the selection blue, so the merge tool reads as its OWN colour.
 */
export const DEFAULT_MERGE_TARGET_STYLE: TargetHighlightStyle = {
  fill: 'rgba(38, 166, 154, 0.32)',
  stroke: '#26a69a',
  strokeWidthPx: 2.5,
};

/**
 * Default REPARENT (所属変更) TARGET highlight (the feature being moved): a purple emphasis,
 * distinct from both the merge teal and the new-parent colour below.
 */
export const DEFAULT_REPARENT_TARGET_STYLE: TargetHighlightStyle = {
  fill: 'rgba(171, 71, 188, 0.32)',
  stroke: '#ab47bc',
  strokeWidthPx: 2.5,
};

/**
 * Default REPARENT (所属変更) NEW-PARENT highlight (the destination region): an orange
 * emphasis so the new上位領域 reads apart from the target being moved into it.
 */
export const DEFAULT_REPARENT_PARENT_STYLE: TargetHighlightStyle = {
  fill: 'rgba(255, 112, 67, 0.28)',
  stroke: '#ff7043',
  strokeWidthPx: 2.5,
};

function toWorldPoint(c: { readonly lon: number; readonly lat: number }): WorldPoint {
  return { lon: c.lon, lat: c.lat };
}

/**
 * One emphasis primitive: a resolved multipolygon shape drawn with the given style's fill
 * + thick outline (FR-21 even-odd). `undefined` / empty shape ⇒ no primitive (教訓 5.18 a
 * missing shape is a real "nothing to emphasize" state — e.g. a target id whose leaf is not
 * effective at the current time).
 */
function shapePrimitive(
  shape: GeoMultiPolygon | undefined,
  style: TargetHighlightStyle,
): DrawPrimitive | undefined {
  if (shape === undefined || shape.length === 0) return undefined;
  const pieces: PolygonShapePrimitive['pieces'] = shape.map((poly) =>
    poly.map((ring) => ring.map(toWorldPoint)),
  );
  return {
    kind: 'shape',
    pieces,
    fill: style.fill,
    stroke: style.stroke,
    strokeWidthPx: style.strokeWidthPx,
  };
}

// --- MERGE batch ------------------------------------------------------------

/** Inputs the merge highlight builder needs (host-resolved shapes; render→domain). */
export interface MergeHighlightInput {
  /**
   * The resolved geometry of EVERY toggled merge target, in selection order (host resolves
   * each via the live-lookup `leafShapeAt`). A `undefined` entry (a target whose leaf is
   * absent at the current time) contributes nothing (教訓 5.18). Empty ⇒ `[]`.
   */
  readonly targetShapes: readonly (GeoMultiPolygon | undefined)[];
}

/**
 * Build the merge target-highlight batch: one emphasis primitive per toggled target shape,
 * in selection order. An empty selection (or all-absent shapes) yields `[]` — a real, valid
 * empty frame (教訓 5.18) so the highlight vanishes on every reset path (教訓 5.2).
 */
export function buildMergeHighlight(
  input: MergeHighlightInput,
  style: TargetHighlightStyle = DEFAULT_MERGE_TARGET_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  for (const shape of input.targetShapes) {
    const prim = shapePrimitive(shape, style);
    if (prim !== undefined) out.push(prim);
  }
  return out;
}

// --- REPARENT batch ---------------------------------------------------------

/** Inputs the reparent highlight builder needs (host-resolved shapes; render→domain). */
export interface ReparentHighlightInput {
  /** The resolved geometry of the chosen TARGET leaf (the feature being moved). */
  readonly targetShape: GeoMultiPolygon | undefined;
  /** The resolved geometry of the chosen NEW-PARENT leaf (the destination region). */
  readonly newParentShape: GeoMultiPolygon | undefined;
}

/**
 * Build the reparent target-highlight batch: the TARGET emphasis (purple) then the
 * NEW-PARENT emphasis (orange), back-to-front, each in its own role colour so the two
 * read apart (FR-46〜FR-49). The new-parent draws AFTER (on top of) the target so a click
 * that picks the same body for both still shows the destination colour. An empty selection
 * yields `[]` (教訓 5.18 / 5.2).
 */
export function buildReparentHighlight(
  input: ReparentHighlightInput,
  targetStyle: TargetHighlightStyle = DEFAULT_REPARENT_TARGET_STYLE,
  parentStyle: TargetHighlightStyle = DEFAULT_REPARENT_PARENT_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const target = shapePrimitive(input.targetShape, targetStyle);
  if (target !== undefined) out.push(target);
  const parent = shapePrimitive(input.newParentShape, parentStyle);
  if (parent !== undefined) out.push(parent);
  return out;
}
