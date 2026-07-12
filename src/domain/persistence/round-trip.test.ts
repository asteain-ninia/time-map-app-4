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
import { FIXTURE_DETAIL_DOCUMENT, projectArb, richValidProject } from './fixtures';
import type { Feature } from '../feature';

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
});
