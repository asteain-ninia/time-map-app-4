// U14 — serialize (domain state → plain manifest value) and deserialize
// (plain manifest value → domain state), with a guaranteed round-trip identity.
//
// 教訓5.20 / 5.31: persistence keeps PLAIN data; on restore we rebuild fresh
// domain instances recursively, and we NEVER re-mint ids — the stored id is
// restored as-is (the domain id factories `asXxxId` merely re-attach the brand
// to an already-valid string, with no runtime footprint). serialize and
// deserialize are mirror images and are kept in ONE change unit with the schema
// and the consistency checks (教訓5.31).
//
// Branding note: the persisted layer holds plain strings; the domain layer holds
// branded ids. deserialize re-attaches brands via the U03 `asXxxId` factories
// (the single auditable place ids are minted/rehydrated). serialize strips them
// via `idToString` (a no-op at runtime). No `as`-cast scatter.
//
// This is the domain-state shape this unit round-trips: a project is a set of
// per-feature anchor SERIES (U09) plus settings and a base-map reference. Each
// series' anchors hold full-state snapshots (features + vertex store, U03).
//
// Pure & framework-free.

import { createAnchor, createAnchorSnapshot, type Anchor } from '../anchor';
import {
  createAnchorEntry,
  type AnchorEntry,
  type AnchorSeries,
} from '../anchor-series';
import {
  basicAttributesEqual,
  colorInfoEqual,
  createBasicAttributes,
  createColorInfo,
  type BasicAttributes,
  type ColorInfo,
} from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../feature';
import { createGeoParams, type GeoParams } from '../geo/geo-params';
import {
  asAnchorId,
  asFeatureId,
  asRingId,
  asVertexId,
  idToString,
  type FeatureId,
} from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  type Ring,
  type Shape,
} from '../ring';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimePoint,
} from '../time/time-point';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import {
  SCHEMA_VERSION,
  type Manifest,
  type PersistedAnchor,
  type PersistedAnchorEntry,
  type PersistedAnchorSnapshot,
  type PersistedBaseMapReference,
  type PersistedBasicAttributes,
  type PersistedColorInfo,
  type PersistedCoordinate,
  type PersistedFeature,
  type PersistedFeatureHistory,
  type PersistedGeoParams,
  type PersistedRing,
  type PersistedSettings,
  type PersistedShape,
  type PersistedTimePoint,
  type PersistedUiSettings,
  type PersistedVertex,
} from './schema';

// --- the in-memory domain project this unit round-trips ---------------------

/** Settings as held in the domain (project + app scopes, FR-109 / FR-110). */
export interface ProjectSettings {
  readonly calendarId: 'gregorian';
  readonly geo: GeoParams;
  readonly gridSpacingDeg: number;
  readonly snapDistancePx: number;
  readonly autoColorDefault: boolean;
}

/**
 * The FULL UI session-settings surface as it round-trips through persistence
 * (FR-109 / FR-110). This is the plain, layering-safe SHAPE the domain persists;
 * the UI's `ProjectSettings` / `AppSettings` (ui/state/settings.ts) are assignable
 * to/from it by structural typing, so the UI bridge can write the live store slice
 * here on save and hydrate the store from it on load (二重真実源 を解消する単一の
 * 永続化先). Structurally identical to {@link PersistedUiSettings}; re-exported under
 * a domain name so callers depend on the domain layer, not the Zod inference.
 */
export type UiSettings = PersistedUiSettings;

/** Base-map reference (source path/id + equirectangular meta). */
export interface BaseMapReference {
  readonly source: string;
  readonly meta: {
    readonly lonWest: number;
    readonly lonEast: number;
    readonly latNorth: number;
    readonly latSouth: number;
  };
}

/** One feature's history: its stable id plus its anchor series (U09). */
export interface FeatureHistory {
  readonly featureId: FeatureId;
  readonly series: AnchorSeries;
}

/**
 * The complete in-memory domain project state this unit persists and restores.
 * It is the deserialize output and the serialize input — round-trip equality is
 * defined over this whole structure.
 */
export interface DomainProject {
  readonly histories: readonly FeatureHistory[];
  readonly settings: ProjectSettings;
  readonly baseMap: BaseMapReference;
  /**
   * The FULL UI session-settings surface (FR-109 / FR-110), when present. The U16
   * store is the live truth for these; on save the file-ops bridge copies the
   * store slice in here so `serialize` persists it, and on load it hydrates the
   * store from it. Optional: a project built without it (or loaded from a
   * pre-`ui` manifest) simply has the store keep its defaults — the same as a new
   * project. Carried as PLAIN data so the domain layer never imports UI types.
   */
  readonly uiSettings?: UiSettings;
}

// ============================================================================
// serialize: domain → plain manifest value
// ============================================================================

function serializeCoordinate(c: WorldCoordinate): PersistedCoordinate {
  return { lon: c.lon, lat: c.lat };
}

function serializeVertex(v: Vertex): PersistedVertex {
  return { id: idToString(v.id), coordinate: serializeCoordinate(v.coordinate) };
}

function serializeAttributes(a: BasicAttributes): PersistedBasicAttributes {
  return { name: a.name, startYear: a.startYear, endYear: a.endYear };
}

function serializeColor(c: ColorInfo): PersistedColorInfo {
  return {
    autoColorEnabled: c.autoColorEnabled,
    fillColor: c.fillColor,
    // Always written: the domain fields are always present (createColorInfo
    // defaults them), so persistence carries 透過度（アルファ）+ 使用パレット as
    // part of the anchor style state (FR-100 / U33 spec 行23-26 / AC1).
    fillOpacity: c.fillOpacity,
    selectedColor: c.selectedColor,
    selectedOpacity: c.selectedOpacity,
    borderColor: c.borderColor,
    paletteTheme: c.paletteTheme,
  };
}

function serializeRing(ring: Ring): PersistedRing {
  if (ring.kind === 'territory') {
    const base = {
      kind: 'territory' as const,
      id: idToString(ring.id),
      vertexIds: ring.vertexIds.map(idToString),
    };
    // exactOptionalPropertyTypes: only attach parentRingId when present.
    return ring.parentRingId === undefined
      ? base
      : { ...base, parentRingId: idToString(ring.parentRingId) };
  }
  return {
    kind: 'hole',
    id: idToString(ring.id),
    vertexIds: ring.vertexIds.map(idToString),
    parentRingId: idToString(ring.parentRingId),
  };
}

function serializeShape(shape: Shape): PersistedShape {
  return { rings: shape.rings.map(serializeRing) };
}

/** Serialize the common (kindLabel / parentId / detailDocument) optionals onto a plain object. */
function serializeCommon(feature: Feature): {
  id: string;
  attributes: PersistedBasicAttributes;
  color: PersistedColorInfo;
  kindLabel?: string;
  parentId?: string;
  detailDocument?: string;
} {
  // exactOptionalPropertyTypes: attach each optional key only when present — an
  // absent optional is OMITTED from the manifest, never written as `undefined`.
  const out: {
    id: string;
    attributes: PersistedBasicAttributes;
    color: PersistedColorInfo;
    kindLabel?: string;
    parentId?: string;
    detailDocument?: string;
  } = {
    id: idToString(feature.id),
    attributes: serializeAttributes(feature.attributes),
    color: serializeColor(feature.color),
  };
  if (feature.kindLabel !== undefined) out.kindLabel = feature.kindLabel;
  if (feature.parentId !== undefined) out.parentId = idToString(feature.parentId);
  // 詳細文書 (FR-98): written verbatim when present. The domain never carries ''
  // (constructors / withDetailDocument normalize it to absent), so serialize has
  // no normalization of its own — one canonical empty form everywhere.
  if (feature.detailDocument !== undefined) out.detailDocument = feature.detailDocument;
  return out;
}

function serializeFeature(feature: Feature): PersistedFeature {
  const common = serializeCommon(feature);
  switch (feature.kind) {
    case 'point':
      return { kind: 'point', ...common, vertexId: idToString(feature.vertexId) };
    case 'line':
      return { kind: 'line', ...common, vertexIds: feature.vertexIds.map(idToString) };
    case 'leaf':
      return { kind: 'leaf', ...common, shape: serializeShape(feature.shape) };
    case 'aggregate':
      return { kind: 'aggregate', ...common, childIds: feature.childIds.map(idToString) };
  }
}

function serializeTimePoint(tp: TimePoint): PersistedTimePoint {
  switch (tp.granularity) {
    case 'year':
      return { granularity: 'year', year: tp.year };
    case 'yearMonth':
      return { granularity: 'yearMonth', year: tp.year, month: tp.month };
    case 'yearMonthDay':
      return { granularity: 'yearMonthDay', year: tp.year, month: tp.month, day: tp.day };
  }
}

function serializeVertexStore(store: VertexStore): PersistedVertex[] {
  return [...store.byId.values()].map(serializeVertex);
}

function serializeSnapshot(snapshot: {
  readonly features: readonly Feature[];
  readonly vertices: VertexStore;
}): PersistedAnchorSnapshot {
  return {
    features: snapshot.features.map(serializeFeature),
    vertices: serializeVertexStore(snapshot.vertices),
  };
}

function serializeAnchor(anchor: Anchor): PersistedAnchor {
  return { id: idToString(anchor.id), snapshot: serializeSnapshot(anchor.snapshot) };
}

function serializeEntry(entry: AnchorEntry): PersistedAnchorEntry {
  return {
    anchor: serializeAnchor(entry.anchor),
    start: serializeTimePoint(entry.start),
    end: entry.end === null ? null : serializeTimePoint(entry.end),
  };
}

function serializeHistory(history: FeatureHistory): PersistedFeatureHistory {
  return {
    featureId: idToString(history.featureId),
    entries: history.series.entries.map(serializeEntry),
  };
}

function serializeGeo(geo: GeoParams): PersistedGeoParams {
  return { equatorKm: geo.equatorKm, flattening: geo.flattening };
}

function serializeSettings(settings: ProjectSettings): PersistedSettings {
  return {
    project: {
      calendarId: settings.calendarId,
      geo: serializeGeo(settings.geo),
      gridSpacingDeg: settings.gridSpacingDeg,
      snapDistancePx: settings.snapDistancePx,
    },
    app: {
      autoColorDefault: settings.autoColorDefault,
    },
  };
}

/**
 * Serialize the full UI settings surface to plain persisted data. It is already
 * plain data structurally; we rebuild fresh objects (and a fresh palette array)
 * so the manifest never aliases the live store value (教訓 5.20 新規インスタンス).
 */
function serializeUiSettings(ui: UiSettings): PersistedUiSettings {
  return {
    project: { ...ui.project, customPalette: [...ui.project.customPalette] },
    app: { ...ui.app },
  };
}

/** Deserialize the persisted UI settings into a fresh value (教訓 5.20). */
function deserializeUiSettings(ui: PersistedUiSettings): UiSettings {
  return {
    project: { ...ui.project, customPalette: [...ui.project.customPalette] },
    app: { ...ui.app },
  };
}

function serializeBaseMap(baseMap: BaseMapReference): PersistedBaseMapReference {
  return {
    source: baseMap.source,
    meta: {
      lonWest: baseMap.meta.lonWest,
      lonEast: baseMap.meta.lonEast,
      latNorth: baseMap.meta.latNorth,
      latSouth: baseMap.meta.latSouth,
    },
  };
}

/**
 * Serialize a complete domain project to a plain manifest value (FR-103). The
 * result is a JSON-safe object carrying the current `version`; it is exactly the
 * shape {@link Manifest} (and the schema) describes, so feeding it back through
 * the parse boundary validates and `deserialize` restores the original state.
 */
export function serialize(project: DomainProject): Manifest {
  const base = {
    version: SCHEMA_VERSION,
    histories: project.histories.map(serializeHistory),
    settings: serializeSettings(project.settings),
    baseMap: serializeBaseMap(project.baseMap),
  };
  // exactOptionalPropertyTypes: only attach `ui` when the project carries the
  // full UI settings, so a project without them serializes to a pre-`ui` manifest
  // (round-trips back to no uiSettings) rather than writing `ui: undefined`.
  return project.uiSettings === undefined
    ? base
    : { ...base, ui: serializeUiSettings(project.uiSettings) };
}

// ============================================================================
// deserialize: plain manifest value → domain (fresh instances, ids preserved)
// ============================================================================

function deserializeCoordinate(c: PersistedCoordinate): WorldCoordinate {
  return createCoordinate(c.lon, c.lat);
}

function deserializeVertex(v: PersistedVertex): Vertex {
  return createVertex(asVertexId(v.id), deserializeCoordinate(v.coordinate));
}

function deserializeAttributes(a: PersistedBasicAttributes): BasicAttributes {
  return createBasicAttributes(a.name, a.startYear, a.endYear);
}

function deserializeColor(c: PersistedColorInfo): ColorInfo {
  // paletteTheme / fillOpacity / selectedOpacity are optional in older manifests;
  // createColorInfo supplies their defaults (既定パレットテーマ FR-109 /
  // DEFAULT_OPACITY U33) when a key is absent, so an older project restores to the
  // same fully-opaque, default-themed look it had before these were persisted.
  // Passing `undefined` for an absent optional re-selects the factory default
  // (single source of the 既定値 rule, 教訓 5.30).
  return createColorInfo(
    c.autoColorEnabled,
    c.fillColor,
    c.selectedColor,
    c.borderColor,
    c.paletteTheme,
    c.fillOpacity,
    c.selectedOpacity,
  );
}

function deserializeRing(ring: PersistedRing): Ring {
  if (ring.kind === 'territory') {
    return createTerritoryRing(
      asRingId(ring.id),
      ring.vertexIds.map(asVertexId),
      ring.parentRingId === undefined ? undefined : asRingId(ring.parentRingId),
    );
  }
  return createHoleRing(
    asRingId(ring.id),
    ring.vertexIds.map(asVertexId),
    asRingId(ring.parentRingId),
  );
}

function deserializeShape(shape: PersistedShape): Shape {
  return createShape(shape.rings.map(deserializeRing));
}

/** Rebuild the optional (kindLabel / parentId / detailDocument) common fields for a feature. */
function deserializeOptional(feature: PersistedFeature): {
  kindLabel?: string;
  parentId?: FeatureId;
  detailDocument?: string;
} {
  const out: { kindLabel?: string; parentId?: FeatureId; detailDocument?: string } = {};
  if (feature.kindLabel !== undefined) out.kindLabel = feature.kindLabel;
  if (feature.parentId !== undefined) out.parentId = asFeatureId(feature.parentId);
  // 詳細文書 (FR-98): passed through to the domain constructors, whose shared
  // buildCommon normalizes a legacy/hand-crafted '' to ABSENT (canonical empty
  // form) — so a manifest carrying `detailDocument: ''` loads identically to one
  // without the key, and present-'' vs absent can never diverge in featuresEqual.
  if (feature.detailDocument !== undefined) out.detailDocument = feature.detailDocument;
  return out;
}

function deserializeFeature(feature: PersistedFeature): Feature {
  const id = asFeatureId(feature.id);
  const attributes = deserializeAttributes(feature.attributes);
  const color = deserializeColor(feature.color);
  const optional = deserializeOptional(feature);
  switch (feature.kind) {
    case 'point':
      return createPointFeature(id, attributes, color, asVertexId(feature.vertexId), optional);
    case 'line':
      return createLineFeature(id, attributes, color, feature.vertexIds.map(asVertexId), optional);
    case 'leaf':
      return createLeafFeature(id, attributes, color, deserializeShape(feature.shape), optional);
    case 'aggregate':
      return createAggregateFeature(
        id,
        attributes,
        color,
        feature.childIds.map(asFeatureId),
        optional,
      );
  }
}

function deserializeTimePoint(tp: PersistedTimePoint): TimePoint {
  switch (tp.granularity) {
    case 'year':
      return timePointYear(tp.year);
    case 'yearMonth':
      return timePointYearMonth(tp.year, tp.month);
    case 'yearMonthDay':
      return timePointYearMonthDay(tp.year, tp.month, tp.day);
  }
}

function deserializeSnapshot(snapshot: PersistedAnchorSnapshot): {
  features: Feature[];
  vertices: VertexStore;
} {
  return {
    features: snapshot.features.map(deserializeFeature),
    vertices: createVertexStore(snapshot.vertices.map(deserializeVertex)),
  };
}

function deserializeAnchor(anchor: PersistedAnchor): Anchor {
  const snap = deserializeSnapshot(anchor.snapshot);
  return createAnchor(asAnchorId(anchor.id), createAnchorSnapshot(snap.features, snap.vertices));
}

function deserializeEntry(entry: PersistedAnchorEntry): AnchorEntry {
  return createAnchorEntry(
    deserializeAnchor(entry.anchor),
    deserializeTimePoint(entry.start),
    entry.end === null ? null : deserializeTimePoint(entry.end),
  );
}

function deserializeHistory(history: PersistedFeatureHistory): FeatureHistory {
  // Restore the entries exactly as stored (ids preserved, 教訓5.20). We do NOT
  // re-normalize here: the series was valid when saved, and re-ordering on load
  // would let read & write disagree. Consistency / repair is the SEPARATE stage.
  return {
    featureId: asFeatureId(history.featureId),
    series: { entries: history.entries.map(deserializeEntry) },
  };
}

function deserializeGeo(geo: PersistedGeoParams): GeoParams {
  return createGeoParams(geo.equatorKm, geo.flattening);
}

function deserializeSettings(settings: PersistedSettings): ProjectSettings {
  return {
    calendarId: settings.project.calendarId,
    geo: deserializeGeo(settings.project.geo),
    gridSpacingDeg: settings.project.gridSpacingDeg,
    snapDistancePx: settings.project.snapDistancePx,
    autoColorDefault: settings.app.autoColorDefault,
  };
}

function deserializeBaseMap(baseMap: PersistedBaseMapReference): BaseMapReference {
  return {
    source: baseMap.source,
    meta: {
      lonWest: baseMap.meta.lonWest,
      lonEast: baseMap.meta.lonEast,
      latNorth: baseMap.meta.latNorth,
      latSouth: baseMap.meta.latSouth,
    },
  };
}

/**
 * Deserialize a validated manifest into a fresh domain project (教訓5.20: new
 * instances rebuilt recursively, stored ids restored, never re-minted). The
 * input MUST already have passed the parse boundary (it is a typed Manifest), so
 * this function never re-validates structure — that is the boundary's job.
 */
export function deserialize(manifest: Manifest): DomainProject {
  const base = {
    histories: manifest.histories.map(deserializeHistory),
    settings: deserializeSettings(manifest.settings),
    baseMap: deserializeBaseMap(manifest.baseMap),
  };
  // exactOptionalPropertyTypes: only attach uiSettings when the manifest carried
  // a `ui` block, so a pre-`ui` manifest restores to a project WITHOUT uiSettings
  // (the load path then leaves the store at its defaults).
  return manifest.ui === undefined
    ? base
    : { ...base, uiSettings: deserializeUiSettings(manifest.ui) };
}

/**
 * Public reconstruction entry: turn an ALREADY-VALIDATED {@link Manifest} (the
 * `parseManifest` Ok payload, or a U15 load result that main has Zod-validated)
 * into a fresh {@link DomainProject}. This is the sanctioned way for a UI bridge
 * to obtain the domain project from a load result WITHOUT importing the raw
 * `deserialize` (which the lint boundary forbids outside this module, R8): the
 * input here is a typed `Manifest`, so the Zod boundary has already run and this
 * is a pure reconstruction, not a re-validation hole. Identical behaviour to
 * {@link deserialize}; exposed under a name the boundary rule allows.
 */
export function manifestToProject(manifest: Manifest): DomainProject {
  return deserialize(manifest);
}

// ============================================================================
// round-trip equality (for tests / callers; structural value equality)
// ============================================================================

function timePointsEqual(a: TimePoint, b: TimePoint): boolean {
  if (a.granularity !== b.granularity) return false;
  if (a.year !== b.year) return false;
  if (a.granularity === 'year') return true;
  if (b.granularity === 'year') return false;
  if (a.month !== b.month) return false;
  if (a.granularity === 'yearMonth') return true;
  if (b.granularity === 'yearMonth') return false;
  return a.day === (b as { day: number }).day;
}

function endsEqual(a: TimePoint | null, b: TimePoint | null): boolean {
  if (a === null || b === null) return a === b;
  return timePointsEqual(a, b);
}

function ringsEqualById(a: Ring, b: Ring): boolean {
  if (a.kind !== b.kind) return false;
  if (a.id !== b.id) return false;
  if (a.vertexIds.length !== b.vertexIds.length) return false;
  for (let i = 0; i < a.vertexIds.length; i += 1) {
    if (a.vertexIds[i] !== b.vertexIds[i]) return false;
  }
  return a.parentRingId === b.parentRingId;
}

function shapesEqual(a: Shape, b: Shape): boolean {
  if (a.rings.length !== b.rings.length) return false;
  for (let i = 0; i < a.rings.length; i += 1) {
    const ra = a.rings[i];
    const rb = b.rings[i];
    if (ra === undefined || rb === undefined) return false;
    if (!ringsEqualById(ra, rb)) return false;
  }
  return true;
}

function idArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function featuresEqual(a: Feature, b: Feature): boolean {
  if (a.kind !== b.kind) return false;
  if (a.id !== b.id) return false;
  if (!basicAttributesEqual(a.attributes, b.attributes)) return false;
  if (!colorInfoEqual(a.color, b.color)) return false;
  if (a.kindLabel !== b.kindLabel) return false;
  if (a.parentId !== b.parentId) return false;
  // 詳細文書 (FR-98): without this the round-trip identity criterion (受け入れ
  // 基準7) would be blind to a dropped/altered document. '' never occurs (the
  // domain normalizes it to absent), so strict === is the whole rule.
  if (a.detailDocument !== b.detailDocument) return false;
  switch (a.kind) {
    case 'point':
      return a.vertexId === (b as typeof a).vertexId;
    case 'line':
      return idArraysEqual(a.vertexIds, (b as typeof a).vertexIds);
    case 'leaf':
      return shapesEqual(a.shape, (b as typeof a).shape);
    case 'aggregate':
      return idArraysEqual(a.childIds, (b as typeof a).childIds);
  }
}

function vertexStoresEqual(a: VertexStore, b: VertexStore): boolean {
  if (a.byId.size !== b.byId.size) return false;
  for (const [id, va] of a.byId) {
    const vb = b.byId.get(id);
    if (vb === undefined) return false;
    if (va.id !== vb.id) return false;
    if (va.coordinate.lon !== vb.coordinate.lon) return false;
    if (va.coordinate.lat !== vb.coordinate.lat) return false;
  }
  return true;
}

function snapshotsEqual(
  a: { features: readonly Feature[]; vertices: VertexStore },
  b: { features: readonly Feature[]; vertices: VertexStore },
): boolean {
  if (a.features.length !== b.features.length) return false;
  for (let i = 0; i < a.features.length; i += 1) {
    const fa = a.features[i];
    const fb = b.features[i];
    if (fa === undefined || fb === undefined) return false;
    if (!featuresEqual(fa, fb)) return false;
  }
  return vertexStoresEqual(a.vertices, b.vertices);
}

function entriesEqual(a: AnchorEntry, b: AnchorEntry): boolean {
  if (a.anchor.id !== b.anchor.id) return false;
  if (!timePointsEqual(a.start, b.start)) return false;
  if (!endsEqual(a.end, b.end)) return false;
  return snapshotsEqual(a.anchor.snapshot, b.anchor.snapshot);
}

function historiesEqual(a: FeatureHistory, b: FeatureHistory): boolean {
  if (a.featureId !== b.featureId) return false;
  if (a.series.entries.length !== b.series.entries.length) return false;
  for (let i = 0; i < a.series.entries.length; i += 1) {
    const ea = a.series.entries[i];
    const eb = b.series.entries[i];
    if (ea === undefined || eb === undefined) return false;
    if (!entriesEqual(ea, eb)) return false;
  }
  return true;
}

function settingsEqual(a: ProjectSettings, b: ProjectSettings): boolean {
  return (
    a.calendarId === b.calendarId &&
    a.geo.equatorKm === b.geo.equatorKm &&
    a.geo.flattening === b.geo.flattening &&
    a.gridSpacingDeg === b.gridSpacingDeg &&
    a.snapDistancePx === b.snapDistancePx &&
    a.autoColorDefault === b.autoColorDefault
  );
}

/** Structural equality of the full UI settings surface (present-or-absent aware). */
function uiSettingsEqual(a: UiSettings | undefined, b: UiSettings | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const pa = a.project;
  const pb = b.project;
  if (
    pa.projectName !== pb.projectName ||
    pa.projectDescription !== pb.projectDescription ||
    pa.equatorLengthKm !== pb.equatorLengthKm ||
    pa.flattening !== pb.flattening ||
    pa.timelineMinYear !== pb.timelineMinYear ||
    pa.timelineMaxYear !== pb.timelineMaxYear ||
    pa.gridSpacingDeg !== pb.gridSpacingDeg ||
    pa.gridColor !== pb.gridColor ||
    pa.gridOpacity !== pb.gridOpacity ||
    pa.baseMapId !== pb.baseMapId ||
    pa.areaLabelOccupancyThreshold !== pb.areaLabelOccupancyThreshold ||
    pa.newAreaAutoColorDefault !== pb.newAreaAutoColorDefault ||
    pa.defaultPaletteTheme !== pb.defaultPaletteTheme ||
    pa.zoomMin !== pb.zoomMin ||
    pa.zoomMax !== pb.zoomMax
  ) {
    return false;
  }
  if (pa.customPalette.length !== pb.customPalette.length) return false;
  for (let i = 0; i < pa.customPalette.length; i += 1) {
    if (pa.customPalette[i] !== pb.customPalette[i]) return false;
  }
  const aa = a.app;
  const ab = b.app;
  return (
    aa.snapDistancePx === ab.snapDistancePx &&
    aa.renderFps === ab.renderFps &&
    aa.vertexMarkerCap === ab.vertexMarkerCap &&
    aa.showConflictGuide === ab.showConflictGuide &&
    aa.undoStackSize === ab.undoStackSize
  );
}

function baseMapsEqual(a: BaseMapReference, b: BaseMapReference): boolean {
  return (
    a.source === b.source &&
    a.meta.lonWest === b.meta.lonWest &&
    a.meta.lonEast === b.meta.lonEast &&
    a.meta.latNorth === b.meta.latNorth &&
    a.meta.latSouth === b.meta.latSouth
  );
}

/**
 * Structural value-equality of two domain projects, used to assert the round
 * trip serialize→deserialize is the identity (教訓5.31 受け入れ基準7). Compares
 * every persisted element (ids, coordinates, attributes, color, shape rings,
 * anchor entries with start/end, settings, base-map ref).
 */
export function projectsEqual(a: DomainProject, b: DomainProject): boolean {
  if (a.histories.length !== b.histories.length) return false;
  for (let i = 0; i < a.histories.length; i += 1) {
    const ha = a.histories[i];
    const hb = b.histories[i];
    if (ha === undefined || hb === undefined) return false;
    if (!historiesEqual(ha, hb)) return false;
  }
  return (
    settingsEqual(a.settings, b.settings) &&
    baseMapsEqual(a.baseMap, b.baseMap) &&
    uiSettingsEqual(a.uiSettings, b.uiSettings)
  );
}
