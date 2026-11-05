// U15 受け入れ基準1: .gimoza (ZIP) round-trip — manifest + base-map が欠落・破損なく
// 往復できる。エントリパス規約が単一の真実源であること。添付画像の領域は持たない
// （FR-98 の改定〔2026-11-03〕で地物の資料の本文は本アプリの外が正本になった）。

import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import { BASEMAP_ENTRY, MANIFEST_ENTRY } from './entry-paths';
import { buildTmap, countFeaturesInTmap, countManifestFeatures, readTmap } from './tmap';

const baseMap = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG-ish bytes

describe('tmap ZIP round-trip', () => {
  it('round-trips the manifest and the base-map (受け入れ基準1)', () => {
    const manifest = serialize(richValidProject());
    const zip = buildTmap({ manifest, baseMapImage: baseMap });

    const read = readTmap(zip);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // manifest survives as the same structural value (version先頭含む).
    expect(read.contents.manifest).toEqual(manifest);
    // base-map bytes intact.
    expect(Array.from(read.contents.baseMapImage)).toEqual(Array.from(baseMap));
    // 書くのはこの 2 つだけ（添付の領域は無い）。
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([BASEMAP_ENTRY, MANIFEST_ENTRY].sort());
  });

  it('古いファイルの添付の領域は読み飛ばし、書き直すと残らない（後方互換は作らない）', () => {
    const manifest = serialize(richValidProject());
    const old = zipSync({
      [MANIFEST_ENTRY]: new TextEncoder().encode(JSON.stringify(manifest)),
      [BASEMAP_ENTRY]: baseMap,
      'assets/attachments/attach-1.png': new Uint8Array([9, 8, 7]),
    });
    const read = readTmap(old);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.contents.manifest).toEqual(manifest);
    expect(Object.keys(read.contents).sort()).toEqual(['baseMapImage', 'manifest']);
    const rewritten = buildTmap(read.contents);
    expect(Object.keys(unzipSync(rewritten)).sort()).toEqual(
      [BASEMAP_ENTRY, MANIFEST_ENTRY].sort(),
    );
  });
});

describe('entry-path convention is the single source of truth (受け入れ基準1)', () => {
  it('a ZIP whose manifest was written at a NON-standard path is rejected (proves both sides share one path)', () => {
    // Writer used the wrong manifest path; reader (using MANIFEST_ENTRY) cannot find it.
    const zip = zipSync({
      'wrong-manifest.json': new Uint8Array([1, 2, 3]),
      [BASEMAP_ENTRY]: baseMap,
    });
    const read = readTmap(zip);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('missing-entry');
    if (read.reason !== 'missing-entry') return;
    expect(read.entry).toBe(MANIFEST_ENTRY);
  });
});

describe('readTmap rejects corrupt / incomplete inputs (受け入れ基準5)', () => {
  it('returns corrupt (not throw) for non-ZIP bytes', () => {
    const read = readTmap(new Uint8Array([0, 1, 2, 3, 4]));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('corrupt');
  });

  it('returns missing-entry when the base-map entry is absent', () => {
    const zip = zipSync({ [MANIFEST_ENTRY]: new Uint8Array([123, 125]) }); // "{}"
    const read = readTmap(zip);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('missing-entry');
    if (read.reason !== 'missing-entry') return;
    expect(read.entry).toBe(BASEMAP_ENTRY);
  });

  it('returns corrupt when the manifest JSON is malformed', () => {
    const zip = zipSync({
      [MANIFEST_ENTRY]: new Uint8Array([0x7b, 0x21]), // "{!" — invalid JSON
      [BASEMAP_ENTRY]: baseMap,
    });
    const read = readTmap(zip);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('corrupt');
  });
});

// Codex 全体レビュー MED — サイズ上限 (container / zip-bomb) の回帰ロック。
describe('readTmap size caps (Codex MED)', () => {
  it('rejects a container larger than the cap without unzipping', () => {
    const big = new Uint8Array(64);
    const res = readTmap(big, { maxContainerBytes: 32 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
    expect(res.message).toContain('大きすぎます');
  });

  it('rejects an entry whose EXPANDED size exceeds the cap (zip-bomb guard)', () => {
    const bytes = buildTmap({
      manifest: { v: 1 },
      baseMapImage: new Uint8Array(100), // expands to 100 bytes > cap 10
    });
    const res = readTmap(bytes, { maxEntryBytes: 10 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
    expect(res.message).toContain('大きすぎます');
  });

  it('caps leave a normal round-trip untouched (default caps)', () => {
    const bytes = buildTmap({
      manifest: { v: 1 },
      baseMapImage: new Uint8Array([9, 9]),
    });
    const res = readTmap(bytes);
    expect(res.ok).toBe(true);
  });
});

// GPT-5.6 Sol レビュー #2 — 展開後「合計」サイズ上限(個別には通る複数エントリの合算 OOM 封鎖)。
describe('readTmap total-size cap (Sol review #2)', () => {
  it('rejects when the SUMMED expanded size exceeds the total cap', () => {
    // 本アプリは書かない余計なエントリも合計に数える（古いファイルの添付の領域など。
    // 読み飛ばすエントリでも、展開の費用は掛かるので上限から外さない）。
    const bytes = zipSync({
      [MANIFEST_ENTRY]: new TextEncoder().encode('{"v":1}'),
      [BASEMAP_ENTRY]: new Uint8Array(40),
      'assets/attachments/a.png': new Uint8Array(40),
      'assets/attachments/b.png': new Uint8Array(40),
    });
    // Each entry is well under the per-entry cap (60) but the sum exceeds 100.
    const res = readTmap(bytes, { maxEntryBytes: 60, maxTotalBytes: 100 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
    expect(res.message).toContain('合計');
  });
});

// Sol レビュー2周目 #1 — サイズ宣言を書き換えたファイルでも「実測」で打ち切れること。
// 旧実装(unzipSync)は宣言値でしか制御できず、宣言を小さく書き換えたエントリの展開
// 作業量を制限できなかった。streaming 化後は実際の出力バイト数で中断する。
// Sol レビュー3周目 #2/#4 の退行防止 — unzipSync 版が完全性(切り詰めZIP)と
// プレフィックス付き/非ZIP を正しく扱うこと(round-2 streaming 版で退行→revert)。
describe('readTmap completeness + ZIP tolerance (Sol round-3 #2/#4)', () => {
  it('a TRUNCATED archive (cut before the central directory) is rejected, not read with dropped entries', () => {
    const full = buildTmap({
      manifest: { v: 1 },
      baseMapImage: new Uint8Array([1, 2, 3]),
    });
    // Cut off the tail (central directory + EOCD). unzipSync needs the central
    // directory to enumerate entries, so a truncated container is corrupt — never a
    // silently-partial project that a later save would persist with lost entries.
    const truncated = full.slice(0, Math.floor(full.length / 2));
    const res = readTmap(truncated);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupt');
  });

  it('a full, honest archive round-trips (non-regression for the revert)', () => {
    const bytes = buildTmap({
      manifest: { v: 1 },
      baseMapImage: new Uint8Array(500),
    });
    const res = readTmap(bytes, { maxEntryBytes: 1000 });
    expect(res.ok).toBe(true);
  });
});

// --- 増分 8D: 世代の一覧の「地物数」 ---------------------------------------------

describe('countFeaturesInTmap / countManifestFeatures（増分 8D）', () => {
  it('全部の歴史・全部の錨に出てくる地物 ID の種類を数える（同じ地物は 1 回）', () => {
    const manifest = {
      histories: [
        {
          entries: [
            { anchor: { snapshot: { features: [{ id: 'a' }, { id: 'b' }] } } },
            { anchor: { snapshot: { features: [{ id: 'a' }] } } },
          ],
        },
        { entries: [{ anchor: { snapshot: { features: [{ id: 'c' }] } } }] },
      ],
    };
    expect(countManifestFeatures(manifest)).toBe(3);
    expect(countManifestFeatures({ histories: [] })).toBe(0);
  });

  it('形が違えば null（一覧はその行の地物数を「—」にする）', () => {
    for (const bad of [null, 3, {}, { histories: 'x' }, { histories: [{ entries: 1 }] }]) {
      expect(countManifestFeatures(bad)).toBeNull();
    }
  });

  it('保存ファイルから数える。マニフェスト以外は展開しない', () => {
    const bytes = buildTmap({
      manifest: serialize(richValidProject()),
      baseMapImage: baseMap,
    });
    const counted = countFeaturesInTmap(bytes);
    expect(counted).toBe(countManifestFeatures(serialize(richValidProject())));
    expect(counted).toBeGreaterThan(0);
  });

  it('壊れた ZIP・マニフェストの無い ZIP・大きすぎる入れ物は null（例外にしない）', () => {
    expect(countFeaturesInTmap(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(countFeaturesInTmap(zipSync({ [BASEMAP_ENTRY]: baseMap }))).toBeNull();
    const ok = buildTmap({ manifest: serialize(richValidProject()), baseMapImage: baseMap });
    expect(countFeaturesInTmap(ok, { maxContainerBytes: 10 })).toBeNull();
  });
});
