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
