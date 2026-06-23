// U14 schema + parse-boundary tests (受け入れ基準 1 / 3 / 8 partial).

import { describe, expect, it } from 'vitest';

import {
  PARSE_OUTCOME,
  SCHEMA_VERSION,
  isParsed,
  manifestSchema,
  parseManifest,
  serialize,
} from './index';
import { richValidProject } from './fixtures';

describe('schema — logical completeness (受け入れ基準1, FR-103)', () => {
  it('accepts a complete manifest covering every persisted element', () => {
    const manifest = serialize(richValidProject());
    const parsed = manifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });

  it('rejects a manifest missing a required top-level element', () => {
    const withoutSettings = serialize(richValidProject()) as Record<string, unknown>;
    delete withoutSettings['settings'];
    expect(manifestSchema.safeParse(withoutSettings).success).toBe(false);
  });

  it('rejects a feature missing a required field (vertex point without vertexId)', () => {
    const manifest = serialize(richValidProject());
    // Corrupt the point feature: drop its vertexId.
    const clone = structuredClone(manifest);
    const ptHistory = clone.histories.find((h) => h.featureId === 'pt-1');
    expect(ptHistory).toBeDefined();
    const feature = ptHistory!.entries[0]!.anchor.snapshot.features[0]! as Record<string, unknown>;
    delete feature['vertexId'];
    expect(manifestSchema.safeParse(clone).success).toBe(false);
  });

  it('rejects unknown keys (strict: sanitizes external input, FR-116)', () => {
    const manifest = serialize(richValidProject()) as Record<string, unknown>;
    const polluted = { ...manifest, injected: 'evil' };
    expect(manifestSchema.safeParse(polluted).success).toBe(false);
  });

  it('rejects an out-of-range persisted time point (month/day range, leap-aware)', () => {
    const manifest = serialize(richValidProject());
    // Corrupt an anchor entry's start to an out-of-range month (13) — structurally
    // an integer but semantically invalid. The schema must reject it so it never
    // aliases on normalize or crashes daysInMonth at load time.
    const clone = structuredClone(manifest) as unknown as {
      histories: { entries: { start: Record<string, unknown> }[] }[];
    };
    clone.histories[0]!.entries[0]!.start = { granularity: 'yearMonth', year: 2024, month: 13 };
    expect(manifestSchema.safeParse(clone).success).toBe(false);

    // A day beyond the month length (Feb 30) is likewise rejected.
    const clone2 = structuredClone(manifest) as unknown as {
      histories: { entries: { start: Record<string, unknown> }[] }[];
    };
    clone2.histories[0]!.entries[0]!.start = {
      granularity: 'yearMonthDay',
      year: 2023,
      month: 2,
      day: 30,
    };
    expect(manifestSchema.safeParse(clone2).success).toBe(false);

    // A month >= 14 (which would throw RangeError in daysInMonth) is rejected, not
    // crashed: the refinement runs validate() which range-checks the month first.
    const clone3 = structuredClone(manifest) as unknown as {
      histories: { entries: { start: Record<string, unknown> }[] }[];
    };
    clone3.histories[0]!.entries[0]!.start = {
      granularity: 'yearMonthDay',
      year: 2023,
      month: 14,
      day: 1,
    };
    expect(() => manifestSchema.safeParse(clone3)).not.toThrow();
    expect(manifestSchema.safeParse(clone3).success).toBe(false);
  });

  it('rejects an unbounded persisted year (precision-collapse / denormalize-hang defence)', () => {
    // Regression (bug-hunt): yearSchema was z.number().int() with NO magnitude
    // bound, so a crafted manifest could persist a huge year (e.g. 1e20) that
    // passes the schema. Once normalized to a day-count it overflows
    // Number.MAX_SAFE_INTEGER — distinct days in that year alias to the SAME
    // value (breaking compare/duration exactness) and the year-by-year
    // denormalize walk hangs (~1e20 iterations). The schema must reject it at
    // the load boundary BEFORE it ever reaches normalize/denormalize.
    const manifest = serialize(richValidProject());

    const hugeStart = structuredClone(manifest) as unknown as {
      histories: { entries: { start: Record<string, unknown> }[] }[];
    };
    hugeStart.histories[0]!.entries[0]!.start = { granularity: 'year', year: 1e20 };
    expect(() => manifestSchema.safeParse(hugeStart)).not.toThrow();
    expect(manifestSchema.safeParse(hugeStart).success).toBe(false);

    // The other persisted year leaves (attribute startYear/endYear, timeline
    // bounds) share yearSchema and are bounded too — a huge attribute year is
    // rejected rather than silently carried into later day-count arithmetic.
    const hugeAttr = structuredClone(manifest) as unknown as {
      histories: {
        entries: {
          anchor: { snapshot: { features: { attributes: Record<string, unknown> }[] } };
        }[];
      }[];
    };
    hugeAttr.histories[0]!.entries[0]!.anchor.snapshot.features[0]!.attributes['startYear'] = 1e20;
    expect(manifestSchema.safeParse(hugeAttr).success).toBe(false);
  });

  it('forbids representing an aggregate with a shape field (不正状態を表現不能)', () => {
    const manifest = serialize(richValidProject());
    const clone = structuredClone(manifest);
    const aggHistory = clone.histories.find((h) => h.featureId === 'agg-1')!;
    const agg = aggHistory.entries[0]!.anchor.snapshot.features.find(
      (f) => f.kind === 'aggregate',
    )! as Record<string, unknown>;
    agg['shape'] = { rings: [] };
    expect(manifestSchema.safeParse(clone).success).toBe(false);
  });

  it('rejects degenerate legacy geo params on settings.project.geo (silent area/distance zeroing defence)', () => {
    // Regression (bug-hunt2): geoParamsSchema validated equatorKm/flattening only as
    // bare finite numbers. The richer `ui` block guards its own copy, but `ui` is
    // OPTIONAL — a manifest carrying a degenerate `settings.project.geo` and NO `ui`
    // block passed parseManifest, reached deserializeGeo → createGeoParams, and made
    // kmPerLatDeg = equatorKm/360 * (1 - flattening) collapse to 0, silently zeroing
    // EVERY area/distance for the whole session. The schema must reject it at the
    // load boundary, reusing the same ./settings-constraints predicates as the UI.
    const manifest = serialize(richValidProject());

    // equatorKm = 0 (non-positive equator → kmPerLatDeg = 0).
    const zeroEquator = structuredClone(manifest);
    zeroEquator.settings.project.geo.equatorKm = 0;
    const zeroEquatorRes = manifestSchema.safeParse(zeroEquator);
    expect(zeroEquatorRes.success).toBe(false);
    if (!zeroEquatorRes.success) {
      // The rejection is reported with a path at the offending field (教訓 5.26).
      const hasEquatorPath = zeroEquatorRes.error.issues.some(
        (issue) => issue.path[issue.path.length - 1] === 'equatorKm',
      );
      expect(hasEquatorPath).toBe(true);
    }

    // flattening = 1 (degenerate geodesy → kmPerLatDeg = equatorKm/360 * 0 = 0).
    const degenerateFlattening = structuredClone(manifest);
    degenerateFlattening.settings.project.geo.flattening = 1;
    expect(manifestSchema.safeParse(degenerateFlattening).success).toBe(false);

    // flattening < 0 (inverted geodesy) is likewise rejected.
    const invertedFlattening = structuredClone(manifest);
    invertedFlattening.settings.project.geo.flattening = -0.1;
    expect(manifestSchema.safeParse(invertedFlattening).success).toBe(false);

    // A valid geo block (Earth-ish) still passes — the guard is range-only, not a
    // blanket reject of the legacy path.
    const validGeo = structuredClone(manifest);
    validGeo.settings.project.geo.equatorKm = 40000;
    validGeo.settings.project.geo.flattening = 0.0034;
    expect(manifestSchema.safeParse(validGeo).success).toBe(true);
  });

  it('rejects a snapshot with duplicate vertex ids (last-write-wins collapse defence)', () => {
    // Regression (bug-hunt): anchorSnapshotSchema validated `vertices` as a plain
    // array with NO uniqueness refinement. deserializeSnapshot feeds it to
    // createVertexStore, which does `byId.set(v.id, v)` in a loop — two entries
    // sharing an id but carrying DIFFERENT coordinates collapse last-write-wins,
    // irreversibly dropping the first vertex's coordinate BEFORE any consistency
    // check runs. The MissingVertexReference check cannot recover it (the surviving
    // vertex still satisfies every reference), so a corrupt/legacy/hand-edited
    // manifest loaded silently with a moved/dropped vertex and no inconsistency
    // reported. The schema must reject the duplicate at the load boundary.
    const manifest = serialize(richValidProject());
    const clone = structuredClone(manifest);

    // The aggregate's snapshot owns the two leaves' polygon vertices; pick its
    // first vertex and append a SECOND entry with the SAME id but a different
    // coordinate.
    const aggHistory = clone.histories.find((h) => h.featureId === 'agg-1')!;
    const snapshot = aggHistory.entries[0]!.anchor.snapshot;
    const original = snapshot.vertices[0]!;
    snapshot.vertices.push({
      id: original.id,
      coordinate: { lon: original.coordinate.lon + 1, lat: original.coordinate.lat + 1 },
    });

    const parsed = manifestSchema.safeParse(clone);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The rejection is reported with a path at the offending duplicate entry's
      // id (教訓 5.26 拒否理由は path 付き), not as an opaque whole-manifest error.
      const hasVertexIdPath = parsed.error.issues.some(
        (issue) =>
          issue.path.includes('vertices') &&
          issue.path[issue.path.length - 1] === 'id' &&
          issue.message.includes('duplicate vertex id'),
      );
      expect(hasVertexIdPath).toBe(true);
    }
  });
});

describe('ui settings — semantic range/order enforcement (bug-hunt regression)', () => {
  // Regression (bug-hunt): uiProjectSettingsSchema / uiAppSettingsSchema validated
  // every numeric setting as a bare finite number with NO range or ordering
  // refinement. A crafted / corrupted manifest could therefore load with
  // timelineMinYear > timelineMaxYear, renderFps = 0, zoomMin > zoomMax,
  // flattening ≥ 1 (degenerate geodesy), gridOpacity outside [0,1],
  // snapDistance < 0, etc. — values that pass structural validation (and the
  // consistency layer does not cover settings) yet break timeline derivation /
  // rendering / area math. The schema must reject them via superRefine at the load
  // boundary. The range/order RULES are single-sourced in ./settings-constraints
  // (shared with the UI confirm path).

  /** A fully-valid `ui` block (every numeric field inside its allowed range). */
  function validUi(): {
    project: Record<string, unknown>;
    app: Record<string, unknown>;
  } {
    return {
      project: {
        projectName: 'p',
        projectDescription: 'd',
        equatorLengthKm: 40000,
        flattening: 0.0034,
        timelineMinYear: -500,
        timelineMaxYear: 2000,
        gridSpacingDeg: 10,
        gridColor: '#abcdef',
        gridOpacity: 0.5,
        baseMapId: '@preset/equirectangular-world',
        areaLabelOccupancyThreshold: 0.3,
        newAreaAutoColorDefault: false,
        defaultPaletteTheme: 'default',
        customPalette: ['#112233'],
        zoomMin: 1,
        zoomMax: 50,
      },
      app: {
        snapDistancePx: 50,
        renderFps: 60,
        vertexMarkerCap: 500,
        showConflictGuide: true,
        undoStackSize: 100,
      },
    };
  }

  /** Build a manifest carrying a `ui` block produced by `mutate` over a valid one. */
  function manifestWithUi(
    mutate: (ui: ReturnType<typeof validUi>) => void,
  ): Record<string, unknown> {
    const manifest = serialize(richValidProject()) as Record<string, unknown>;
    const ui = validUi();
    mutate(ui);
    return { ...manifest, ui };
  }

  it('accepts a manifest whose ui block is fully in-range', () => {
    const manifest = manifestWithUi(() => {});
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects timelineMinYear >= timelineMaxYear (reversed / zero-width range)', () => {
    const reversed = manifestWithUi((ui) => {
      ui.project.timelineMinYear = 2000;
      ui.project.timelineMaxYear = 1000;
    });
    expect(manifestSchema.safeParse(reversed).success).toBe(false);

    const zeroWidth = manifestWithUi((ui) => {
      ui.project.timelineMinYear = 1500;
      ui.project.timelineMaxYear = 1500;
    });
    expect(manifestSchema.safeParse(zeroWidth).success).toBe(false);
  });

  it('rejects renderFps outside [1, 60] (0, negative, > 60)', () => {
    for (const fps of [0, -10, 61]) {
      const m = manifestWithUi((ui) => {
        ui.app.renderFps = fps;
      });
      expect(manifestSchema.safeParse(m).success).toBe(false);
    }
  });

  it('rejects zoomMin > zoomMax (reversed) and out-of-boundary zoom', () => {
    const reversed = manifestWithUi((ui) => {
      ui.project.zoomMin = 50;
      ui.project.zoomMax = 1;
    });
    expect(manifestSchema.safeParse(reversed).success).toBe(false);

    const tooSmall = manifestWithUi((ui) => {
      ui.project.zoomMin = 0.01; // below the 0.1 floor
    });
    expect(manifestSchema.safeParse(tooSmall).success).toBe(false);

    const tooLarge = manifestWithUi((ui) => {
      ui.project.zoomMax = 99999; // above the 10000 ceil
    });
    expect(manifestSchema.safeParse(tooLarge).success).toBe(false);
  });

  it('rejects flattening >= 1 or < 0 (degenerate / inverted geodesy)', () => {
    for (const f of [1, 1.5, -0.1]) {
      const m = manifestWithUi((ui) => {
        ui.project.flattening = f;
      });
      expect(manifestSchema.safeParse(m).success).toBe(false);
    }
  });

  it('rejects gridOpacity and occupancy threshold outside [0, 1]', () => {
    for (const v of [-0.1, 1.1]) {
      const opacity = manifestWithUi((ui) => {
        ui.project.gridOpacity = v;
      });
      expect(manifestSchema.safeParse(opacity).success).toBe(false);

      const occupancy = manifestWithUi((ui) => {
        ui.project.areaLabelOccupancyThreshold = v;
      });
      expect(manifestSchema.safeParse(occupancy).success).toBe(false);
    }
  });

  it('rejects non-positive equator length and off-list grid spacing', () => {
    const equator = manifestWithUi((ui) => {
      ui.project.equatorLengthKm = 0;
    });
    expect(manifestSchema.safeParse(equator).success).toBe(false);

    const spacing = manifestWithUi((ui) => {
      ui.project.gridSpacingDeg = 7; // not one of 5/10/15/30
    });
    expect(manifestSchema.safeParse(spacing).success).toBe(false);
  });

  it('rejects a negative snap distance and a non-integer / negative marker cap', () => {
    const snap = manifestWithUi((ui) => {
      ui.app.snapDistancePx = -5;
    });
    expect(manifestSchema.safeParse(snap).success).toBe(false);

    const fractionalCap = manifestWithUi((ui) => {
      ui.app.vertexMarkerCap = 12.5;
    });
    expect(manifestSchema.safeParse(fractionalCap).success).toBe(false);

    const negativeCap = manifestWithUi((ui) => {
      ui.app.vertexMarkerCap = -1;
    });
    expect(manifestSchema.safeParse(negativeCap).success).toBe(false);
  });

  it('reports the offending field path so the boundary can surface it (教訓5.26)', () => {
    const m = manifestWithUi((ui) => {
      ui.project.zoomMin = 50;
      ui.project.zoomMax = 1;
    });
    const result = parseManifest(m);
    expect(result.outcome).toBe(PARSE_OUTCOME.Invalid);
    if (result.outcome === PARSE_OUTCOME.Invalid) {
      const paths = result.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('zoomMin'))).toBe(true);
    }
  });
});

describe('parse boundary — version handling (受け入れ基準3, FR-104)', () => {
  it('parses a supported-version manifest into a typed value', () => {
    const manifest = serialize(richValidProject());
    const result = parseManifest(manifest);
    expect(result.outcome).toBe(PARSE_OUTCOME.Ok);
    expect(isParsed(result)).toBe(true);
  });

  it('reports an incompatible version with code AND 日本語 message (教訓5.26)', () => {
    const manifest = serialize(richValidProject()) as Record<string, unknown>;
    const future = { ...manifest, version: 'tmap/999' };
    const result = parseManifest(future);
    expect(result.outcome).toBe(PARSE_OUTCOME.VersionIncompatible);
    if (result.outcome === PARSE_OUTCOME.VersionIncompatible) {
      expect(result.foundVersion).toBe('tmap/999');
      expect(result.supportedVersion).toBe(SCHEMA_VERSION);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('reports a missing version (not an object / no version field)', () => {
    expect(parseManifest(null).outcome).toBe(PARSE_OUTCOME.VersionMissing);
    expect(parseManifest({}).outcome).toBe(PARSE_OUTCOME.VersionMissing);
    expect(parseManifest({ version: 42 }).outcome).toBe(PARSE_OUTCOME.VersionMissing);
  });

  it('reports a valid version but malformed body as Invalid with issues', () => {
    const manifest = serialize(richValidProject()) as Record<string, unknown>;
    const broken = { ...manifest, histories: 'not-an-array' };
    const result = parseManifest(broken);
    expect(result.outcome).toBe(PARSE_OUTCOME.Invalid);
    if (result.outcome === PARSE_OUTCOME.Invalid) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('does not let an incompatible-version payload reach the domain', () => {
    const result = parseManifest({ version: 'tmap/0', histories: [] });
    expect(isParsed(result)).toBe(false);
  });

  it('the manifest schema is a discriminated union on version', () => {
    // A discriminated union surfaces a discriminant error fast for a bad version.
    const res = manifestSchema.safeParse({ version: 'tmap/2' });
    expect(res.success).toBe(false);
  });
});
