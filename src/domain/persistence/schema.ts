// U14 — persisted-manifest schema (Zod) and TS types derived from it.
//
// SINGLE declarative source (技術方針 2.10 / FR-103 / FR-116): the manifest's
// structural shape is written ONCE as a Zod schema; the persisted TS types are
// derived from it via `z.infer`, so validation logic and type are never written
// twice. The schema is the structural-validity boundary (構造的妥当性); the
// SEPARATE consistency layer (./consistency) is the domain-semantics boundary
// (ドメイン整合性) — the two are deliberately distinct stages (spec §整合性).
//
// DISCRIMINATED UNION ON `version` (FR-104): the top-level manifest is a
// discriminated union keyed by the literal `version` string. Today exactly one
// version (`SCHEMA_VERSION`) is supported, but the branch structure exists from
// the start so a future migration unit can add a branch without restructuring
// (spec §マイグレーションのスコープ外 — we DO build the discriminant, we do NOT
// write migration code).
//
// STRICTNESS (FR-116 / NFR 5.5): every object is `.strict()` so unknown keys are
// REJECTED. This makes the schema double as the sanitizer for external input —
// nothing the model did not declare can ride along into the domain. Optional
// fields use `.optional()` (key-absent allowed) to stay consistent with the
// domain's `exactOptionalPropertyTypes` "absent vs undefined" discipline; the
// serializer omits absent optionals rather than writing `undefined`.
//
// This module is PURE and framework-free (domain layer). It imports Zod only.

import { z } from 'zod';

import { getCalendar } from '../time/calendar';
import { timePointYear, timePointYearMonth, timePointYearMonthDay } from '../time/time-point';
import { MAX_YEAR, validate as validateTimePoint } from '../time/validate';

/**
 * The one schema version this build understands (FR-104). A manifest whose
 * `version` is not exactly this value is treated as INCOMPATIBLE by the parse
 * entry point (warned / rejected, never migrated — spec §やらないこと).
 */
export const SCHEMA_VERSION = 'tmap/1' as const;

// --- primitive leaf schemas -------------------------------------------------

/** A branded-id string at the persisted layer (plain non-empty string). */
const idSchema = z.string().min(1);

/** A finite number (rejects NaN / ±Infinity, which JSON cannot even carry). */
const finiteNumber = z.number().finite();

/**
 * A year is a plain integer (negative = BCE; matches domain `Year`), bounded in
 * magnitude to ±MAX_YEAR. The bound is the SAME one the domain `validate`
 * enforces (単一真実源, imported from the time module) and is the structural
 * defence against an unbounded persisted year: without it a crafted manifest
 * could carry a huge year (e.g. 1e20) that, once normalized to a day-count,
 * overflows Number.MAX_SAFE_INTEGER — collapsing distinct days to one value
 * (breaking compare/duration exactness) and turning the year-by-year
 * denormalize walk into an effectively-infinite hang. Every persisted year leaf
 * (anchor start/end via timePointSchema, attribute startYear/endYear, timeline
 * bounds) flows through this one schema, so the bound is enforced once.
 */
const yearSchema = z.number().int().min(-MAX_YEAR).max(MAX_YEAR);

// --- coordinate / vertex (FR-103 全頂点・共有頂点) ---------------------------

export const coordinateSchema = z
  .object({
    lon: finiteNumber,
    lat: finiteNumber,
  })
  .strict();

export const vertexSchema = z
  .object({
    id: idSchema,
    coordinate: coordinateSchema,
  })
  .strict();

// --- attributes / color (FR-97) ---------------------------------------------

export const basicAttributesSchema = z
  .object({
    name: z.string(),
    startYear: yearSchema,
    endYear: yearSchema,
  })
  .strict();

/** A透過度（アルファ）leaf: a finite number in [0,1] (U33 spec 行23-26 / AC1). */
const opacitySchema = z.number().min(0).max(1);

export const colorInfoSchema = z
  .object({
    autoColorEnabled: z.boolean(),
    fillColor: z.string(),
    // 通常表示色の透過度（アルファ）— part of the persisted style attribute (U33
    // spec 行23-26 / AC1). Optional (key-absent) so a manifest written before this
    // field existed still parses; the deserializer fills the default (DEFAULT_OPACITY).
    fillOpacity: opacitySchema.optional(),
    selectedColor: z.string(),
    // 選択表示色の透過度（アルファ）— part of the persisted style attribute (U33
    // spec 行23-26 / AC1). Optional + default-filled on restore, same as above.
    selectedOpacity: opacitySchema.optional(),
    borderColor: z.string(),
    // 使用パレット（テーマ名）— part of the persisted style attribute (FR-100 /
    // U33 AC1). Optional (key-absent) so a manifest written before this field
    // existed still parses; the deserializer fills the default theme (FR-109).
    paletteTheme: z.string().optional(),
  })
  .strict();

// --- rings (FR-20〜25: 領土リング / 穴リング, discriminated union) -----------
//
// `kind` is the discriminant. A hole ring REQUIRES a parentRingId (a hole is
// never outermost — mirrors the domain type); a territory ring's parent is
// optional (top-level vs enclave). The territory→hole alternation that the type
// cannot fully express is a CONSISTENCY check, not a schema concern.

export const territoryRingSchema = z
  .object({
    kind: z.literal('territory'),
    id: idSchema,
    vertexIds: z.array(idSchema),
    parentRingId: idSchema.optional(),
  })
  .strict();

export const holeRingSchema = z
  .object({
    kind: z.literal('hole'),
    id: idSchema,
    vertexIds: z.array(idSchema),
    parentRingId: idSchema,
  })
  .strict();

export const ringSchema = z.discriminatedUnion('kind', [
  territoryRingSchema,
  holeRingSchema,
]);

export const shapeSchema = z
  .object({
    rings: z.array(ringSchema),
  })
  .strict();

// --- features (FR-18/19/20/35: 点 / 線 / 末端 / 集約, discriminated union) ---
//
// 不正状態を表現不能に (技術方針 2.10): an aggregate has NO `shape` key (its area
// is the runtime union of children — FR-35); a leaf HAS a `shape`. `.strict()`
// means a `shape` accidentally placed on an aggregate is REJECTED, and a
// `childIds` on a leaf is REJECTED. kindLabel/parentId are optional (key-absent).

const featureCommon = {
  id: idSchema,
  attributes: basicAttributesSchema,
  color: colorInfoSchema,
  kindLabel: z.string().optional(),
  parentId: idSchema.optional(),
};

export const pointFeatureSchema = z
  .object({
    kind: z.literal('point'),
    ...featureCommon,
    vertexId: idSchema,
  })
  .strict();

export const lineFeatureSchema = z
  .object({
    kind: z.literal('line'),
    ...featureCommon,
    vertexIds: z.array(idSchema),
  })
  .strict();

export const leafFeatureSchema = z
  .object({
    kind: z.literal('leaf'),
    ...featureCommon,
    shape: shapeSchema,
  })
  .strict();

export const aggregateFeatureSchema = z
  .object({
    kind: z.literal('aggregate'),
    ...featureCommon,
    childIds: z.array(idSchema),
  })
  .strict();

export const featureSchema = z.discriminatedUnion('kind', [
  pointFeatureSchema,
  lineFeatureSchema,
  leafFeatureSchema,
  aggregateFeatureSchema,
]);

// --- time point (FR-54〜59: 歴史の錨 の開始/終了時刻) ------------------------
//
// Mirrors the domain TimePoint discriminated union on `granularity` so the
// "unspecified month/day" state is structural, never a stray undefined.

// The integer/strict structural shape. The semantic RANGE of month/day (1..12,
// 1..daysInMonth honouring leap years) is NOT expressible structurally without
// duplicating the calendar table, so it is enforced as a refinement that routes
// through the SAME domain `validate` the in-memory constructors use (単一真実源).
// This closes the load-time hole where an out-of-range persisted date (e.g.
// month 13, or month >= 14 which `daysInMonth` throws RangeError on) would either
// silently alias to a different day after normalize, or crash the loader.
const timePointStructuralSchema = z.discriminatedUnion('granularity', [
  z.object({ granularity: z.literal('year'), year: yearSchema }).strict(),
  z
    .object({ granularity: z.literal('yearMonth'), year: yearSchema, month: z.number().int() })
    .strict(),
  z
    .object({
      granularity: z.literal('yearMonthDay'),
      year: yearSchema,
      month: z.number().int(),
      day: z.number().int(),
    })
    .strict(),
]);

// Only the Gregorian calendar is persistable today (projectSettings.calendarId is
// the `gregorian` literal); range-validate against it. A future multi-calendar
// build would thread the manifest's calendar id in here.
const GREGORIAN_CALENDAR = getCalendar('gregorian');

export const timePointSchema = timePointStructuralSchema.superRefine((tp, ctx) => {
  const point =
    tp.granularity === 'year'
      ? timePointYear(tp.year)
      : tp.granularity === 'yearMonth'
        ? timePointYearMonth(tp.year, tp.month)
        : timePointYearMonthDay(tp.year, tp.month, tp.day);
  const result = validateTimePoint(point, GREGORIAN_CALENDAR);
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `time point out of range for calendar: ${result.error}`,
    });
  }
});

// --- anchor + anchor series (FR-54〜59: 各地物の歴史の錨) --------------------
//
// An anchor's snapshot is the full state at that anchor: the features at that
// time plus the vertex store they reference. The最上位フラグ・親子関係・種別ラベル
// (FR-103) live inside each feature (parentId / kindLabel) and are persisted as
// part of the feature objects; top-level is DERIVED (no parent), so no separate
// flag is stored — the schema cannot represent a contradictory "top-level AND
// has parent" state (FR-39).

export const anchorSnapshotSchema = z
  .object({
    features: z.array(featureSchema),
    vertices: z.array(vertexSchema),
  })
  .strict();

export const anchorSchema = z
  .object({
    id: idSchema,
    snapshot: anchorSnapshotSchema,
  })
  .strict();

export const anchorEntrySchema = z
  .object({
    anchor: anchorSchema,
    start: timePointSchema,
    // null = open-ended (mirrors the domain `TimePoint | null`); the key is
    // always present so the open-ended case is explicit, never an absent key.
    end: timePointSchema.nullable(),
  })
  .strict();

/**
 * A persisted feature-history is a NAMED series so the manifest can carry many
 * independent feature timelines. `featureId` ties the series to a stable feature
 * identity across anchors.
 */
export const featureHistorySchema = z
  .object({
    featureId: idSchema,
    entries: z.array(anchorEntrySchema),
  })
  .strict();

// --- settings (FR-109: プロジェクト固有設定 + FR-110: アプリ全体設定) -------

/** Geodesic params (FR-109: 赤道長・扁平率) — mirrors the U04 GeoParams. */
export const geoParamsSchema = z
  .object({
    equatorKm: finiteNumber,
    flattening: finiteNumber,
  })
  .strict();

/** Project-scoped settings (FR-109). */
export const projectSettingsSchema = z
  .object({
    calendarId: z.literal('gregorian'),
    geo: geoParamsSchema,
    gridSpacingDeg: finiteNumber,
    snapDistancePx: finiteNumber,
  })
  .strict();

/** App-wide settings (FR-110). */
export const appSettingsSchema = z
  .object({
    autoColorDefault: z.boolean(),
  })
  .strict();

export const settingsSchema = z
  .object({
    project: projectSettingsSchema,
    app: appSettingsSchema,
  })
  .strict();

// --- UI settings (FR-109 / FR-110: the FULL session-settings surface) --------
//
// The legacy `settings` block above carries only the narrow geodesy/grid/snap
// subset the early domain modelled. The actual user-facing settings panel (U38)
// owns a much richer PROJECT/APP settings surface (zoom limits, timeline bounds,
// grid color/opacity, area-label threshold, palette, project name/description …)
// that lives in the U16 store. Those were previously NOT persisted at all — a
// save dropped them and a load never restored them (二重真実源: store vs.
// domain.settings, never synced). This `ui` block is the persisted home for that
// full surface so a save round-trips it and a load hydrates the store from it.
//
// STRUCTURAL CONTRACT (技術方針 2.13 layering): the domain layer must not import
// the UI's `ProjectSettings` / `AppSettings` types. Instead this schema declares
// the persisted SHAPE structurally; the UI types are assignable to/from it by
// structural typing (the UI bridge passes the live store slice directly and
// hydrates it back). Keep these fields in lock-step with `ui/state/settings.ts`.
//
// BACK-COMPAT (FR-104 / .optional() discipline): the whole `ui` block is OPTIONAL
// so a manifest written before it existed still parses; on such a load the store
// keeps its defaults (the same as a brand-new project), which is the correct
// "no stored UI settings" behaviour.

const colorHexSchema = z.string();

export const uiProjectSettingsSchema = z
  .object({
    projectName: z.string(),
    projectDescription: z.string(),
    equatorLengthKm: finiteNumber,
    flattening: finiteNumber,
    timelineMinYear: yearSchema,
    timelineMaxYear: yearSchema,
    gridSpacingDeg: finiteNumber,
    gridColor: colorHexSchema,
    gridOpacity: finiteNumber,
    baseMapId: z.string(),
    areaLabelOccupancyThreshold: finiteNumber,
    newAreaAutoColorDefault: z.boolean(),
    defaultPaletteTheme: z.string(),
    customPalette: z.array(colorHexSchema),
    zoomMin: finiteNumber,
    zoomMax: finiteNumber,
  })
  .strict();

export const uiAppSettingsSchema = z
  .object({
    snapDistancePx: finiteNumber,
    renderFps: finiteNumber,
    vertexMarkerCap: finiteNumber,
    showConflictGuide: z.boolean(),
  })
  .strict();

export const uiSettingsSchema = z
  .object({
    project: uiProjectSettingsSchema,
    app: uiAppSettingsSchema,
  })
  .strict();

// --- base-map reference (FR-103 / FR-104: ベースマップ参照 + メタ) -----------
//
// The schema carries a REFERENCE (a relative path / id into the ZIP container)
// plus equirectangular meta (赤道長 lives in settings; here the world rectangle
// the image is pasted onto). Binary validation of the image bytes is out of
// scope (spec §やらないこと); we validate the reference + meta only.

export const equirectangularMetaSchema = z
  .object({
    lonWest: finiteNumber,
    lonEast: finiteNumber,
    latNorth: finiteNumber,
    latSouth: finiteNumber,
  })
  .strict();

export const baseMapReferenceSchema = z
  .object({
    /** Relative reference into the ZIP container, or the preset sentinel id. */
    source: z.string(),
    meta: equirectangularMetaSchema,
  })
  .strict();

// --- top-level manifest (discriminated union on `version`, FR-104) ----------

/** The body of a v1 manifest (everything except the version discriminant). */
const manifestV1Body = {
  histories: z.array(featureHistorySchema),
  settings: settingsSchema,
  baseMap: baseMapReferenceSchema,
  // The FULL UI session-settings surface (FR-109 / FR-110). Optional for
  // back-compat: a pre-`ui` manifest omits it and the store keeps its defaults.
  ui: uiSettingsSchema.optional(),
};

export const manifestV1Schema = z
  .object({
    version: z.literal(SCHEMA_VERSION),
    ...manifestV1Body,
  })
  .strict();

/**
 * The manifest schema as a discriminated union on `version`. Only one branch
 * exists today; the union is the seam a future migration unit extends. Using a
 * discriminated union (not a bare object) means a non-matching `version` fails
 * with a discriminant error the parse entry point turns into an incompatibility
 * result (FR-104) rather than a pile of field errors.
 */
export const manifestSchema = z.discriminatedUnion('version', [manifestV1Schema]);

// --- derived TS types (z.infer — NO second declaration, 技術方針 2.10) -------

export type PersistedCoordinate = z.infer<typeof coordinateSchema>;
export type PersistedVertex = z.infer<typeof vertexSchema>;
export type PersistedBasicAttributes = z.infer<typeof basicAttributesSchema>;
export type PersistedColorInfo = z.infer<typeof colorInfoSchema>;
export type PersistedRing = z.infer<typeof ringSchema>;
export type PersistedShape = z.infer<typeof shapeSchema>;
export type PersistedFeature = z.infer<typeof featureSchema>;
export type PersistedTimePoint = z.infer<typeof timePointSchema>;
export type PersistedAnchorSnapshot = z.infer<typeof anchorSnapshotSchema>;
export type PersistedAnchor = z.infer<typeof anchorSchema>;
export type PersistedAnchorEntry = z.infer<typeof anchorEntrySchema>;
export type PersistedFeatureHistory = z.infer<typeof featureHistorySchema>;
export type PersistedGeoParams = z.infer<typeof geoParamsSchema>;
export type PersistedProjectSettings = z.infer<typeof projectSettingsSchema>;
export type PersistedAppSettings = z.infer<typeof appSettingsSchema>;
export type PersistedSettings = z.infer<typeof settingsSchema>;
export type PersistedUiProjectSettings = z.infer<typeof uiProjectSettingsSchema>;
export type PersistedUiAppSettings = z.infer<typeof uiAppSettingsSchema>;
export type PersistedUiSettings = z.infer<typeof uiSettingsSchema>;
export type PersistedEquirectangularMeta = z.infer<typeof equirectangularMetaSchema>;
export type PersistedBaseMapReference = z.infer<typeof baseMapReferenceSchema>;
export type ManifestV1 = z.infer<typeof manifestV1Schema>;
export type Manifest = z.infer<typeof manifestSchema>;
