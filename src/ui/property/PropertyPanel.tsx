// UI layer (U32 / property panel): the sidebar property panel (FR-83 / FR-84 /
// FR-97 / FR-99前段 / FR-60).
//
// The main panel. It SUBSCRIBES to the session store (U16) for the raw selection
// (active feature id + the vertex set + its owner lookup) and the edit mode, then
// runs the SINGLE display judgment (selection-display.decideDisplay) over the raw
// IDs (教訓 5.10). From the resolved edit-target feature it shows基本情報
// (BasicInfoForm) and the anchor section (list / 時間バー). Selecting an anchor:
//   1. records it as the edit target (local UI state, the UI文脈, 教訓 5.4), and
//   2. syncs the session current time to the anchor's START via the SAME
//      setCurrentTime action every other time path uses (教訓 5.6 / 5.15) — this
//      unit creates NO independent time-write path.
// Saving uses the selected anchor's start time as the edit time (教訓 5.15).
//
// The panel holds NO map-draw state in React (技術方針 2.3); it reads the store.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { resolveAt, type AnchorEntry } from '../../domain/anchor-series';
import type { PaletteThemeId } from '../../domain/coloring';
import type { AnchorId, FeatureId } from '../../domain/ids';
import { ownerLookupFromMap, type VertexOwnerLookup } from '../../domain/selection';
import type { Calendar } from '../../domain/time/calendar';

import { EDIT_MODE } from '../state/session';
import type { SessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';

import { DELETE_TARGET_KIND } from '../../domain/deletion';

import { AnchorSection } from './AnchorSection';
import { BasicInfoForm } from './BasicInfoForm';
import { DeleteFeatureButton } from './DeleteFeatureButton';
import type {
  AnchorIntervalEditDispatch,
  AnchorIntervalEditIntent,
  AnchorSeriesLookup,
  EditDispatch,
  FeatureLookup,
  PropertyEditValues,
} from './contracts';
import { buildEditIntent } from './edit-intent';
import { PROPERTY_STRINGS } from './messages';
import {
  DISPLAY_KIND,
  decideDisplay,
  targetFeatureIdOf,
} from './selection-display';

export interface PropertyPanelProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly featureLookup: FeatureLookup;
  readonly anchorLookup: AnchorSeriesLookup;
  readonly editDispatch: EditDispatch;
  /**
   * HB3-12: the存続期間編集 dispatch (U09 changeStart / setEnd / deleteAnchor). When
   * wired AND the form is editable the anchor section shows a per-anchor存続期間 editor
   * (move 開始/終了, 継続中, この錨を削除); when omitted the section stays the read-only
   * view (honest-stub discipline — no dead control, 教訓 5.7).
   */
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  readonly calendar: Calendar;
  /**
   * Resolve the owner of a vertex (U22 / U03). Used to evaluate the RAW owner set
   * for the display judgment (教訓 5.10). Defaults to "no owner" so a host that
   * has not wired it shows the guidance cases rather than crashing.
   */
  readonly ownerLookup?: VertexOwnerLookup;
  /** Open a detail panel for the feature (FR-99後段). */
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  /** FR-85: delete the feature shown in the panel (the「地物を削除」button's confirm). */
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  /**
   * Palette themes for the U33「スタイル」section dropdown (from settings, FR-109).
   * Forwarded to the basic-info form's StyleSection. When omitted the form falls
   * back to the feature's own theme so the section still renders.
   */
  readonly paletteThemes?: readonly PaletteThemeId[];
  /**
   * FR-20 / FR-35: resolve a feature's 面積（km²）by id, computed by the HOST from
   * the LIVE domain + current time + FR-109 geoParams. Returns the km² area of the
   * feature's U08 derived shape — a 末端 (leaf) feature's own resolved shape OR an
   * 集約 (aggregate) feature's child-union (single truth source: the same
   * `resolveFeatureArea` the map draws through + the geodesy area kernel). Returns
   * `undefined` for a point / line (no area), for an unresolvable / childless shape,
   * or when the id is unknown — the panel then shows NO 面積 row (honest-stub, no
   * fabricated value).
   *
   * WHY A BY-ID PORT (not a resolved shape prop): the panel keys its resolved
   * feature to the target ID (教訓 5.2) so a structural edit (vertex add/delete)
   * that keeps the SAME id does not churn the form draft — but that also means the
   * memoized `feature` object does NOT change reference on such an edit, so an area
   * derived from it would go STALE. The host owns reactivity (it subscribes to the
   * committed domain / time / geoParams) and hands a FRESH resolver each render, so
   * the panel's area re-derives against the LIVE shape after every structural /
   * settings change (教訓 5.3, no stale cache) while the draft stays keyed to the id.
   */
  readonly resolveAreaKm2?: (featureId: FeatureId) => number | undefined;
}

export function PropertyPanel<S>(props: PropertyPanelProps<S>): JSX.Element {
  const {
    store,
    featureLookup,
    anchorLookup,
    editDispatch,
    anchorIntervalDispatch,
    calendar,
    onOpenDetail,
    onDeleteFeature,
  } = props;

  // Raw selection inputs (教訓 5.10): each is read from the store's mirror of
  // U22's truth. The display judgment evaluates these raw values directly.
  const activeFeatureId = useStore(store, (s) => s.selection.activeFeature);
  const vertexIds = useStore(store, (s) => s.selection.vertexIds);
  const mode = useStore(store, (s) => s.mode);
  const currentTime = useStore(store, (s) => s.currentTime);

  const ownerLookup = useMemo(
    () => props.ownerLookup ?? ownerLookupFromMap(new Map()),
    [props.ownerLookup],
  );

  const decision = useMemo(
    () => decideDisplay({ activeFeatureId, vertexIds, ownerLookup }),
    [activeFeatureId, vertexIds, ownerLookup],
  );

  const targetFeatureId = targetFeatureIdOf(decision);
  // Memoize the resolved feature/series by the target feature ID (教訓 5.2 /
  // 5.12). The display judgment can re-run with a NEW selection object that names
  // the SAME feature (e.g. a vertex-context target after setCurrentTime →
  // revalidateForTime rebuilds the vertex Set with a fresh reference, src/domain/
  // selection/reresolve.ts). Resolving inline would yield a NEW feature object on
  // every such render, churning BasicInfoForm's baseline and wiping an in-progress
  // draft / a held decision message. Keying to the ID keeps the reference stable
  // across selection-object churn that does not actually change the target.
  const feature = useMemo(
    () => (targetFeatureId !== null ? featureLookup.featureAt(targetFeatureId) : null),
    [featureLookup, targetFeatureId],
  );
  const series = useMemo(
    () => (targetFeatureId !== null ? anchorLookup.anchorSeriesOf(targetFeatureId) : null),
    [anchorLookup, targetFeatureId],
  );

  // FR-20 / FR-35: the DERIVED area (km²) of the target 面 feature — a 末端 (leaf)
  // feature's own resolved shape OR an 集約 (aggregate) feature's child-union. The
  // computation is the HOST's (it subscribes to the live domain / time / geoParams
  // and owns the single truth source `resolveFeatureArea` + geodesy area kernel);
  // this unit only asks by ID and displays the result (honest-stub — no fabricated
  // value; the row is absent when the port is unwired or returns `undefined`).
  //
  // KEYED TO THE TARGET ID, NOT the resolved `feature` OBJECT: the panel keeps the
  // `feature` reference stable across selection-object churn that names the same
  // target (see the memo above), so it does NOT change on a structural edit that
  // keeps the id — an area derived from it would stay STALE (bughunt review 穴1). We
  // instead re-run the host resolver, whose reference the host swaps each render for
  // the live domain / time / FR-109 settings, so the area re-derives after every
  // structural / settings change (教訓 5.3). A point / line, an unresolvable or
  // childless shape, or an unknown id yields `undefined` ⇒ BasicInfoForm shows no row.
  const { resolveAreaKm2 } = props;
  const areaKm2 = useMemo<number | undefined>(() => {
    if (targetFeatureId === null || resolveAreaKm2 === undefined) {
      return undefined;
    }
    return resolveAreaKm2(targetFeatureId);
  }, [targetFeatureId, resolveAreaKm2]);

  // The edit-target anchor is local UI文脈 (教訓 5.4). Keyed by feature so it is
  // discarded when the target feature changes (教訓 5.2).
  const [selectedAnchorId, setSelectedAnchorId] = useState<AnchorId | null>(null);
  const [anchorKey, setAnchorKey] = useState<FeatureId | null>(null);
  if (anchorKey !== targetFeatureId) {
    // Selection changed: reset the transient edit-target (教訓 5.2). Done during
    // render (no effect) so the first paint already reflects the reset.
    setAnchorKey(targetFeatureId);
    setSelectedAnchorId(null);
  }

  // The edit-target anchor: the user's EXPLICIT pick, else (HB3-14) the anchor in
  // EFFECT at the current time. The residual「属性編集の保存が必ず失敗」friction was the
  // save guard rejecting with「錨が選択されていません」when a feature was selected but no
  // anchor hand-picked — selecting a feature now defaults the edit target to the
  // current-time anchor so 名前変更→保存 works immediately. An explicit pick still wins,
  // and a time with NO effective anchor (before the feature exists / in an enclave)
  // still has no target. `resolveAt` is U(anchor-series)'s OWN §5.8 rule — the single
  // truth source, never re-implemented here (教訓 5.29).
  const effectiveAnchorId = useMemo<AnchorId | null>(() => {
    if (selectedAnchorId !== null) return selectedAnchorId;
    if (series === null) return null;
    const r = resolveAt(series, currentTime, calendar);
    return r.kind === 'present' ? r.entry.anchor.id : null;
  }, [selectedAnchorId, series, currentTime, calendar]);

  // The selected entry (for the edit time). The series is the single source.
  const selectedEntry = useMemo<AnchorEntry | null>(() => {
    if (series === null || effectiveAnchorId === null) return null;
    return series.entries.find((e) => e.anchor.id === effectiveAnchorId) ?? null;
  }, [series, effectiveAnchorId]);

  // 教訓 5.6 / 5.15: anchor selection syncs the session current time to the
  // anchor START via the SAME setCurrentTime action every time path uses. No
  // independent time-write path exists in this unit.
  const handleSelectAnchor = useCallback(
    (entry: AnchorEntry) => {
      setSelectedAnchorId(entry.anchor.id);
      store.getState().setCurrentTime(entry.start, TIME_CHANGE_SOURCE.AnchorSync);
    },
    [store],
  );

  // Save: the edit time is the selected anchor's start (教訓 5.15). The no-op
  // guard lives in BasicInfoForm; here we assemble + dispatch the intent.
  const handleSave = useCallback(
    (values: PropertyEditValues): string | null => {
      if (feature === null || selectedEntry === null) {
        return `${PROPERTY_STRINGS.saveFailedPrefix}編集対象が解決できません。`;
      }
      try {
        const intent = buildEditIntent(feature, selectedEntry.start, values);
        editDispatch.dispatchEdit(intent);
        return null;
      } catch (err) {
        return `${PROPERTY_STRINGS.saveFailedPrefix}${String(err)}`;
      }
    },
    [feature, selectedEntry, editDispatch],
  );

  // HB3-12: dispatch a存続期間編集 intent (changeStart / setEnd / deleteAnchor) through
  // the host's command bridge. The dispatch THROWS the domain's own rejection reason on
  // a refused op (sole-anchor delete, start≥end, …); we surface its message so the row
  // editor shows why, never a silent no-op (教訓 5.7 / 5.26). Returns null on success
  // (the swap re-resolves selection + the series re-renders from the live root).
  const handleEditInterval = useCallback(
    (intent: AnchorIntervalEditIntent): string | null => {
      if (anchorIntervalDispatch === undefined) return null;
      try {
        anchorIntervalDispatch.dispatchAnchorInterval(intent);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [anchorIntervalDispatch],
  );

  // The存続期間 editor is shown only when the host wired the dispatch AND the feature is
  // editable (whole-form gate, 教訓 5.13) — no dead control in view mode / pre-binding.
  const intervalEditable =
    anchorIntervalDispatch !== undefined &&
    decision.editable &&
    mode !== EDIT_MODE.View;

  return (
    <div className="property-panel" data-testid="property-panel">
      {feature === null ? (
        <GuidanceMessage decision={decision} />
      ) : (
        <>
          <div className="property-panel__actions">
            <button
              type="button"
              data-testid="open-detail-button"
              onClick={() => onOpenDetail?.(feature.id)}
            >
              {PROPERTY_STRINGS.openDetailButton}
            </button>
          </div>

          <BasicInfoForm
            feature={feature}
            editable={decision.editable && mode !== EDIT_MODE.View}
            editTime={selectedEntry !== null ? selectedEntry.start : null}
            {...(props.paletteThemes ? { paletteThemes: props.paletteThemes } : {})}
            {...(areaKm2 !== undefined ? { areaKm2 } : {})}
            onSave={(values) => handleSave(values)}
          />

          {series !== null && (
            <AnchorSection
              // Feature-scoped key so React REMOUNTS the section on a target
              // change, resetting its transient view-mode (List/TimeBar) state —
              // the reset the section's own doc comment promises via "keyed
              // remount upstream" (教訓 5.2: a selection change discards transient
              // UI state). Without it the chosen mode persisted (stale) across
              // feature switches.
              key={targetFeatureId ?? 'none'}
              series={series}
              calendar={calendar}
              selectedAnchorId={effectiveAnchorId}
              onSelectAnchor={handleSelectAnchor}
              {...(intervalEditable
                ? { featureId: feature.id, onEditInterval: handleEditInterval }
                : {})}
            />
          )}

          {/* FR-85: the always-present「地物を削除」button for the shown feature. Routes
              through the host's onDeleteFeature (= the SAME U31 delete the menu/Delete-key
              use). Only mounted when the host wired a handler (honest-stub discipline). */}
          {onDeleteFeature !== undefined && (
            <DeleteFeatureButton
              target={{ kind: DELETE_TARGET_KIND.ActiveFeature, featureId: feature.id }}
              onConfirm={onDeleteFeature}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The guidance message for a non-editable decision (FR-83). */
function GuidanceMessage(props: {
  readonly decision: ReturnType<typeof decideDisplay>;
}): JSX.Element {
  const { decision } = props;
  const message =
    decision.kind === DISPLAY_KIND.Empty ||
    decision.kind === DISPLAY_KIND.Multiple ||
    decision.kind === DISPLAY_KIND.Unknown
      ? decision.message
      : PROPERTY_STRINGS.featureMissing;
  return (
    <p className="property-panel__guidance" data-testid="property-guidance">
      {message}
    </p>
  );
}
