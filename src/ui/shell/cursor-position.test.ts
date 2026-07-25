// UI layer (U20 / shell) — カーソル座標のステータス表示テスト.
//
// 表示条件 (地図外では非表示) と、既存の測量モード整形関数への委譲 を先に固定する。
// この unit は「新しい整形関数を作らない」ことが要件: 数値→文字列の変換は
// domain/survey/coords-format の formatLatDecimal / formatLonDecimal だけが行う。

import { describe, expect, it, vi } from 'vitest';

import { formatLatDecimal, formatLonDecimal } from '../../domain/survey/coords-format';

import { CursorPositionStore, cursorCoordinateText } from './cursor-position';

describe('cursorCoordinateText (表示条件)', () => {
  it('returns null when the cursor is not over the map (地図外は非表示)', () => {
    expect(cursorCoordinateText(null)).toBeNull();
  });

  it('delegates entirely to the survey 十進 formatters (新しい整形関数を作らない)', () => {
    const text = cursorCoordinateText({ lon: 139.75, lat: 35.6894 });
    expect(text).not.toBeNull();
    expect(text).toContain(formatLatDecimal(35.6894));
    expect(text).toContain(formatLonDecimal(139.75));
    // 緯度が先、経度が後 (測量パネルと同じ並び).
    expect(text!.indexOf(formatLatDecimal(35.6894))).toBeLessThan(
      text!.indexOf(formatLonDecimal(139.75)),
    );
  });

  it('folds a continuous longitude scalar through the SAME representative fold', () => {
    // +360 turn from an infinite-scroll pan must display identically (U04 fold).
    expect(cursorCoordinateText({ lon: 10 + 360, lat: 5 })).toBe(
      cursorCoordinateText({ lon: 10, lat: 5 }),
    );
  });

  it('returns null for a non-finite coordinate (病的入力は非表示)', () => {
    expect(cursorCoordinateText({ lon: Number.NaN, lat: 5 })).toBeNull();
    expect(cursorCoordinateText({ lon: 5, lat: Number.POSITIVE_INFINITY })).toBeNull();
  });

  // Review fix: latitude is NOT periodic (FR-05), so screenToWorld happily returns a
  // lat OUTSIDE the world when the viewport reaches past a pole (pan to centerLat 89 at
  // 100 px/deg and the top edge of a 600px map is lat 92). 北緯 92° does not exist —
  // showing it would make the always-on readout claim a geography that has none.
  it('returns null for a latitude outside the world (極を越えた画面位置は非表示)', () => {
    expect(cursorCoordinateText({ lon: 0, lat: 92 })).toBeNull();
    expect(cursorCoordinateText({ lon: 0, lat: -90.5 })).toBeNull();
  });

  it('still shows the poles themselves (±90° は世界の内側)', () => {
    expect(cursorCoordinateText({ lon: 0, lat: 90 })).not.toBeNull();
    expect(cursorCoordinateText({ lon: 0, lat: -90 })).not.toBeNull();
  });
});

describe('CursorPositionStore', () => {
  it('starts empty (no cursor position known)', () => {
    expect(new CursorPositionStore().get()).toBeNull();
  });

  it('notifies subscribers when the position changes', () => {
    const store = new CursorPositionStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.set({ lon: 1, lat: 2 });
    expect(store.get()).toEqual({ lon: 1, lat: 2 });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when the position is unchanged (再レンダー爆発の抑止)', () => {
    const store = new CursorPositionStore();
    store.set({ lon: 1, lat: 2 });
    const seen = vi.fn();
    store.subscribe(seen);
    store.set({ lon: 1, lat: 2 });
    store.set({ lon: 1, lat: 2 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('returns a STABLE snapshot identity while unchanged (useSyncExternalStore 安全)', () => {
    const store = new CursorPositionStore();
    store.set({ lon: 1, lat: 2 });
    const first = store.get();
    store.set({ lon: 1, lat: 2 });
    expect(store.get()).toBe(first);
  });

  it('clears back to null and notifies once', () => {
    const store = new CursorPositionStore();
    store.set({ lon: 1, lat: 2 });
    const seen = vi.fn();
    store.subscribe(seen);
    store.clear();
    store.clear();
    expect(store.get()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes cleanly', () => {
    const store = new CursorPositionStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    off();
    store.set({ lon: 3, lat: 4 });
    expect(seen).not.toHaveBeenCalled();
  });
});
