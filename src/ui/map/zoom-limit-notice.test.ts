// 増分 8E（G-21）: ズームの上下限を超えた 1 押しを理由つきで断る判定と置き場。

import { describe, expect, it, vi } from 'vitest';

import {
  ZOOM_LIMIT_NOTICE_STRINGS,
  ZoomLimitNoteStore,
  zoomLimitNoteVisible,
  zoomLimitRefusal,
} from './zoom-limit-notice';

const RANGE = { minZoom: 2, maxZoom: 100 };
const SETTINGS = { zoomMin: 1, zoomMax: 50 };

describe('zoomLimitRefusal', () => {
  it('上限に着いた状態で拡大を押すと断る（文は設定の倍率で書く）', () => {
    expect(zoomLimitRefusal('in', 100, RANGE, SETTINGS)).toEqual({
      side: '拡大の上限（50倍）です',
      status: ZOOM_LIMIT_NOTICE_STRINGS.statusMax(50),
    });
  });

  it('上限の手前なら断らない（その 1 押しで上限まで進む）', () => {
    expect(zoomLimitRefusal('in', 99, RANGE, SETTINGS)).toBeNull();
  });

  it('上限に着いていても、縮小は断らない', () => {
    expect(zoomLimitRefusal('out', 100, RANGE, SETTINGS)).toBeNull();
  });

  it('下限に着いた状態で縮小を押すと断る', () => {
    expect(zoomLimitRefusal('out', 2, RANGE, SETTINGS)?.side).toBe('縮小の下限（1倍）です');
    expect(zoomLimitRefusal('out', 2, RANGE, SETTINGS)?.status).toContain('最小ズーム倍率');
  });

  it('浮動小数のごくわずかなずれは「着いている」と読む', () => {
    expect(zoomLimitRefusal('in', 100 * (1 - 1e-12), RANGE, SETTINGS)).not.toBeNull();
  });

  it('倍率が読めないとき（NaN）は断らない', () => {
    expect(zoomLimitRefusal('in', Number.NaN, RANGE, SETTINGS)).toBeNull();
  });

  it('端数の倍率は小数 1 桁で書く', () => {
    expect(zoomLimitRefusal('out', 2, RANGE, { zoomMin: 0.5, zoomMax: 50 })?.side).toBe(
      '縮小の下限（0.5倍）です',
    );
  });
});

describe('ZoomLimitNoteStore / zoomLimitNoteVisible', () => {
  it('出した倍率から動いたら、脇の文は見せない', () => {
    const store = new ZoomLimitNoteStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show('拡大の上限（50倍）です', 100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(zoomLimitNoteVisible(store.get(), 100)).toBe(true);
    expect(zoomLimitNoteVisible(store.get(), 75)).toBe(false);
    store.clear();
    expect(store.get()).toBeNull();
    expect(zoomLimitNoteVisible(store.get(), 100)).toBe(false);
  });

  it('同じ文・同じ倍率を押し込み直しても知らせない（描き直しを増やさない）', () => {
    const store = new ZoomLimitNoteStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.show('x', 1);
    store.show('x', 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
