// U39 / FR-04 unit test (node): the PURE base-map 差し替え seam.
// Covers (task §フェーズ2 seam 単体): valid image → applyReplacement with the swapped
// source + KEPT meta (座標契約 v2) + bytes; a preset project gets the user marker while
// a user project keeps its source; cancel (null) → 無変更; 不正 bytes → 拒否 + notify,
// no apply. The store/dirty/save/display sinks are the caller's — exercised in the
// FileOpsController integration test; here we assert the seam's decision + ports.

import { describe, it, expect, vi } from 'vitest';

import {
  runBasemapReplace,
  REPLACED_BASEMAP_SOURCE,
  BASEMAP_REPLACE_OUTCOME,
  BASEMAP_REPLACE_REJECT_NOTICE,
  type BasemapReplacePorts,
} from './basemap-replace';
import { PRESET_BASEMAP_ID, FULL_WORLD_META } from '../../domain/basemap/index';
import type { BaseMapReference } from '../../domain/persistence/index';

/** A minimal valid PNG header (sig + IHDR w×h) that passes checkBaseMapImageBytes. */
function pngHeaderBytes(widthPx = 4096, heightPx = 2048): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length (13)
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  b.set([(widthPx >>> 24) & 0xff, (widthPx >>> 16) & 0xff, (widthPx >>> 8) & 0xff, widthPx & 0xff], 16);
  b.set([(heightPx >>> 24) & 0xff, (heightPx >>> 16) & 0xff, (heightPx >>> 8) & 0xff, heightPx & 0xff], 20);
  return b;
}

const PRESET_BASEMAP: BaseMapReference = { source: PRESET_BASEMAP_ID, meta: FULL_WORLD_META };
const USER_META = { lonWest: -170, lonEast: 190, latNorth: 85, latSouth: -85 } as const;
const USER_BASEMAP: BaseMapReference = { source: 'derle/world.img', meta: USER_META };

function makePorts(overrides: Partial<BasemapReplacePorts> = {}): {
  ports: BasemapReplacePorts;
  applied: { source: string; meta: unknown; bytes: Uint8Array }[];
  notices: string[];
} {
  const applied: { source: string; meta: unknown; bytes: Uint8Array }[] = [];
  const notices: string[] = [];
  const ports: BasemapReplacePorts = {
    pickImageBytes: async () => pngHeaderBytes(),
    getBaseMap: () => PRESET_BASEMAP,
    applyReplacement: (next) => applied.push({ ...next }),
    notify: (m) => notices.push(m),
    ...overrides,
  };
  return { ports, applied, notices };
}

describe('runBasemapReplace — valid image adoption (FR-04)', () => {
  it('applies a valid PNG on a PRESET project: user marker source, kept meta, bytes', async () => {
    const bytes = pngHeaderBytes();
    const { ports, applied } = makePorts({ pickImageBytes: async () => bytes });

    const outcome = await runBasemapReplace(ports);

    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Applied);
    expect(applied).toHaveLength(1);
    // A preset project needs a non-preset source so resolveDisplayedBasemap picks user.
    expect(applied[0]!.source).toBe(REPLACED_BASEMAP_SOURCE);
    // META 保持: the preset carries the full-world equirectangular meta — kept verbatim.
    expect(applied[0]!.meta).toEqual(FULL_WORLD_META);
    // The exact picked bytes are forwarded (no copy / mutation).
    expect(applied[0]!.bytes).toBe(bytes);
  });

  it('KEEPS a user project source AND meta — only the image bytes change (座標契約 v2)', async () => {
    const bytes = pngHeaderBytes();
    const { ports, applied } = makePorts({
      getBaseMap: () => USER_BASEMAP,
      pickImageBytes: async () => bytes,
    });

    const outcome = await runBasemapReplace(ports);

    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Applied);
    // マニフェスト参照は無傷 (swap-basemap.js 同義): the existing user source is preserved.
    expect(applied[0]!.source).toBe('derle/world.img');
    // 投影/範囲維持: the project's own meta is preserved, NOT reset to full-world.
    expect(applied[0]!.meta).toEqual(USER_META);
    expect(applied[0]!.bytes).toBe(bytes);
  });
});

describe('runBasemapReplace — no-op / rejection paths', () => {
  it('cancel (pickImageBytes → null) leaves everything unchanged, no notify', async () => {
    const { ports, applied, notices } = makePorts({ pickImageBytes: async () => null });

    const outcome = await runBasemapReplace(ports);

    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Cancelled);
    expect(applied).toHaveLength(0); // 無変更
    expect(notices).toHaveLength(0); // a cancel is silent
  });

  it('rejects明白に不正な bytes: notify + no apply (適用前に拒否)', async () => {
    const { ports, applied, notices } = makePorts({
      // Not a PNG / JPEG signature → guard UnknownFormat.
      pickImageBytes: async () => new Uint8Array([1, 2, 3, 4]),
    });

    const outcome = await runBasemapReplace(ports);

    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Rejected);
    expect(applied).toHaveLength(0); // the project asset is never touched
    expect(notices).toEqual([BASEMAP_REPLACE_REJECT_NOTICE]); // FR-115 honest reason
  });

  it('honours an injected checkBytes verdict (guard is the single source)', async () => {
    const applyReplacement = vi.fn();
    const outcome = await runBasemapReplace({
      pickImageBytes: async () => pngHeaderBytes(),
      getBaseMap: () => PRESET_BASEMAP,
      applyReplacement,
      checkBytes: () => ({ ok: false, reason: 'badDimensions' }),
    });

    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Rejected);
    expect(applyReplacement).not.toHaveBeenCalled();
  });
});
