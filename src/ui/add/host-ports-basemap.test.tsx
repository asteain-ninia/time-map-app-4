// S7 出界図 結線 — the renderer host must display the LOADED PROJECT base map (the
// feature-aligned user image) instead of the bundled preset, resolving preset-vs-user
// through the domain's single `resolveDisplayedBasemap` decision and decoding the retained
// bytes exactly ONCE per distinct byte array (二重デコード回避). This is the root fix for
// the実機 report「海岸線と地物が南北にズレる」: the preset SVG normalized land to a
// different height than the project image, so features drew shifted.
//
// The decode is injected (a fake decoder) because jsdom has no real `createImageBitmap`;
// the FakeContext2D records WHICH image `drawImage` painted so we can assert the user image
// (not the preset) reached the canvas.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeContext2D } from '../../render/fake-canvas';
import { FULL_WORLD_META, PRESET_BASEMAP_ID } from '../../domain/basemap/index';

import { createAddHostPorts, type BaseMapInput } from './host-ports';

// jsdom has no real 2D context — stub getContext to a recording FakeContext2D and give the
// canvas a measured box so the camera is a well-defined fit-all.
function stubCanvas(): FakeContext2D {
  const ctx = new FakeContext2D();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return ctx;
}

/** Drain the microtask chain (decode await → .then → paintWith) plus any macrotask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAddHostPorts base-map結線 (S7)', () => {
  it('a loaded USER project decodes its retained bytes ONCE and paints the user image', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const userBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // non-empty ⇒ user map
    const USER_IMG = { marker: 'user' } as unknown as CanvasImageSource;
    const decode = vi.fn(async () => USER_IMG);

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: 'maps/derle-world.png',
        meta: FULL_WORLD_META,
        bytes: userBytes,
      }),
      decodeBaseMapImage: decode,
    });

    await flush();

    // Decoded exactly once, from the retained bytes...
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(userBytes);
    // ...and the USER image (not the preset) reached the canvas under the grid.
    expect(ctx.drawnImages).toContain(USER_IMG);

    // Re-composites with the SAME bytes reference must NOT re-decode (二重デコード回避).
    ports.redraw();
    ports.redraw();
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);

    ports.dispose();
    mount.remove();
  });

  it('a NEW / preset project shows the preset — the user-bytes decoder is never called', async () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => ({}) as unknown as CanvasImageSource);

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: PRESET_BASEMAP_ID,
        meta: FULL_WORLD_META,
        bytes: new Uint8Array(), // empty ⇒ preset
      }),
      decodeBaseMapImage: decode,
    });

    await flush();

    // The preset path never decodes project bytes (it loads the bundled asset instead).
    expect(decode).not.toHaveBeenCalled();

    ports.dispose();
    mount.remove();
  });

  it('a user source with NO retained bytes resolves to the preset (loadable=false)', async () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => ({}) as unknown as CanvasImageSource);

    const ports = createAddHostPorts(mount, {
      // A non-preset source but empty bytes (e.g. a project whose image failed to load):
      // resolveDisplayedBasemap(source, false) → preset, so no user decode is attempted.
      baseMap: (): BaseMapInput => ({
        source: 'maps/missing.png',
        meta: FULL_WORLD_META,
        bytes: new Uint8Array(),
      }),
      decodeBaseMapImage: decode,
    });

    await flush();
    expect(decode).not.toHaveBeenCalled();

    ports.dispose();
    mount.remove();
  });

  it('a decode FAILURE falls back silently (decoder called, user image not painted, no throw)', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const userBytes = new Uint8Array([1, 2, 3]);
    const decode = vi.fn(async () => null); // undecodable

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: 'maps/corrupt.png',
        meta: FULL_WORLD_META,
        bytes: userBytes,
      }),
      decodeBaseMapImage: decode,
    });

    await flush();

    // The decode was attempted; it failed → silent fallback to the preset (which in jsdom
    // does not load), so NO user image was painted — and nothing threw.
    expect(decode).toHaveBeenCalledTimes(1);
    expect(ctx.drawnImages.length).toBe(0);
    // The host still works (a redraw composes without error).
    expect(() => ports.redraw()).not.toThrow();

    ports.dispose();
    mount.remove();
  });

  it('switching the retained bytes (load A → load B) re-decodes with the NEW bytes', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const bytesA = new Uint8Array([0xa]);
    const bytesB = new Uint8Array([0xb]);
    const IMG_A = { marker: 'A' } as unknown as CanvasImageSource;
    const IMG_B = { marker: 'B' } as unknown as CanvasImageSource;
    const images = new Map<Uint8Array, CanvasImageSource>([
      [bytesA, IMG_A],
      [bytesB, IMG_B],
    ]);
    const decode = vi.fn(async (bytes: Uint8Array) => images.get(bytes) ?? null);

    // The getter reads a mutable holder — the app swaps it on load (new bytes reference).
    let current: BaseMapInput = {
      source: 'maps/a.png',
      meta: FULL_WORLD_META,
      bytes: bytesA,
    };

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => current,
      decodeBaseMapImage: decode,
    });

    await flush();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(ctx.drawnImages).toContain(IMG_A);

    // Load B: swap the bytes reference + source, then redraw (as a load's domain swap would).
    current = { source: 'maps/b.png', meta: FULL_WORLD_META, bytes: bytesB };
    ports.redraw();
    await flush();

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenLastCalledWith(bytesB);
    // The latest painted base image is B.
    expect(ctx.drawnImages).toContain(IMG_B);
    expect(ctx.drawnImages[ctx.drawnImages.length - 1]).toBe(IMG_B);

    ports.dispose();
    mount.remove();
  });
});
