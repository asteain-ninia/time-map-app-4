// S7 出界図 結線 — the renderer host must display the LOADED PROJECT base map (the
// feature-aligned user image) instead of the bundled preset, resolving preset-vs-user
// through the domain's single `resolveDisplayedBasemap` decision and decoding the retained
// bytes exactly ONCE per distinct byte array (二重デコード回避). This is the root fix for
// the実機 report「海岸線と地物が南北にズレる」: the preset SVG normalized land to a
// different height than the project image, so features drew shifted.
//
// RACE COVERAGE (Codex review #1/#2/#4): the decode is async while the desired base map
// can change mid-flight (load A → load B, load → 新規, and the bytes-forwarded-BEFORE-
// domain-reflect window where the getter briefly pairs B's bytes with A's source/meta).
// The host separates the decode cache (bytes → image) from the display-placement key
// {kind, source, bytesId, meta} and re-checks the LIVE desired key when a decode resolves,
// so a stale resolution can never pin a wrong meta (#1) or paint over a newer applied
// map (#2). Deferred decode promises drive those races deterministically here.
//
// The decoder + preset loader are injected (jsdom has no real `createImageBitmap` and
// never fires <img> load events); the FakeContext2D records WHICH image `drawImage`
// painted so we assert the actual canvas content, and the injected preset loader lets the
// fallback tests assert the preset is REALLY drawn (not merely "user not drawn").

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeContext2D } from '../../render/fake-canvas';
import { FULL_WORLD_META, PRESET_BASEMAP_ID } from '../../domain/basemap/index';

import { createAddHostPorts, type BaseMapInput } from './host-ports';

// jsdom has no real 2D context — stub getContext to a recording FakeContext2D and give the
// canvas a measured box so the camera is a well-defined fit-all (800×600 → zoom 800/360).
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

function writeU32(b: Uint8Array, at: number, v: number): void {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/**
 * Minimal VALID PNG header bytes (passes the S7 byte guard: signature + IHDR + sane
 * dimensions). Each call returns a NEW reference — the host keys its decode cache on
 * byte-array identity, so distinct loads are distinct references.
 */
function pngBytes(width = 4096, height = 2048): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  writeU32(b, 8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  writeU32(b, 16, width);
  writeU32(b, 20, height);
  return b;
}

/** A manually-resolvable promise, to hold a decode in flight across desired changes. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the microtask chain (decode await → .then → paintWith) plus any macrotask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const PRESET_IMG = { marker: 'preset' } as unknown as CanvasImageSource;
const presetInput: BaseMapInput = {
  source: PRESET_BASEMAP_ID,
  meta: FULL_WORLD_META,
  bytes: new Uint8Array(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAddHostPorts base-map結線 (S7)', () => {
  it('a loaded USER project decodes its retained bytes ONCE (with the sniffed MIME) and paints the user image', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const userBytes = pngBytes();
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

    // Decoded exactly once, from the retained bytes, with the guard-sniffed MIME...
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(userBytes, 'image/png');
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

  it('a NEW / preset project draws the preset — the user-bytes decoder is never called', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => ({}) as unknown as CanvasImageSource);
    const loadPreset = vi.fn(async () => PRESET_IMG);

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => presetInput,
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });

    await flush();

    expect(decode).not.toHaveBeenCalled();
    expect(ctx.drawnImages).toContain(PRESET_IMG);

    ports.dispose();
    mount.remove();
  });

  it('a user source with NO retained bytes resolves to the preset (loadable=false)', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => ({}) as unknown as CanvasImageSource);
    const loadPreset = vi.fn(async () => PRESET_IMG);

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: 'maps/missing.png',
        meta: FULL_WORLD_META,
        bytes: new Uint8Array(),
      }),
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });

    await flush();
    expect(decode).not.toHaveBeenCalled();
    expect(ctx.drawnImages).toContain(PRESET_IMG);

    ports.dispose();
    mount.remove();
  });

  it('bytes REJECTED by the guard (decode bomb) skip the decoder and DRAW the preset', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => ({}) as unknown as CanvasImageSource);
    const loadPreset = vi.fn(async () => PRESET_IMG);

    // A per-axis-legal surface bomb (32768×8192 > pixel cap): the header guard rejects
    // it BEFORE any decode → not loadable → preset (silent, 既存規約). Stable reference,
    // as the real retained-bytes ref is.
    const bombBytes = pngBytes(32768, 8192);
    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: 'maps/bomb.png',
        meta: FULL_WORLD_META,
        bytes: bombBytes,
      }),
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });

    await flush();
    expect(decode).not.toHaveBeenCalled();
    expect(ctx.drawnImages).toContain(PRESET_IMG);

    ports.dispose();
    mount.remove();
  });

  it('a decode FAILURE falls back silently and ACTUALLY draws the preset', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => null); // undecodable
    const loadPreset = vi.fn(async () => PRESET_IMG);

    const corruptBytes = pngBytes(); // stable reference, as the real retained-bytes ref is
    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => ({
        source: 'maps/corrupt.png',
        meta: FULL_WORLD_META,
        bytes: corruptBytes,
      }),
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });

    await flush();

    // The decode was attempted; it failed → the PRESET is really painted (not merely
    // "user image absent"), and nothing threw.
    expect(decode).toHaveBeenCalledTimes(1);
    expect(loadPreset).toHaveBeenCalledTimes(1);
    expect(ctx.drawnImages).toContain(PRESET_IMG);
    expect(() => ports.redraw()).not.toThrow();

    ports.dispose();
    mount.remove();
  });

  it('switching the retained bytes (load A → load B) re-decodes with the NEW bytes', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const bytesA = pngBytes();
    const bytesB = pngBytes();
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
    expect(decode).toHaveBeenLastCalledWith(bytesB, 'image/png');
    // The latest painted base image is B.
    expect(ctx.drawnImages).toContain(IMG_B);
    expect(ctx.drawnImages[ctx.drawnImages.length - 1]).toBe(IMG_B);

    ports.dispose();
    mount.remove();
  });
});

describe('createAddHostPorts base-map races (S7 — Codex #1/#2/#4)', () => {
  it('latest wins: a STALE in-flight decode (A) resolving AFTER B was applied never paints A', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const bytesA = pngBytes();
    const bytesB = pngBytes();
    const IMG_A = { marker: 'A' } as unknown as CanvasImageSource;
    const IMG_B = { marker: 'B' } as unknown as CanvasImageSource;
    const dA = deferred<CanvasImageSource | null>();
    const dB = deferred<CanvasImageSource | null>();
    const decode = vi.fn((bytes: Uint8Array) => (bytes === bytesA ? dA.promise : dB.promise));

    let current: BaseMapInput = { source: 'maps/a.png', meta: FULL_WORLD_META, bytes: bytesA };
    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => current,
      decodeBaseMapImage: decode,
    });
    await flush(); // A's decode is now in flight (unresolved)

    // Load B while A is still decoding.
    current = { source: 'maps/b.png', meta: FULL_WORLD_META, bytes: bytesB };
    ports.redraw();
    dB.resolve(IMG_B);
    await flush();
    expect(ctx.drawnImages).toContain(IMG_B);

    // NOW the stale A decode lands. It must be DROPPED (live desired is B), not painted.
    dA.resolve(IMG_A);
    await flush();
    expect(ctx.drawnImages).not.toContain(IMG_A);
    expect(ctx.drawnImages[ctx.drawnImages.length - 1]).toBe(IMG_B);

    ports.dispose();
    mount.remove();
  });

  it('Codex #2: user decode in flight → 新規 (preset already applied) → the stale user image never paints', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const bytesA = pngBytes();
    const IMG_A = { marker: 'A' } as unknown as CanvasImageSource;
    const dA = deferred<CanvasImageSource | null>();
    const decode = vi.fn(() => dA.promise);
    const loadPreset = vi.fn(async () => PRESET_IMG);

    // Start on the preset (a fresh app), so 'preset' is the APPLIED key.
    let current: BaseMapInput = presetInput;
    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => current,
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });
    await flush();
    expect(ctx.drawnImages).toContain(PRESET_IMG);

    // Load user map A (decode held in flight) …
    current = { source: 'maps/a.png', meta: FULL_WORLD_META, bytes: bytesA };
    ports.redraw();
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);

    // … then 新規プロジェクト BEFORE A's decode lands: the desired map is the ALREADY-
    // APPLIED preset, so no new decode starts — the fix must still invalidate A.
    current = presetInput;
    ports.redraw();
    await flush();

    // A's decode lands late. Pre-fix it passed the seq check (nothing had re-armed it)
    // and painted the old project's map over the new project. It must be dropped.
    dA.resolve(IMG_A);
    await flush();
    expect(ctx.drawnImages).not.toContain(IMG_A);
    expect(ctx.drawnImages[ctx.drawnImages.length - 1]).toBe(PRESET_IMG);

    ports.dispose();
    mount.remove();
  });

  it('Codex #1: bytes forwarded BEFORE the domain reflect — the final paint uses the NEW meta, not the stale one', async () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const bytesB = pngBytes();
    const IMG_B = { marker: 'B' } as unknown as CanvasImageSource;
    const dB = deferred<CanvasImageSource | null>();
    const decode = vi.fn(() => dB.promise);

    // Phase 1 — the load forwarded B's BYTES while the store domain still carries the
    // PREVIOUS project's source + meta (the real ordering: captureAssets → reflectProject).
    const STALE_META = FULL_WORLD_META; // old project: full world (height 180°)
    const NEW_META = { lonWest: -180, lonEast: 180, latNorth: 45, latSouth: -45 }; // B: height 90°
    let current: BaseMapInput = { source: 'maps/old-a.png', meta: STALE_META, bytes: bytesB };

    const ports = createAddHostPorts(mount, {
      baseMap: (): BaseMapInput => current,
      decodeBaseMapImage: decode,
    });
    await flush(); // a decode for {B bytes × STALE meta} is in flight

    // Phase 2 — the domain reflect lands (source + meta now B's) and triggers a redraw.
    current = { source: 'maps/b.png', meta: NEW_META, bytes: bytesB };
    ports.redraw();
    await flush();

    // The SAME bytes decode exactly once (the display key changed, the decode cache hit).
    expect(decode).toHaveBeenCalledTimes(1);

    // The decode lands: the stale {bytes × old meta} resolution must be dropped and the
    // live {bytes × NEW meta} applied — pre-fix the first resolution pinned the OLD meta
    // forever (the later redraw early-returned on the bytes-only key).
    dB.resolve(IMG_B);
    await flush();
    expect(ctx.drawnImages).toContain(IMG_B);

    // Assert the PLACEMENT: fit-all camera on 800×600 → zoom = 800/360 px/deg. The
    // base-map rect height must be NEW meta's 90° (≈200px), NOT the stale 180° (≈400px).
    const zoom = 800 / 360;
    const last = ctx.drawImages[ctx.drawImages.length - 1]!;
    expect(last.h).toBeCloseTo(90 * zoom, 5);
    expect(last.h).not.toBeCloseTo(180 * zoom, 5);
    expect(last.w).toBeCloseTo(360 * zoom, 5);

    ports.dispose();
    mount.remove();
  });

  it('a pathological getter (NEW bytes reference per read) stays BOUNDED — no self-sustaining decode loop', async () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const decode = vi.fn(async () => null);
    const loadPreset = vi.fn(async () => PRESET_IMG);

    const ports = createAddHostPorts(mount, {
      // CONTRACT VIOLATION on purpose (病的入力): a fresh byte array per read → a fresh
      // display key per read, so no resolution can ever apply. The host must degrade to
      // at most ONE resolution per paint, each dropped on landing WITHOUT re-arming —
      // a drop-branch re-arm recursion would turn this into an unbounded microtask loop
      // (event-loop starvation → heap OOM, found while building these race tests).
      baseMap: (): BaseMapInput => ({
        source: 'maps/unstable.png',
        meta: FULL_WORLD_META,
        bytes: pngBytes(),
      }),
      decodeBaseMapImage: decode,
      loadPresetBaseMapImage: loadPreset,
    });

    await flush();
    const afterMount = decode.mock.calls.length;
    expect(afterMount).toBeLessThanOrEqual(2); // the mount's paint + install, never a loop

    ports.redraw();
    ports.redraw();
    await flush();
    // Bounded by the number of paints (one resolution each) — no self-arming growth.
    expect(decode.mock.calls.length).toBeLessThanOrEqual(afterMount + 2);

    ports.dispose();
    mount.remove();
  });
});
