// UI layer (U32 / property panel): the layer-crossing contracts this unit
// CONSUMES from its dependencies (教訓 5.33 / 5.34: fix cross-layer contracts
// in the type system, both sides test against them).
//
// This unit is a CONSUMER (spec §目的「参照する側」). It does NOT own any of the
// truth below — it owns only the React UI that displays/edits through these
// contracts:
//   - the feature truth + a feature's anchor series (錨ユニット U03/U09),
//   - the ZIP-internal asset relative-reference → display-source resolution
//     (永続化ユニット — spec §やらないこと),
//   - the object-reference link target → selection update (U22),
//   - the edit-command dispatch (U16 → command base).
//
// Each contract is a narrow port: the property unit calls it, the host wires the
// real implementation. Tests inject fakes so the UI is exercised against the
// fixed contract, not the real dependency (教訓 5.41).

import type { AnchorSeries } from '../../domain/anchor-series';
import type { Feature } from '../../domain/feature';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

/**
 * Looks a feature up by id from the domain truth (錨ユニット / domain). Returns
 * `null` when the id no longer resolves (a stale reference). The property panel
 * NEVER reaches into the domain root itself — it asks through this port so the
 * domain-truth shape stays owned by its unit (単一の真実源).
 */
export interface FeatureLookup {
  featureAt(featureId: FeatureId): Feature | null;
}

/**
 * Looks up the per-feature history-anchor series (U09). The property panel
 * DISPLAYS the series (FR-84); it never re-sorts / re-validates it — ordering,
 * non-overlap and state-continuation are U09's single implementation (spec
 * §やらないこと). `null` when the feature has no series resolvable.
 */
export interface AnchorSeriesLookup {
  anchorSeriesOf(featureId: FeatureId): AnchorSeries | null;
}

/**
 * Resolves a ZIP-internal asset RELATIVE reference (e.g. `images/x.png`) to a
 * display-usable source string (e.g. a blob/object URL), or `null` when it does
 * not resolve. The real implementation lives in the persistence unit (asset I/O
 * / ZIP read); this unit only USES the contract so it never fetches an external
 * URL (FR-02 offline完結, spec §やらないこと). A `null` result is rendered as a
 * SAFE broken image — it never falls back to the raw外部 href.
 */
export interface AssetResolver {
  resolveAsset(relativeReference: string): string | null;
}

/**
 * The edit-command dispatch port (U16 → command base). The property unit builds
 * the EDIT INTENT (which feature, which anchor's start time as the edit time,
 * which new values) and hands it off; command application + undo/redo history is
 * the command unit's responsibility (spec §やらないこと). The host wires the
 * real bridge; tests assert the intent that was dispatched.
 */
export interface EditDispatch {
  dispatchEdit(intent: PropertyEditIntent): void;
}

/**
 * The存続期間編集 dispatch port (HB3-12, 教訓 5.7 配線漏れ修正). DISTINCT from
 * {@link EditDispatch}: a property/style edit ({@link PropertyEditIntent}) rewrites the
 * anchor's full-state SNAPSHOT at a time (U44 applyEditProposal → applyPastEdit) and
 * NEVER touches an anchor's start/end interval. A feature's existence on the time axis
 * is governed by {@link AnchorSeries} entry start/end, which only U09 `changeStart` /
 * `setEnd` / `deleteAnchor` move. The property panel hands the existence-edit INTENT
 * (which feature, which anchor, the operation) to the command base; the host wires the
 * real bridge to those U09 ops (a whole-state-swap command recorded as ONE undo unit,
 * mirroring 全錨 delete) and tests assert the intent that was dispatched.
 */
export interface AnchorIntervalEditDispatch {
  dispatchAnchorInterval(intent: AnchorIntervalEditIntent): void;
}

/** The three存続期間 operations (FR-54〜FR-59, §5.6). A typed constant (教訓 5.19). */
export const ANCHOR_INTERVAL_OP = {
  /** Move when the feature appears (U09 changeStart). */
  ChangeStart: 'changeStart',
  /** Set / change / clear (`null`) when the feature disappears (U09 setEnd). */
  SetEnd: 'setEnd',
  /** Remove this anchor entirely (U09 deleteAnchor; refused for the sole anchor). */
  Delete: 'delete',
} as const;

export type AnchorIntervalOp =
  (typeof ANCHOR_INTERVAL_OP)[keyof typeof ANCHOR_INTERVAL_OP];

/**
 * The存続期間編集 intent (HB3-12). Names the target feature, the specific anchor
 * (by id — the routing key for every U09 by-id edit), and the operation. The command
 * base resolves the feature's {@link AnchorSeries}, runs the matching U09 op, and
 * records the result as one undo unit; a rejected op surfaces honestly (never silent).
 */
export type AnchorIntervalEditIntent =
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.ChangeStart;
      /** The new start time the anchor should appear at (U09 changeStart). */
      readonly newStart: TimePoint;
    }
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.SetEnd;
      /** The new end time, or `null` to clear it (open-ended). */
      readonly newEnd: TimePoint | null;
    }
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.Delete;
    };

/**
 * The 詳細文書 (FR-98) edit dispatch port — DISTINCT from {@link EditDispatch}: a
 * detail-document save rewrites ONLY the feature's optional `detailDocument` field
 * (withDetailDocument) at the edit-target anchor's start time, through the SAME
 * complete-state snapshot → U13 → ONE undo unit path an attribute edit takes
 * (propertyEditDispatch と同型). The panel assembles the intent; the host wires the
 * real bridge (live-detail-document.ts) and tests assert the dispatched intent.
 */
export interface DetailDocumentDispatch {
  dispatchDetailDocument(intent: DetailDocumentEditIntent): void;
}

/**
 * The 詳細文書 edit intent (FR-98). `detailDocument` is the RAW Markdown draft;
 * '' clears the document (the domain normalizes it to ABSENT — one canonical empty
 * form, feature.ts normalizeDetailDocument). The edit time is the edit-target
 * anchor's start (教訓 5.15 — the same editTime discipline PropertyEditIntent uses).
 */
export interface DetailDocumentEditIntent {
  readonly featureId: FeatureId;
  /** The edit time = the current edit-target anchor's start time (教訓 5.15). */
  readonly editTime: TimePoint;
  /** The raw Markdown detail document ('' ⇒ cleared / absent). */
  readonly detailDocument: string;
}

/**
 * The edit intent the property panel hands to the command base. It names the
 * target feature, the edit TIME (always the current edit-target anchor's start
 * time — context上の時刻, never system time, 教訓 5.15), and the new values.
 * The command unit decides how to apply it (FR-55 past-edit semantics).
 */
export interface PropertyEditIntent {
  readonly featureId: FeatureId;
  /** The edit time = the current edit-target anchor's start time (教訓 5.15). */
  readonly editTime: TimePoint;
  /** The new basic attributes + color values (FR-97). */
  readonly attributes: PropertyEditValues;
}

/** The editable基本情報 values (FR-97 / FR-100): basic attributes + color info +
 * 使用パレット. paletteTheme is part of the single anchor edit so a palette change
 * is one undo unit alongside the other style attributes (U33 AC1 / FR-59). */
export interface PropertyEditValues {
  readonly name: string;
  readonly startYear: number;
  readonly endYear: number;
  readonly autoColorEnabled: boolean;
  readonly fillColor: string;
  /** 通常表示色の透過度（アルファ, 0..1）— a persisted style attribute (U33 AC1・AC5). */
  readonly fillOpacity: number;
  readonly selectedColor: string;
  /** 選択表示色の透過度（アルファ, 0..1）— a persisted style attribute (U33 AC1・AC5). */
  readonly selectedOpacity: number;
  readonly borderColor: string;
  /** 使用パレット（テーマ名）— the style attribute (FR-100 / U33 AC1). */
  readonly paletteTheme: string;
}
