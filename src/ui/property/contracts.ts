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
import type { FeatureId } from '../../domain/ids';
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

/** The editable基本情報 values (FR-97): basic attributes + color info. */
export interface PropertyEditValues {
  readonly name: string;
  readonly startYear: number;
  readonly endYear: number;
  readonly autoColorEnabled: boolean;
  readonly fillColor: string;
  readonly selectedColor: string;
  readonly borderColor: string;
}
