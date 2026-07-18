// U14 serialize→deserialize round-trip tests (受け入れ基準7, 教訓5.31).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseManifest,
  projectsEqual,
  serialize,
  PARSE_OUTCOME,
} from './index';
// deserialize is persistence-internal (not re-exported from the barrel, 受け入れ
// 基準8 / R8); the round-trip test reaches it from ./serialize directly, which is
// exempt from the boundary lint rule as a persistence-module file.
import { deserialize, type DomainProject, type UiSettings } from './serialize';
import { FIXTURE_DETAIL_DOCUMENT, projectArb, richValidProject } from './fixtures';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, type Feature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';

/** Every feature of every anchor snapshot in a restored project (flattened). */
function allFeatures(project: ReturnType<typeof deserialize>): Feature[] {
  return project.histories.flatMap((h) =>
    h.series.entries.flatMap((e) => [...e.anchor.snapshot.features]),
  );
}

describe('round-trip serialize→deserialize (受け入れ基準7)', () => {
  it('is the identity for a rich project (every persisted element)', () => {
    const project = richValidProject();
    const restored = deserialize(serialize(project));
    expect(projectsEqual(project, restored)).toBe(true);
  });

  it('preserves stored ids — never re-mints them (教訓5.20)', () => {
    const project = richValidProject();
    const manifest = serialize(project);
    const restored = deserialize(manifest);
    // The aggregate id, child ids, anchor ids survive verbatim.
    const aggHistory = restored.histories.find((h) => h.featureId === 'agg-1');
    expect(aggHistory).toBeDefined();
    const anchorIds = aggHistory!.series.entries.map((e) => e.anchor.id);
    expect(anchorIds).toContain('agg-1-anc-0');
    expect(anchorIds).toContain('agg-1-anc-1');
  });

  it('round-trips through the JSON boundary (plain data, 教訓5.20)', () => {
    const project = richValidProject();
    const manifest = serialize(project);
    const json = JSON.parse(JSON.stringify(manifest));
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      expect(projectsEqual(project, restored)).toBe(true);
    }
  });

  it('serialize emits the current schema version', () => {
    expect(serialize(richValidProject()).version).toBe('tmap/1');
  });

  it('persists 透過度（アルファ）verbatim through the JSON boundary (U33 AC1・AC5)', () => {
    const manifest = serialize(richValidProject());
    const json = JSON.parse(JSON.stringify(manifest));
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      // The rich fixture colors carry non-default opacities (0.5 / 0.75); they must
      // survive the round trip, never be reset to fully-opaque.
      const someFeature = restored.histories[0]!.series.entries[0]!.anchor.snapshot.features[0]!;
      expect(someFeature.color.fillOpacity).toBe(0.5);
      expect(someFeature.color.selectedOpacity).toBe(0.75);
    }
  });

  it('restores a pre-alpha manifest (opacity keys absent) to fully opaque (後方互換 + 既定値)', () => {
    const manifest = serialize(richValidProject());
    const json = JSON.parse(JSON.stringify(manifest)) as {
      histories: { entries: { anchor: { snapshot: { features: { color: Record<string, unknown> }[] } } }[] }[];
    };
    // Simulate an older manifest: strip every opacity key from every color.
    for (const h of json.histories)
      for (const e of h.entries)
        for (const f of e.anchor.snapshot.features) {
          delete f.color['fillOpacity'];
          delete f.color['selectedOpacity'];
        }
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      const someFeature = restored.histories[0]!.series.entries[0]!.anchor.snapshot.features[0]!;
      expect(someFeature.color.fillOpacity).toBe(1);
      expect(someFeature.color.selectedOpacity).toBe(1);
    }
  });

  it('persists 詳細文書 (FR-98) verbatim through the JSON boundary', () => {
    const manifest = serialize(richValidProject());
    const json = JSON.parse(JSON.stringify(manifest));
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      // The rich fixture's point feature carries a non-empty document; it must
      // survive the round trip verbatim, never be dropped or blanked.
      const pt = allFeatures(restored).find((f) => f.id === 'pt-1');
      expect(pt).toBeDefined();
      expect(pt!.detailDocument).toBe(FIXTURE_DETAIL_DOCUMENT);
    }
  });

  it('projectsEqual detects a 詳細文書 difference (featuresEqual compares the document)', () => {
    // Without this comparison the round-trip identity criterion is blind to a
    // dropped document —「消しても等しい」誤検出 (受け入れ基準7 の穴).
    const project = richValidProject();
    const manifest = serialize(project);
    const stripped = JSON.parse(JSON.stringify(manifest)) as {
      histories: {
        entries: { anchor: { snapshot: { features: Record<string, unknown>[] } } }[];
      }[];
    };
    for (const h of stripped.histories)
      for (const e of h.entries)
        for (const f of e.anchor.snapshot.features) delete f['detailDocument'];
    const parsed = parseManifest(stripped);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      expect(projectsEqual(project, deserialize(parsed.manifest))).toBe(false);
    }
  });

  it('restores a pre-document manifest (detailDocument keys absent) with the field absent (後方互換)', () => {
    // A manifest written before FR-98 carries no detailDocument key anywhere; it
    // must parse (optional key) and restore to features WITHOUT the key (absent,
    // never present-undefined / present-''), same shape as the pre-alpha test.
    const manifest = serialize(richValidProject());
    const json = JSON.parse(JSON.stringify(manifest)) as {
      histories: {
        entries: { anchor: { snapshot: { features: Record<string, unknown>[] } } }[];
      }[];
    };
    for (const h of json.histories)
      for (const e of h.entries)
        for (const f of e.anchor.snapshot.features) delete f['detailDocument'];
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      for (const f of allFeatures(restored)) {
        expect('detailDocument' in f).toBe(false);
      }
    }
  });

  it("collapses detailDocument:'' in a manifest to absent (canonical empty form, FR-98)", () => {
    // A hand-crafted / legacy manifest may carry an EMPTY document string. The
    // deserialize boundary must normalize it to absent (never a present-''), so
    // featuresEqual / round-trip identity have exactly one representation of
    //「文書なし」and exactOptionalPropertyTypes never sees present-undefined.
    const manifest = serialize(richValidProject());
    const json = JSON.parse(JSON.stringify(manifest)) as {
      histories: {
        entries: { anchor: { snapshot: { features: Record<string, unknown>[] } } }[];
      }[];
    };
    for (const h of json.histories)
      for (const e of h.entries)
        for (const f of e.anchor.snapshot.features) f['detailDocument'] = '';
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      for (const f of allFeatures(restored)) {
        expect('detailDocument' in f).toBe(false);
        expect(f.detailDocument).toBeUndefined();
      }
      // The canonical form round-trips: re-serializing writes NO detailDocument key.
      const rewritten = JSON.parse(JSON.stringify(serialize(restored))) as {
        histories: {
          entries: { anchor: { snapshot: { features: Record<string, unknown>[] } } }[];
        }[];
      };
      for (const h of rewritten.histories)
        for (const e of h.entries)
          for (const f of e.anchor.snapshot.features) {
            expect('detailDocument' in f).toBe(false);
          }
    }
  });

  it('property: round-trip identity for any generated valid project', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        const restored = deserialize(serialize(project));
        return projectsEqual(project, restored);
      }),
    );
  });

  it('property: serialize output always parses through the boundary', () => {
    fc.assert(
      fc.property(projectArb(), (project) => {
        const result = parseManifest(JSON.parse(JSON.stringify(serialize(project))));
        return result.outcome === PARSE_OUTCOME.Ok;
      }),
    );
  });

  // FR-13 グリッド ON/OFF — the visibility flag round-trips through the FULL manifest
  // boundary (serialize → JSON → parse → deserialize), and a pre-FR13 `ui` block (the
  // flag stripped) still parses (optional 追記, 後方互換). The store-side default-fill
  // (欠落=可視) is the bridge's job — pinned in ui-settings-bridge.test.ts.
  function uiSettingsWith(over: Partial<{ gridVisible: boolean }>): UiSettings {
    return {
      project: {
        projectName: 'g',
        projectDescription: 'd',
        equatorLengthKm: 40000,
        flattening: 0.0034,
        timelineMinYear: 0,
        timelineMaxYear: 100,
        gridSpacingDeg: 10,
        gridColor: '#abcdef',
        gridOpacity: 0.5,
        baseMapId: '@preset/equirectangular-world',
        areaLabelOccupancyThreshold: 0.3,
        newAreaAutoColorDefault: false,
        defaultPaletteTheme: 'default',
        customPalette: [],
        zoomMin: 1,
        zoomMax: 50,
        ...over,
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

  it('round-trips uiSettings.gridVisible through the JSON boundary (FR-13 save→load 保存)', () => {
    for (const gridVisible of [true, false]) {
      const project: DomainProject = {
        ...richValidProject(),
        uiSettings: uiSettingsWith({ gridVisible }),
      };
      const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(project))));
      expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
      if (parsed.outcome === PARSE_OUTCOME.Ok) {
        const restored = deserialize(parsed.manifest);
        expect(restored.uiSettings?.project.gridVisible).toBe(gridVisible);
        expect(projectsEqual(project, restored)).toBe(true);
      }
    }
  });

  it('parses a pre-FR13 ui block (gridVisible stripped) — the key stays absent on restore', () => {
    const project: DomainProject = {
      ...richValidProject(),
      uiSettings: uiSettingsWith({ gridVisible: true }),
    };
    const json = JSON.parse(JSON.stringify(serialize(project))) as {
      ui?: { project: Record<string, unknown> };
    };
    delete json.ui!.project['gridVisible'];
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome === PARSE_OUTCOME.Ok) {
      const restored = deserialize(parsed.manifest);
      // deserialize carries it faithfully (absent → absent); the 欠落=可視 store default
      // is applied by the load bridge, not here (ui-settings-bridge.test.ts).
      expect('gridVisible' in (restored.uiSettings?.project ?? {})).toBe(false);
    }
  });

  it('golden: a document-less project serializes byte-identically to the pre-FR98 manifest', () => {
    // FR-98 claims「文書なしプロジェクトの出力は pre-FR98 manifest と byte 同等」
    // (optional 追記・serializer は absent を書かない). This golden PINS that claim —
    // and the manifest's key ORDER — as a literal string. The expected text was
    // generated ONCE and verified byte-identical against the pre-FR98 serializer
    // (commit 28b692a~1) on this exact project; any serializer change that reorders
    // keys, adds a key to a doc-less feature, or alters number formatting fails here
    // loudly instead of silently changing every .tmap on disk. The project is built
    // INLINE (not from shared fixtures) so fixture drift cannot move the golden.
    const vertices = [
      createVertex(asVertexId('g-v0'), createCoordinate(0, 0)),
      createVertex(asVertexId('g-v1'), createCoordinate(10, 0)),
      createVertex(asVertexId('g-v2'), createCoordinate(10, 10)),
      createVertex(asVertexId('g-v3'), createCoordinate(0, 10)),
    ];
    const ring = createTerritoryRing(
      asRingId('g-r'),
      vertices.map((v) => v.id),
    );
    const leaf = createLeafFeature(
      asFeatureId('g-leaf'),
      createBasicAttributes('金国', 0, 100),
      createColorInfo(true, '#102030', '#405060', '#708090', 'default', 0.5, 0.75),
      createShape([ring]),
      { kindLabel: '王国', parentId: asFeatureId('g-parent') },
    );
    const anchor = createAnchor(
      asAnchorId('g-anc'),
      createAnchorSnapshot([leaf], createVertexStore(vertices)),
    );
    const project: DomainProject = {
      histories: [
        {
          featureId: asFeatureId('g-leaf'),
          series: { entries: [createAnchorEntry(anchor, timePointYear(0), null)] },
        },
      ],
      settings: {
        calendarId: 'gregorian',
        geo: createGeoParams(40000, 0.0034),
        gridSpacingDeg: 10,
        snapDistancePx: 50,
        autoColorDefault: true,
      },
      baseMap: {
        source: '@preset/equirectangular-world',
        meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
      },
    };

    const expected = `{
  "version": "tmap/1",
  "histories": [
    {
      "featureId": "g-leaf",
      "entries": [
        {
          "anchor": {
            "id": "g-anc",
            "snapshot": {
              "features": [
                {
                  "kind": "leaf",
                  "id": "g-leaf",
                  "attributes": {
                    "name": "金国",
                    "startYear": 0,
                    "endYear": 100
                  },
                  "color": {
                    "autoColorEnabled": true,
                    "fillColor": "#102030",
                    "fillOpacity": 0.5,
                    "selectedColor": "#405060",
                    "selectedOpacity": 0.75,
                    "borderColor": "#708090",
                    "paletteTheme": "default"
                  },
                  "kindLabel": "王国",
                  "parentId": "g-parent",
                  "shape": {
                    "rings": [
                      {
                        "kind": "territory",
                        "id": "g-r",
                        "vertexIds": [
                          "g-v0",
                          "g-v1",
                          "g-v2",
                          "g-v3"
                        ]
                      }
                    ]
                  }
                }
              ],
              "vertices": [
                {
                  "id": "g-v0",
                  "coordinate": {
                    "lon": 0,
                    "lat": 0
                  }
                },
                {
                  "id": "g-v1",
                  "coordinate": {
                    "lon": 10,
                    "lat": 0
                  }
                },
                {
                  "id": "g-v2",
                  "coordinate": {
                    "lon": 10,
                    "lat": 10
                  }
                },
                {
                  "id": "g-v3",
                  "coordinate": {
                    "lon": 0,
                    "lat": 10
                  }
                }
              ]
            }
          },
          "start": {
            "granularity": "year",
            "year": 0
          },
          "end": null
        }
      ]
    }
  ],
  "settings": {
    "project": {
      "calendarId": "gregorian",
      "geo": {
        "equatorKm": 40000,
        "flattening": 0.0034
      },
      "gridSpacingDeg": 10,
      "snapDistancePx": 50
    },
    "app": {
      "autoColorDefault": true
    }
  },
  "baseMap": {
    "source": "@preset/equirectangular-world",
    "meta": {
      "lonWest": -180,
      "lonEast": 180,
      "latNorth": 90,
      "latSouth": -90
    }
  }
}`;

    const actual = JSON.stringify(serialize(project), null, 2);
    expect(actual).toBe(expected);
    // The doc-less manifest carries NO detailDocument key anywhere (the intent
    // the literal encodes, asserted explicitly for readability).
    expect(actual).not.toContain('detailDocument');
  });
});
