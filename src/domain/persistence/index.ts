// U14 — persistence public barrel: schema (Zod) + derived types, the parse
// boundary (R8), serialize/deserialize round-trip, load-time consistency checks
// (FR-106), and the auto-repair framework. Domain layer: pure, framework-free.
//
// read (deserialize) / write (serialize) / validation (schema + consistency) and
// the round-trip are exported together so they move as ONE change unit (教訓5.31).

// --- schema + derived types (FR-103 / FR-104 / FR-116) ----------------------
export {
  SCHEMA_VERSION,
  coordinateSchema,
  vertexSchema,
  basicAttributesSchema,
  colorInfoSchema,
  territoryRingSchema,
  holeRingSchema,
  ringSchema,
  shapeSchema,
  pointFeatureSchema,
  lineFeatureSchema,
  leafFeatureSchema,
  aggregateFeatureSchema,
  featureSchema,
  timePointSchema,
  anchorSnapshotSchema,
  anchorSchema,
  anchorEntrySchema,
  featureHistorySchema,
  geoParamsSchema,
  projectSettingsSchema,
  appSettingsSchema,
  settingsSchema,
  equirectangularMetaSchema,
  baseMapReferenceSchema,
  manifestV1Schema,
  manifestSchema,
  type PersistedCoordinate,
  type PersistedVertex,
  type PersistedBasicAttributes,
  type PersistedColorInfo,
  type PersistedRing,
  type PersistedShape,
  type PersistedFeature,
  type PersistedTimePoint,
  type PersistedAnchorSnapshot,
  type PersistedAnchor,
  type PersistedAnchorEntry,
  type PersistedFeatureHistory,
  type PersistedGeoParams,
  type PersistedProjectSettings,
  type PersistedAppSettings,
  type PersistedSettings,
  type PersistedEquirectangularMeta,
  type PersistedBaseMapReference,
  type ManifestV1,
  type Manifest,
} from './schema';

// --- parse boundary (R8 / FR-104) -------------------------------------------
export {
  PARSE_OUTCOME,
  type ParseOutcomeKind,
  type ParseIssue,
  type ParseResult,
  MSG_VERSION_MISSING,
  MSG_VERSION_INCOMPATIBLE,
  MSG_INVALID,
  parseManifest,
  isParsed,
} from './boundary';

// --- serialize / round-trip (教訓5.20 / 5.31) -------------------------------
//
// `deserialize` is DELIBERATELY NOT re-exported here (受け入れ基準8 / R8). The
// deserializer trusts its argument is an already-validated `Manifest`; exposing
// it through the barrel would let an outside consumer write
// `import { deserialize } from '@/domain/persistence'` and smuggle unvalidated
// `unknown` into the domain WITHOUT passing the Zod parse boundary — a hole the
// `no-restricted-imports` rule could not see when the path is the barrel. The
// ONLY public entry for external input is `parseManifest` (the Zod boundary);
// `deserialize` stays persistence-internal (its round-trip test imports it from
// `./serialize` directly, which is exempt as a persistence-module file).
export {
  type ProjectSettings,
  type BaseMapReference,
  type FeatureHistory,
  type DomainProject,
  serialize,
  manifestToProject,
  projectsEqual,
} from './serialize';

// --- consistency checks (FR-106) --------------------------------------------
export {
  INCONSISTENCY,
  type InconsistencyKind,
  type Inconsistency,
  type ConsistencyReport,
  checkConsistency,
} from './consistency';

// --- auto-repair framework (FR-106) -----------------------------------------
export {
  REPAIR_OPTION,
  type RepairOptionId,
  type RepairOption,
  repairOptionsFor,
  applyRepair,
  type RepairApplication,
  applyRepairChecked,
} from './repair';
