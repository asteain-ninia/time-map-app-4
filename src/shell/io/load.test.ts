// U15 受け入れ基準5: 読込データは必ず U14 の Zod 検証を通る。スキーマ不一致/
// バージョン不一致/破損/必須エントリ欠落は成功結果でなく拒否理由を返す（互換
// マイグレーションは行わない）。

import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import { PARSE_OUTCOME } from '../../domain/persistence/boundary';
import { BASEMAP_ENTRY, MANIFEST_ENTRY } from './entry-paths';
import { buildTmap } from './tmap';
import { loadTmapBytes } from './load';

const baseMap = new Uint8Array([1, 2, 3]);

/** Build a .gimoza whose manifest entry is the given arbitrary JSON value. */
function tmapWithManifest(manifest: unknown): Uint8Array {
  return zipSync({
    [MANIFEST_ENTRY]: new TextEncoder().encode(JSON.stringify(manifest)),
    [BASEMAP_ENTRY]: baseMap,
  });
}

describe('loadTmapBytes routes through the Zod boundary (受け入れ基準5)', () => {
  it('a valid .gimoza loads and returns the typed manifest + assets', () => {
    const manifest = serialize(richValidProject());
    const bytes = buildTmap({ manifest, baseMapImage: baseMap, attachments: [] });
    const res = loadTmapBytes('/d/world.gimoza', bytes);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/d/world.gimoza');
    expect(res.manifest).toEqual(manifest);
    expect(Array.from(res.baseMapImage)).toEqual(Array.from(baseMap));
  });

  it('a schema-mismatch manifest is REJECTED (invalid), not returned (受け入れ基準5)', () => {
    // Correct version, but body is structurally wrong (histories missing etc.).
    const bytes = tmapWithManifest({ version: 'tmap/1', nonsense: true });
    const res = loadTmapBytes('/d/bad.gimoza', bytes);
    expect(res.ok).toBe(false);
    if (res.ok || res.reason === 'cancelled') return;
    expect(res.reason).toBe('invalid');
    expect(res.parse?.outcome).toBe(PARSE_OUTCOME.Invalid);
    expect(res.message.length).toBeGreaterThan(0);
  });

  it('a version-mismatch manifest is REJECTED, never migrated (受け入れ基準5)', () => {
    const bytes = tmapWithManifest({ version: 'tmap/999', histories: [] });
    const res = loadTmapBytes('/d/old.gimoza', bytes);
    expect(res.ok).toBe(false);
    if (res.ok || res.reason === 'cancelled') return;
    expect(res.reason).toBe('invalid');
    expect(res.parse?.outcome).toBe(PARSE_OUTCOME.VersionIncompatible);
  });

  it('a missing-version manifest is REJECTED', () => {
    const bytes = tmapWithManifest({ histories: [] });
    const res = loadTmapBytes('/d/x.gimoza', bytes);
    expect(res.ok).toBe(false);
    if (res.ok || res.reason === 'cancelled') return;
    expect(res.parse?.outcome).toBe(PARSE_OUTCOME.VersionMissing);
  });

  it('a corrupt ZIP returns a rejection, does not throw (受け入れ基準5)', () => {
    expect(() => loadTmapBytes('/d/x.gimoza', new Uint8Array([0, 1, 2]))).not.toThrow();
    const res = loadTmapBytes('/d/x.gimoza', new Uint8Array([0, 1, 2]));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
  });

  it('a .gimoza missing the manifest entry returns a rejection', () => {
    const bytes = zipSync({ [BASEMAP_ENTRY]: baseMap });
    const res = loadTmapBytes('/d/x.gimoza', bytes);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
  });
});
