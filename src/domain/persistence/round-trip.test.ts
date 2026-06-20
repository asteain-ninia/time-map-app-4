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
import { deserialize } from './serialize';
import { projectArb, richValidProject } from './fixtures';

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
});
