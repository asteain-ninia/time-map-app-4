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

import { MAX_COORDINATE_MAGNITUDE } from '../coordinate';
import { MAX_DETAIL_DOCUMENT_LENGTH } from '../feature';
import { getCalendar } from '../time/calendar';
import { timePointYear, timePointYearMonth, timePointYearMonthDay } from '../time/time-point';
import { MAX_YEAR, validate as validateTimePoint } from '../time/validate';
import {
  isValidEquatorKm,
  isValidFlattening,
  isValidGridSpacing,
  isValidRenderFps,
  isValidSnapDistancePx,
  isValidTimelineOrder,
  isValidUndoStackSize,
  isValidUnitFraction,
  isValidVertexMarkerCap,
  isValidZoomOrder,
  isWithinZoomBoundary,
} from './settings-constraints';

/**
 * The one schema version this build understands (FR-104). A manifest whose
 * `version` is not exactly this value is treated as INCOMPATIBLE by the parse
 * entry point (warned / rejected, never migrated — spec §やらないこと).
 *
 * 値が `tmap/1` のままである理由（保存ファイルの拡張子を `.gimoza` に改めた後も
 * 据え置く）: この文字列はユーザーに見えない**内部の識別子**であり、既存の保存
 * ファイルのマニフェスト先頭に literal として書き込まれている。ここを `gimoza/1`
 * 等に変えると、上記のとおり version が完全一致しない manifest は INCOMPATIBLE
 * として拒否される（マイグレーションは仕様上やらない）ため、既に保存済みの
 * ファイルが一律で読めなくなるだけで、得られるものが無い。よって「アプリ名は
 * gimoza・`tmap` は開発時のコードネーム」という改名は拡張子と表示上の名前に留め、
 * このスキーマ版文字列は意図的に変更しない。
 */
export const SCHEMA_VERSION = 'tmap/1' as const;

// --- primitive leaf schemas -------------------------------------------------

/** A branded-id string at the persisted layer (plain non-empty string). */
const idSchema = z.string().min(1);

/** A finite number (rejects NaN / ±Infinity, which JSON cannot even carry). */
const finiteNumber = z.number().finite();

/**
 * A coordinate scalar (degrees): finite AND bounded in magnitude.
 *
 * `.finite()` alone is NOT enough (单一真实源 with the domain construction seam):
 * a finite-but-astronomical scalar (e.g. lon = 1e302 in a crafted/corrupted
 * manifest) is not a representable map point and overflows the U06 quantization
 * grid to ±Infinity, which would later throw deep inside the boolean-op pipeline
 * (breaking the R2 "never throw" contract). The SAME bound the domain
 * `createCoordinate` enforces is restated here so a pathological coordinate is
 * rejected at the structural-validity boundary (a clean schema error on load)
 * rather than crashing deserialize or a later geometry op.
 */
const coordinateScalar = finiteNumber
  .min(-MAX_COORDINATE_MAGNITUDE)
  .max(MAX_COORDINATE_MAGNITUDE);

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
    lon: coordinateScalar,
    lat: coordinateScalar,
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
  .strict()
  // RING-ID UNIQUENESS (bug-hunt fix): a shape's rings are addressed by RingId —
  // resolveLeafShape buckets hole rings under their territory parent's id and a
  // ring's parentRingId references another ring's id. A duplicate RingId makes
  // that addressing ambiguous: two rings sharing an id mean a parentRingId no
  // longer names exactly one parent, and the indexById maps the structured ring
  // checks build collapse last-write-wins (the first ring's vertices/role are
  // silently dropped). Like the duplicate-vertex collapse, this destroys evidence
  // BEFORE any consistency check can see it, so a corrupt / hand-edited / legacy
  // shape would load as a valid-looking but wrong feature. Reject any duplicate
  // id at this structural boundary, reporting the path of the offending later
  // ring (教訓 5.26 拒否理由は path 付き).
  .superRefine((shape, ctx) => {
    const seen = new Set<string>();
    shape.rings.forEach((ring, index) => {
      if (seen.has(ring.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rings', index, 'id'],
          message: `duplicate ring id in shape: ${ring.id}`,
        });
      } else {
        seen.add(ring.id);
      }
    });
  });

// --- features (FR-18/19/20/35: 点 / 線 / 末端 / 集約, discriminated union) ---
//
// 不正状態を表現不能に (技術方針 2.10): an aggregate has NO `shape` key (its area
// is the runtime union of children — FR-35); a leaf HAS a `shape`. `.strict()`
// means a `shape` accidentally placed on an aggregate is REJECTED, and a
// `childIds` on a leaf is REJECTED. kindLabel/parentId/detailDocument are
// optional (key-absent).

// The maximum accepted length of a詳細文書 (FR-98) is DEFINED on the domain side
// (feature.ts, next to the field and its birth-time RangeError guard) and merely
// RESTATED here at the READ boundary — the same single-source pattern as
// MAX_COORDINATE_MAGNITUDE / MAX_YEAR above (persistence imports domain, never
// the reverse). Re-exported so persistence consumers (and the FR-98 editor via
// this barrel) share the ONE bound: WRITE(ドメイン誕生時 reject)⊆READ(schema
// max) can never drift apart.
export { MAX_DETAIL_DOCUMENT_LENGTH } from '../feature';

const featureCommon = {
  id: idSchema,
  attributes: basicAttributesSchema,
  color: colorInfoSchema,
  kindLabel: z.string().optional(),
  parentId: idSchema.optional(),
  // 詳細文書 (FR-98) — optional (key-absent) so every pre-document manifest still
  // parses (tmap/1 への optional 追記; alpha/palette/ui 追記と同型, version bump
  // なし). The serializer never writes the key for an absent document, and the
  // deserialize boundary collapses a legacy '' to absent (canonical empty form).
  detailDocument: z.string().max(MAX_DETAIL_DOCUMENT_LENGTH).optional(),
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
  .strict()
  // VERTEX-ID UNIQUENESS (bug-hunt fix): a snapshot's vertex store is a MAP keyed
  // by VertexId (createVertexStore does `byId.set(v.id, v)` in a loop), so two
  // array entries sharing an id but carrying DIFFERENT coordinates collapse
  // last-write-wins on load — the first vertex's coordinate is irreversibly
  // dropped before any consistency check runs. The MissingVertexReference check
  // cannot recover it: the surviving (last) vertex still satisfies every
  // reference, so a corrupt / legacy / hand-edited manifest loads silently with a
  // moved-or-dropped vertex and NO inconsistency reported. The store collapse is
  // the destruction of evidence; the only place to catch it is BEFORE load, at
  // this structural boundary. Reject any duplicate id, reporting the path of the
  // offending later entry (教訓 5.26 拒否理由は path 付き).
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    snapshot.vertices.forEach((vertex, index) => {
      if (seen.has(vertex.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vertices', index, 'id'],
          message: `duplicate vertex id in snapshot: ${vertex.id}`,
        });
      } else {
        seen.add(vertex.id);
      }
    });
  });

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
  .strict()
  // ANCHOR-ID UNIQUENESS within a series (bug-hunt fix, INV-6): the AnchorId is
  // the routing key for every by-id edit (U09 changeStart / setEnd / deleteAnchor
  // all locate the target via the FIRST entry matching the id). Two entries
  // sharing an id make those edits silently act on the earlier occurrence
  // regardless of which the user meant, and the later one is unreachable by id —
  // a corrupt / legacy / hand-edited manifest would load that ambiguity silently.
  // U09 normalizeSeries repairs it (keep-last) and validateSeries flags it, but a
  // file never re-normalized on load (deserializeHistory restores entries
  // verbatim) would slip through. Catch it at this structural boundary, reporting
  // the path of the offending later entry (教訓 5.26 拒否理由は path 付き).
  .superRefine((history, ctx) => {
    const seen = new Set<string>();
    history.entries.forEach((entry, index) => {
      const id = entry.anchor.id;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'anchor', 'id'],
          message: `duplicate anchor id in series: ${id}`,
        });
      } else {
        seen.add(id);
      }
    });
  });

// --- settings (FR-109: プロジェクト固有設定 + FR-110: アプリ全体設定) -------

/**
 * Geodesic params (FR-109: 赤道長・扁平率) — mirrors the U04 GeoParams.
 *
 * SEMANTIC range enforcement (bug-hunt fix): the structural shape validates
 * `equatorKm`/`flattening` only as bare finite numbers, which is NOT enough — a
 * degenerate `equatorKm <= 0` or `flattening >= 1` (or `< 0`) makes the U04
 * `kmPerLatDeg = equatorKm/360 * (1 - flattening)` collapse to 0 (or invert), so
 * EVERY area/distance silently returns 0 for the whole session. The richer `ui`
 * block already guards its own copy of these (uiProjectSettingsSchema.superRefine
 * below), but that block is `.optional()`: a manifest carrying a degenerate
 * `settings.project.geo` and no `ui` block passed straight through to
 * deserializeGeo → createGeoParams. The range RULES are single-sourced in
 * `./settings-constraints` (shared with the UI confirm path); we enforce the SAME
 * predicates here so the legacy geo path can never disagree with the UI form, each
 * failing field reported with its own `path` (教訓 5.26 拒否理由は path 付き).
 */
export const geoParamsSchema = z
  .object({
    equatorKm: finiteNumber,
    flattening: finiteNumber,
  })
  .strict()
  .superRefine((geo, ctx) => {
    if (!isValidEquatorKm(geo.equatorKm)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['equatorKm'],
        message: 'equator length must be a finite positive km value',
      });
    }
    if (!isValidFlattening(geo.flattening)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flattening'],
        message: 'flattening must be in [0, 1)',
      });
    }
  });

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

// SEMANTIC range/order enforcement (bug-hunt fix): the structural shape below
// validates each numeric field as a bare finite number, which is NOT enough — a
// crafted / corrupted manifest could load with timelineMinYear > timelineMaxYear,
// renderFps = 0, zoomMin > zoomMax, flattening ≥ 1 (degenerate geodesy),
// gridOpacity outside [0,1], snapDistance ≤ 0, etc. Those pass structural
// validation and the consistency layer does not cover settings, so they produce a
// "valid" project that breaks timeline derivation / rendering / area math. The
// range + order RULES are single-sourced in `./settings-constraints` (shared with
// the UI confirm path so the form and the file can never disagree) and enforced
// HERE via superRefine, at the load boundary. Each failing field gets its own
// `path` so the parse boundary reports it inline (教訓 5.26 拒否理由は path 付き).

export const uiProjectSettingsSchema = z
  .object({
    projectName: z.string(),
    projectDescription: z.string(),
    equatorLengthKm: finiteNumber,
    flattening: finiteNumber,
    timelineMinYear: yearSchema,
    timelineMaxYear: yearSchema,
    // FR-13 グリッド ON/OFF (受け入れ基準 9). Optional for BACK-COMPAT: a manifest
    // written before this field existed (a `ui` block without gridVisible — e.g. an
    // existing derle-world.gimoza) still parses, and the load bridge fills the default
    // true (欠落=可視) — the alpha/palette 追記と同型の optional 追記 (version bump なし).
    // z.boolean() fully validates the value; no superRefine needed.
    gridVisible: z.boolean().optional(),
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
  .strict()
  .superRefine((s, ctx) => {
    if (!isValidEquatorKm(s.equatorLengthKm)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['equatorLengthKm'],
        message: 'equator length must be a finite positive km value',
      });
    }
    if (!isValidFlattening(s.flattening)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flattening'],
        message: 'flattening must be in [0, 1)',
      });
    }
    if (!isValidTimelineOrder(s.timelineMinYear, s.timelineMaxYear)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timelineMinYear'],
        message: 'timeline min year must be strictly less than max year',
      });
    }
    if (!isValidGridSpacing(s.gridSpacingDeg)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gridSpacingDeg'],
        message: 'grid spacing must be one of the allowed spacings (5/10/15/30)',
      });
    }
    if (!isValidUnitFraction(s.gridOpacity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gridOpacity'],
        message: 'grid opacity must be in [0, 1]',
      });
    }
    if (!isValidUnitFraction(s.areaLabelOccupancyThreshold)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['areaLabelOccupancyThreshold'],
        message: 'area-label occupancy threshold must be in [0, 1]',
      });
    }
    if (!isWithinZoomBoundary(s.zoomMin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zoomMin'],
        message: 'zoomMin must be within [0.1, 10000]',
      });
    }
    if (!isWithinZoomBoundary(s.zoomMax)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zoomMax'],
        message: 'zoomMax must be within [0.1, 10000]',
      });
    }
    if (!isValidZoomOrder(s.zoomMin, s.zoomMax)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zoomMin'],
        message: 'zoomMin must be less than or equal to zoomMax',
      });
    }
  });

export const uiAppSettingsSchema = z
  .object({
    snapDistancePx: finiteNumber,
    renderFps: finiteNumber,
    vertexMarkerCap: finiteNumber,
    showConflictGuide: z.boolean(),
    undoStackSize: finiteNumber,
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!isValidSnapDistancePx(s.snapDistancePx)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapDistancePx'],
        message: 'snap distance must be a finite value >= 0',
      });
    }
    if (!isValidRenderFps(s.renderFps)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['renderFps'],
        message: 'render FPS must be in [1, 60]',
      });
    }
    if (!isValidVertexMarkerCap(s.vertexMarkerCap)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vertexMarkerCap'],
        message: 'vertex marker cap must be a non-negative integer',
      });
    }
    if (!isValidUndoStackSize(s.undoStackSize)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['undoStackSize'],
        message: 'undo stack size must be a positive integer',
      });
    }
  });

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
