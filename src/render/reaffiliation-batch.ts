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

/**
 * **対象色**（`markedFeatures` の複数対象。増分 7 / 設計書 §D.5・§O の GPT）。
 *
 * **選択色とは別の色である。** 選択（`activeFeature`）は 0 か 1 件（FR-79）で、地物の
 * 塗りを `selectedColor` へ差し替えることで表す。印は 2 件以上になりうる集合で、
 * 「まとめて直す相手」を意味するので、**外周を太らせる 1 種類の描画命令**で重ねる。
 * 現状の選択描画は 0〜1 件しか表せず、V8 の「3 件が同時に対象色」はこれが無いと
 * 成立しない（結合点 #4）。
 *
 * 色は結合の青緑・所属の紫・新しい上位のオレンジ・ナイフの琥珀のどれとも重ならない
 * **黄（琥珀より緑寄り）**にしてある ―― 道具の対象と、道具に依らない印を、同じ画面で
 * 見分けられるようにするためである。
 */
export const DEFAULT_MARKED_TARGET_STYLE: TargetHighlightStyle = {
  fill: 'rgba(255, 214, 0, 0.22)',
  stroke: '#ffd600',
  strokeWidthPx: 3,
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
  /**
   * 動かす地物すべての形（反証 2-2: 旧版は 1 件しか塗っていなかった）。単数の
   * `targetShape` も受け付ける（既存の呼び出しと検査のため）。
   */
  readonly targetShapes?: readonly (GeoMultiPolygon | undefined)[];
  /** The resolved geometry of the chosen TARGET leaf (the feature being moved). */
  readonly targetShape?: GeoMultiPolygon | undefined;
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
// --- MARKED batch（対象色。増分 7 / 設計書 §D.5）------------------------------

/** 印を付けた地物の形（ホストが live-lookup で解いて渡す）。 */
export interface MarkedHighlightInput {
  /**
   * 面の形。**まとめ役もここへ入る** ―― まとめ役は自分の形を持たないので、ホストは
   * 下位領域の和（`resolveFeatureArea`）を解いて渡す（反証 1-2: まとめ役に印を付けても
   * 地図に何も出なかった）。
   */
  readonly markedShapes: readonly (GeoMultiPolygon | undefined)[];
  /** 点情報の位置（反証 1-2: 点・線は自分の描画で出す）。 */
  readonly markedPoints?: readonly (WorldPoint | undefined)[];
  /** 線情報の折れ線（2 点以上）。 */
  readonly markedLines?: readonly (readonly WorldPoint[] | undefined)[];
}

/**
 * 印を付けた地物の強調を組み立てる（**1 種類の描画命令だけ**。設計書 §D.5 / §J.4 の #4）。
 *
 * 全部を同じ「対象色」で描く ―― 印は役割の区別を持たない集合なので、色を分ける理由が
 * 無い（所属変更の「移す側」と「行き先」のような役割の別は道具の側が持つ）。
 * 空集合は `[]` を返し、印を全部外した瞬間に消える（教訓 5.18 / 5.2）。
 */
export function buildMarkedHighlight(
  input: MarkedHighlightInput,
  style: TargetHighlightStyle = DEFAULT_MARKED_TARGET_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  for (const shape of input.markedShapes) {
    const prim = shapePrimitive(shape, style);
    if (prim !== undefined) out.push(prim);
  }
  // 点・線は面と同じ塗りでは出せないので、自分の描画で出す（反証 1-2）。色は同じ
  // 「対象色」1 種類のままである（役割の別を持たない集合なので色を分けない）。
  for (const at of input.markedPoints ?? []) {
    if (at === undefined) continue;
    out.push({ kind: 'point', at, radiusPx: MARKED_POINT_RADIUS_PX, fill: style.stroke });
  }
  for (const points of input.markedLines ?? []) {
    if (points === undefined || points.length < 2) continue;
    out.push({ kind: 'line', points, widthPx: style.strokeWidthPx, stroke: style.stroke });
  }
  return out;
}

/** 印を付けた点情報の丸の半径（画素）。錨の印より大きく、掴み手より小さい。 */
const MARKED_POINT_RADIUS_PX = 7;

export function buildReparentHighlight(
  input: ReparentHighlightInput,
  targetStyle: TargetHighlightStyle = DEFAULT_REPARENT_TARGET_STYLE,
  parentStyle: TargetHighlightStyle = DEFAULT_REPARENT_PARENT_STYLE,
): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const targets: readonly (GeoMultiPolygon | undefined)[] =
    input.targetShapes ?? (input.targetShape === undefined ? [] : [input.targetShape]);
  for (const shape of targets) {
    const target = shapePrimitive(shape, targetStyle);
    if (target !== undefined) out.push(target);
  }
  const parent = shapePrimitive(input.newParentShape, parentStyle);
  if (parent !== undefined) out.push(parent);
  return out;
}
