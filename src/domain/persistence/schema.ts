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

/** A year is a plain integer (negative = BCE; matches domain `Year`). */
const yearSchema = z.number().int();

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

export const colorInfoSchema = z
  .object({
    autoColorEnabled: z.boolean(),
    fillColor: z.string(),
    selectedColor: z.string(),
    borderColor: z.string(),
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

export const timePointSchema = z.discriminatedUnion('granularity', [
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
export type PersistedEquirectangularMeta = z.infer<typeof equirectangularMetaSchema>;
export type PersistedBaseMapReference = z.infer<typeof baseMapReferenceSchema>;
export type ManifestV1 = z.infer<typeof manifestV1Schema>;
export type Manifest = z.infer<typeof manifestSchema>;
