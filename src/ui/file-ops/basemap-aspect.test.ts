// 増分 8E（G-10）: 背景地図の縦横比の判定・問い・差し替えの手続きへのつなぎ。

import { describe, expect, it, vi } from 'vitest';

import { FULL_WORLD_META, PRESET_BASEMAP_ID } from '../../domain/basemap/index';

import {
  BASEMAP_ASPECT_CHOICE,
  BASEMAP_ASPECT_STRINGS,
  BasemapAspectPromptStore,
  aspectRatioLabel,
  basemapAspectQuestion,
  type BasemapAspectChoice,
} from './basemap-aspect';
import {
  BASEMAP_REPLACE_OUTCOME,
  basemapReplaceResultText,
  runBasemapReplace,
  type BasemapReplacePorts,
} from './basemap-replace';

describe('aspectRatioLabel', () => {
  it('約分して小さな整数になれば「3:2」', () => {
    expect(aspectRatioLabel(300, 200)).toBe('3:2');
    expect(aspectRatioLabel(4096, 2048)).toBe('2:1');
    expect(aspectRatioLabel(1600, 900)).toBe('16:9');
  });
  it('約分しても大きな数なら小数の比', () => {
    expect(aspectRatioLabel(1366, 768)).toBe('1.78:1');
  });
});

describe('basemapAspectQuestion（判定は decideBasemapReplacement の 1 本）', () => {
  it('2:1（許し幅の内）なら聞かない', () => {
    expect(basemapAspectQuestion({ widthPx: 4096, heightPx: 2048 })).toBeNull();
    expect(basemapAspectQuestion({ widthPx: 3601, heightPx: 1800 })).toBeNull();
  });
  it('3:2 なら補正できる問い（補正後は縦をそのまま、横を 2 倍）', () => {
    expect(basemapAspectQuestion({ widthPx: 300, heightPx: 200 })).toEqual({
      widthPx: 300,
      heightPx: 200,
      ratioLabel: '3:2',
      correctable: true,
      corrected: { widthPx: 400, heightPx: 200 },
    });
  });
  it('離れすぎていれば補正できない問い', () => {
    expect(basemapAspectQuestion({ widthPx: 1000, heightPx: 100 })).toMatchObject({
      ratioLabel: '10:1',
      correctable: false,
      corrected: null,
    });
  });
});

describe('BasemapAspectPromptStore', () => {
  it('問いを置いて答えを待ち、答えたら閉じる', async () => {
    const store = new BasemapAspectPromptStore();
    const q = basemapAspectQuestion({ widthPx: 300, heightPx: 200 })!;
    const answer = store.ask(q);
    expect(store.get()).toBe(q);
    store.answer(BASEMAP_ASPECT_CHOICE.Keep);
    await expect(answer).resolves.toBe('keep');
    expect(store.get()).toBeNull();
  });
});

// --- runBasemapReplace へのつなぎ ----------------------------------------------

/** 300×200 の PNG と見なすための関門の差し替え（ヘッダの解析は既存の試験が見ている）。 */
function portsFor(
  choice: BasemapAspectChoice,
  overrides: Partial<BasemapReplacePorts> = {},
): { ports: BasemapReplacePorts; applied: ReturnType<typeof vi.fn> } {
  const applied = vi.fn();
  const ports: BasemapReplacePorts = {
    pickImageBytes: async () => new Uint8Array([1, 2, 3]),
    getBaseMap: () => ({ source: PRESET_BASEMAP_ID, meta: FULL_WORLD_META }),
    applyReplacement: applied,
    checkBytes: () => ({ ok: true, mimeType: 'image/png', widthPx: 300, heightPx: 200 }),
    decodeProbe: async () => true,
    confirmAspect: async () => choice,
    correctImage: async () => new Uint8Array([9, 9]),
    ...overrides,
  };
  return { ports, applied };
}

describe('runBasemapReplace — 縦横比（G-10）', () => {
  it('「補正する」なら、補正したバイト列を差し替えに使う', async () => {
    const { ports, applied } = portsFor(BASEMAP_ASPECT_CHOICE.Correct);
    const outcome = await runBasemapReplace(ports);
    expect(outcome).toMatchObject({ status: 'applied', aspect: 'corrected', ratioLabel: '3:2' });
    expect(applied.mock.calls[0]![0].bytes).toEqual(new Uint8Array([9, 9]));
    expect(basemapReplaceResultText(outcome)?.text).toBe(BASEMAP_ASPECT_STRINGS.appliedCorrected);
  });

  it('「このまま使う」なら、元のバイト列のまま使う', async () => {
    const { ports, applied } = portsFor(BASEMAP_ASPECT_CHOICE.Keep);
    const outcome = await runBasemapReplace(ports);
    expect(outcome).toMatchObject({ status: 'applied', aspect: 'kept' });
    expect(applied.mock.calls[0]![0].bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(basemapReplaceResultText(outcome)?.text).toContain('3:2 のまま');
  });

  it('「やめる」なら何も変えず、やめたことを言う', async () => {
    const { ports, applied } = portsFor(BASEMAP_ASPECT_CHOICE.Cancel);
    const outcome = await runBasemapReplace(ports);
    expect(outcome).toEqual({ status: BASEMAP_REPLACE_OUTCOME.Cancelled, atAspect: true });
    expect(applied).not.toHaveBeenCalled();
    expect(basemapReplaceResultText(outcome)?.text).toBe(BASEMAP_ASPECT_STRINGS.cancelled);
  });

  it('補正に失敗したら差し替えを中止して知らせる', async () => {
    const notify = vi.fn();
    const { ports, applied } = portsFor(BASEMAP_ASPECT_CHOICE.Correct, {
      correctImage: async () => null,
      notify,
      correctFailedNotice: '補正できません',
    });
    const outcome = await runBasemapReplace(ports);
    expect(outcome.status).toBe(BASEMAP_REPLACE_OUTCOME.Rejected);
    expect(applied).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('補正できません');
  });

  it('2:1 の画像なら聞かずに使う', async () => {
    const confirmAspect = vi.fn();
    const { ports } = portsFor(BASEMAP_ASPECT_CHOICE.Keep, {
      checkBytes: () => ({ ok: true, mimeType: 'image/png', widthPx: 400, heightPx: 200 }),
      confirmAspect,
    });
    const outcome = await runBasemapReplace(ports);
    expect(confirmAspect).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'applied', aspect: 'adequate', ratioLabel: null });
  });

  it('聞く口が無ければ（これまでの経路）聞かずにそのまま使う', async () => {
    const { ports, applied } = portsFor(BASEMAP_ASPECT_CHOICE.Keep);
    const { confirmAspect: _omit, ...withoutConfirm } = ports;
    void _omit;
    const outcome = await runBasemapReplace(withoutConfirm);
    expect(outcome).toMatchObject({ status: 'applied', aspect: 'unchecked' });
    expect(applied).toHaveBeenCalledTimes(1);
  });
});
