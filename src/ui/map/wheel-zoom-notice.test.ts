// 増分 8E の手直し（G-21）: ホイールでも上下限で理由を出す。状態行は 1 回の回転につき 1 度。

import { describe, expect, it } from 'vitest';

import { WHEEL_GESTURE_GAP_MS, WheelGestureGate, createWheelZoomNotice } from './wheel-zoom-notice';
import { ZOOM_LIMIT_NOTICE_STRINGS, ZoomLimitNoteStore } from './zoom-limit-notice';

const RANGE = { minZoom: 1, maxZoom: 50 };
const SETTINGS = { zoomMin: 1, zoomMax: 50 };

function harness(): {
  notice: ReturnType<typeof createWheelZoomNotice>;
  noteStore: ZoomLimitNoteStore;
  said: string[];
  advance: (ms: number) => void;
} {
  let t = 1000;
  const said: string[] = [];
  const noteStore = new ZoomLimitNoteStore();
  const notice = createWheelZoomNotice({
    settings: () => SETTINGS,
    noteStore,
    announce: (s) => said.push(s),
    now: () => t,
  });
  return { notice, noteStore, said, advance: (ms) => (t += ms) };
}

describe('createWheelZoomNotice（G-21 のホイール）', () => {
  it('上限で拡大のノッチが何個来ても、状態行は 1 回の回転につき 1 度だけ、脇の文は出る', () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) {
      h.notice('in', 50, RANGE);
      h.advance(30);
    }
    expect(h.said).toEqual([ZOOM_LIMIT_NOTICE_STRINGS.statusMax(50)]);
    expect(h.noteStore.get()?.text).toBe(ZOOM_LIMIT_NOTICE_STRINGS.sideMax(50));
  });

  it('間を空けて回し直すと（新しい回転）、状態行にもう 1 度出す', () => {
    const h = harness();
    h.notice('in', 50, RANGE);
    h.advance(WHEEL_GESTURE_GAP_MS + 1);
    h.notice('in', 50, RANGE);
    expect(h.said).toHaveLength(2);
  });

  it('上限へ向かって動いている途中で着いたときも、同じ回転のうちに 1 度だけ出す', () => {
    const h = harness();
    h.notice('in', 40, RANGE); // まだ動く（断らない）
    h.advance(30);
    h.notice('in', 50, RANGE); // 着いた後のノッチ（断る）
    h.advance(30);
    h.notice('in', 50, RANGE);
    expect(h.said).toEqual([ZOOM_LIMIT_NOTICE_STRINGS.statusMax(50)]);
  });

  it('下限で縮小のノッチは下限の文を出す。動くノッチでは何も出さない', () => {
    const h = harness();
    h.notice('out', 20, RANGE);
    expect(h.said).toEqual([]);
    expect(h.noteStore.get()).toBeNull();
    h.advance(WHEEL_GESTURE_GAP_MS + 1);
    h.notice('out', 1, RANGE);
    expect(h.said).toEqual([ZOOM_LIMIT_NOTICE_STRINGS.statusMin(1)]);
    expect(h.noteStore.get()?.text).toBe(ZOOM_LIMIT_NOTICE_STRINGS.sideMin(1));
  });
});

describe('WheelGestureGate', () => {
  it('断らないノッチでも回転は続く（途中で間が空かなければ、2 度目は言わない）', () => {
    let t = 0;
    const gate = new WheelGestureGate(() => t);
    expect(gate.notch(true)).toBe(true);
    t += 100;
    expect(gate.notch(false)).toBe(false);
    t += 100;
    expect(gate.notch(true)).toBe(false);
  });
});
