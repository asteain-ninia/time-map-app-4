// 引いている最中の年（`mount/input.ts` の関門と見張り）。止められずに年や書類が変わる経路のうち、
// 実機では板が先に押下を畳むもの（設定の補正）も、生きた押下に当たる形で確かめる（教訓 5.41）。
// 実機の通しは `e2e/drag-year.spec.ts`。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { timePointYear } from '../../../domain/time/time-point';
import { TOOL_ID } from '../../shell/tools';
import { EDIT_MODE } from '../../state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../../state/store';
import { DRAG_CANCEL_CAUSE, type DragYearHost } from '../drag-year';
import type { EditSessionPort, MapCameraInput } from '../ports';
import { CursorPositionStore } from '../../shell/cursor-position';

import { createMountInput, type MountInput } from './input';
import type { MountStore, MountTransients } from './shared';

type Domain = ReturnType<MountStore['getState']>['domain'];

const CAMERA = { centerLon: 0, centerLat: 0, zoom: 4 };
const VIEWPORT = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

describe('引いている最中の年 — 地図の入力の層', () => {
  let input: MountInput;
  let store: MountStore;
  let target: HTMLDivElement;
  let session: { begin: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let host: { pressBegan: ReturnType<typeof vi.fn>; timeMoveRefused: ReturnType<typeof vi.fn>; cancelled: ReturnType<typeof vi.fn> };
  let boardOpened: { current: (() => void) | null };
  let writeCamera: ReturnType<typeof vi.fn>;
  let selectionEnd: ReturnType<typeof vi.fn>;
  let cameraInput: { current: MapCameraInput | null };

  const press = (): void => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true, clientX: 10, clientY: 10 }),
    );
  };
  const release = (): void => {
    target.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true, clientX: 60, clientY: 10 }),
    );
  };
  const year = (): number => store.getState().currentTime.year;
  const move = (y: number): void => {
    store.getState().setCurrentTime(timePointYear(y), TIME_CHANGE_SOURCE.NumericJump);
  };

  beforeEach(() => {
    store = createSessionStore({
      initialDomain: { tag: 'd0' } as unknown as Domain,
      existence: { featureExistsAt: () => true, vertexExistsAt: () => true },
      initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditVertex, currentTime: timePointYear(1500) },
    }) as unknown as MountStore;
    target = document.createElement('div');
    // jsdom には無い（地図の移動は押した要素へ入力を捕まえる）。
    target.setPointerCapture = vi.fn();
    target.releasePointerCapture = vi.fn();
    document.body.appendChild(target);
    writeCamera = vi.fn();
    selectionEnd = vi.fn();
    cameraInput = { current: null };
    session = { begin: vi.fn(() => true), cancel: vi.fn(), release: vi.fn() };
    host = { pressBegan: vi.fn(), timeMoveRefused: vi.fn(), cancelled: vi.fn() };
    boardOpened = { current: null };
    input = createMountInput({
      store,
      ports: {
        readCamera: () => ({ camera: CAMERA, viewport: VIEWPORT }),
        writeCamera,
        effectiveZoomRange: () => undefined,
        screenToWorld: () => ({ lon: 0, lat: 0 }),
      } as unknown as Parameters<typeof createMountInput>[0]['ports'],
      hookTarget: target,
      mapCell: target,
      transients: { flushRedraw: () => {} } as unknown as MountTransients,
      cursorPositionStore: new CursorPositionStore(),
      cameraInputRef: cameraInput,
      hitTester: { hitTest: () => ({ kind: 'empty' }) as never },
      selectionPort: { start: () => {}, move: () => {}, end: selectionEnd, cancel: () => {} },
      editSession: {
        begin: session.begin,
        update: () => {},
        release: session.release,
        cancel: session.cancel,
      } as unknown as EditSessionPort,
      contextMenu: { request: () => {} },
      boardOpenedRef: boardOpened,
      dragYearHostRef: { current: host as unknown as DragYearHost },
    });
  });

  afterEach(() => {
    input.dispose();
    target.remove();
  });

  it('掴んでいる間は年を止めて知らせ、離したら止めない', () => {
    move(1600);
    expect(year()).toBe(1600);
    press();
    move(1700);
    expect(year()).toBe(1600);
    expect(host.timeMoveRefused).toHaveBeenCalledTimes(1);
    expect(host.timeMoveRefused).toHaveBeenCalledWith(TIME_CHANGE_SOURCE.NumericJump);
    release();
    expect(session.release).toHaveBeenCalledTimes(1);
    move(1700);
    expect(year()).toBe(1700);
    expect(host.timeMoveRefused).toHaveBeenCalledTimes(1);
  });

  it('掴まなかった押下では止めない', () => {
    session.begin.mockReturnValue(false);
    press();
    move(1700);
    expect(year()).toBe(1700);
    expect(host.timeMoveRefused).not.toHaveBeenCalled();
  });

  it('同じ年への書き込みは断らない（続きは走る）', () => {
    press();
    const andThen = vi.fn();
    store.getState().setCurrentTime(timePointYear(1500), TIME_CHANGE_SOURCE.NumericJump, andThen);
    expect(andThen).toHaveBeenCalledTimes(1);
    expect(host.timeMoveRefused).not.toHaveBeenCalled();
  });

  it('表示年の範囲で年が補正されたら、記録せずに取り消して言う。範囲の中なら引き続ける', () => {
    press();
    store.getState().setTimelineRange(timePointYear(0), timePointYear(2000));
    expect(session.cancel).not.toHaveBeenCalled();
    expect(host.cancelled).not.toHaveBeenCalled();

    store.getState().setProjectTimelineRangeYears(0, 1400);
    expect(year()).toBe(1400);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Time);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('書類の中身が変わったら、記録せずに取り消して言う', () => {
    press();
    store.setState({ domain: { tag: 'd1' } as unknown as Domain });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Document);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  it('読み込みの印が動いたら、読み込みとして言う（中身も変わっていても）', () => {
    press();
    store.setState({
      domain: { tag: 'd2' } as unknown as Domain,
      projectLoadNonce: store.getState().projectLoadNonce + 1,
    });
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Project);
  });

  it('板が開いたら、記録せずに取り消して言う', () => {
    press();
    boardOpened.current?.();
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.Board);
    release();
    expect(session.release).not.toHaveBeenCalled();
  });

  describe('離した知らせを取りこぼしたとき', () => {
    const moveWith = (buttons: number, x = 40): void => {
      target.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, buttons, bubbles: true, clientX: x, clientY: 10 }),
      );
    };
    const expectCancelled = (cause: string): void => {
      expect(session.cancel).toHaveBeenCalledTimes(1);
      expect(host.cancelled).toHaveBeenCalledTimes(1);
      expect(host.cancelled.mock.calls[0]?.[0]).toBe(cause);
      // 古いドラッグを確定する経路が残らない。
      release();
      expect(session.release).not.toHaveBeenCalled();
      // 年は普通に動く。
      move(1700);
      expect(year()).toBe(1700);
      expect(host.timeMoveRefused).not.toHaveBeenCalled();
    };

    it('押したボタンが無い移動が来たら、記録せずに取り消して言う', () => {
      press();
      moveWith(1);
      expect(session.cancel).not.toHaveBeenCalled();
      moveWith(0);
      expectCancelled(DRAG_CANCEL_CAUSE.LostRelease);
    });

    it('別のボタンだけが押されている移動でも、押したボタンが無いので取り消す', () => {
      press();
      moveWith(2);
      expectCancelled(DRAG_CANCEL_CAUSE.LostRelease);
    });

    it('窓の焦点が外れたら、記録せずに取り消して言う', () => {
      press();
      window.dispatchEvent(new Event('blur'));
      expectCancelled(DRAG_CANCEL_CAUSE.WindowLeft);
    });

    it('窓が隠れたら、記録せずに取り消して言う。見えるようになっただけでは何もしない', () => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get');
      try {
        press();
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(session.cancel).not.toHaveBeenCalled();
        visibility.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expectCancelled(DRAG_CANCEL_CAUSE.WindowLeft);
      } finally {
        visibility.mockRestore();
      }
    });

    it('同じポインタの次の押下が来たら、前を取り消して言い、新しい押下として掴む', () => {
      press();
      press();
      expect(session.cancel).toHaveBeenCalledTimes(1);
      expect(host.cancelled.mock.calls[0]?.[0]).toBe(DRAG_CANCEL_CAUSE.LostRelease);
      expect(session.begin).toHaveBeenCalledTimes(2);
      expect(host.pressBegan).toHaveBeenCalledTimes(2);
      // 今度の押下は生きている: 離すと 1 回だけ確定する。
      move(1700);
      expect(year()).toBe(1500);
      release();
      expect(session.release).toHaveBeenCalledTimes(1);
    });

    it('別のポインタの押下は同時押しのままで、前の押下を壊さない', () => {
      // 試験の環境の PointerEvent は MouseEvent の代役で `pointerId` を持たないので、ここだけ付ける。
      const withId = (pointerId: number): Event =>
        Object.assign(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 30, clientY: 10 }), {
          pointerId,
        });
      target.dispatchEvent(withId(1));
      target.dispatchEvent(withId(2));
      expect(session.cancel).not.toHaveBeenCalled();
      expect(session.begin).toHaveBeenCalledTimes(1);
      target.dispatchEvent(
        Object.assign(new MouseEvent('pointerup', { button: 0, bubbles: true, clientX: 60, clientY: 10 }), {
          pointerId: 1,
        }),
      );
      expect(session.release).toHaveBeenCalledTimes(1);
    });

    it('取り消す押下が無ければ、焦点が外れても何も言わない', () => {
      window.dispatchEvent(new Event('blur'));
      expect(session.cancel).not.toHaveBeenCalled();
      expect(host.cancelled).not.toHaveBeenCalled();
    });

    it('掴まなかった押下（矩形選択）は畳むが、記録が無いので言わない', () => {
      session.begin.mockReturnValue(false);
      press();
      moveWith(0);
      expect(host.cancelled).not.toHaveBeenCalled();
      release();
      expect(selectionEnd).not.toHaveBeenCalled();
    });

    describe('地図の移動（記録が無いので言わない）', () => {
      const panPress = (): void => {
        target.dispatchEvent(
          new PointerEvent('pointerdown', { button: 1, pointerId: 1, bubbles: true, clientX: 10, clientY: 10 }),
        );
      };
      const panMove = (buttons: number, x: number): void => {
        target.dispatchEvent(
          new PointerEvent('pointermove', { pointerId: 1, buttons, bubbles: true, clientX: x, clientY: 10 }),
        );
      };

      it('中ボタンの移動は、中ボタンが押されている間だけ続く', () => {
        panPress();
        panMove(4, 40);
        expect(writeCamera).toHaveBeenCalledTimes(1);
        panMove(0, 80);
        panMove(4, 120);
        expect(writeCamera).toHaveBeenCalledTimes(1);
        expect(target.releasePointerCapture).toHaveBeenCalledTimes(1);
        expect(host.cancelled).not.toHaveBeenCalled();
      });

      it('窓の焦点が外れたら畳み、離しても動かない', () => {
        panPress();
        panMove(4, 40);
        window.dispatchEvent(new Event('blur'));
        panMove(4, 120);
        expect(writeCamera).toHaveBeenCalledTimes(1);
        expect(target.releasePointerCapture).toHaveBeenCalledTimes(1);
        expect(host.cancelled).not.toHaveBeenCalled();
      });

      it('次の押下が来たら畳んで、新しい押下の起点から動く（捕まえたままにしない）', () => {
        panPress();
        panPress();
        expect(target.releasePointerCapture).toHaveBeenCalledTimes(1);
        expect(target.setPointerCapture).toHaveBeenCalledTimes(2);
        expect(host.cancelled).not.toHaveBeenCalled();
      });

      it('測量の左ドラッグから渡された移動（中ボタンとして走る）は、左が押されていれば続く', () => {
        const element = target as unknown as EventTarget;
        const begin = new PointerEvent('pointermove', { pointerId: 1, buttons: 1, clientX: 40, clientY: 10 });
        Object.defineProperty(begin, 'currentTarget', { value: element });
        cameraInput.current?.beginPan?.(begin, 10, 10);
        const held = new PointerEvent('pointermove', { pointerId: 1, buttons: 1, clientX: 60, clientY: 10 });
        cameraInput.current?.pointerMove(held, 60, 10);
        expect(writeCamera).toHaveBeenCalledTimes(1);
        const lost = new PointerEvent('pointermove', { pointerId: 1, buttons: 0, clientX: 80, clientY: 10 });
        cameraInput.current?.pointerMove(lost, 80, 10);
        cameraInput.current?.pointerMove(held, 100, 10);
        expect(writeCamera).toHaveBeenCalledTimes(1);
      });
    });

    it('外したらリスナーは残らない', () => {
      press();
      input.dispose();
      window.dispatchEvent(new Event('blur'));
      expect(session.cancel).not.toHaveBeenCalled();
      input = { dispose: () => {} };
    });
  });

  it('掴んだ瞬間に宿主へ知らせる（動かさないクリックでも、再生の 1 コマより先に止まる）', () => {
    press();
    expect(host.pressBegan).toHaveBeenCalledTimes(1);
    expect(host.timeMoveRefused).not.toHaveBeenCalled();
    release();
    expect(host.pressBegan).toHaveBeenCalledTimes(1);
  });

  it('掴まなかった押下では宿主へ知らせない（再生は止まらない）', () => {
    session.begin.mockReturnValue(false);
    press();
    expect(host.pressBegan).not.toHaveBeenCalled();
  });

  it('外したら関門は残らない', () => {
    press();
    input.dispose();
    move(1700);
    expect(year()).toBe(1700);
    input = { dispose: () => {} };
  });
});
