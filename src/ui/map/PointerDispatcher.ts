// U40 — the imperative pointer/wheel dispatcher for the central map (FR-09).
//
// This is the thin接着層 between raw DOM events and the pure decision/pan modules
// + the dependency ports. It:
//   1. Normalizes a DOM PointerEvent into a {@link NormalizedPointer} (button,
//      coords, modifiers) and asks {@link decideDispatch} for the single行き先.
//   2. Owns the PAN sequence (press → move → release) end to end, computing the
//      new camera via {@link panCameraTo} (U17 VTransform) and writing it back to
//      U16 through the CameraPort — the連続更新 never touches React state
//      (技術方針 2.3, 受け入れ基準 7).
//   3. Forwards select/edit, add, and context-menu行き先 to U22 / add-unit / U20.
//   4. Routes wheel to U17's cursor-anchored zoom算出 and writes the result to U16
//      (no zoom math re-implemented here, 受け入れ基準 2).
//
// 教訓 5.8「押下→移動→解放シーケンスを全パスで保証する」。適用: each interaction is
// tracked per pointerId; the release/cancel path ALWAYS clears its transient
// state, and a click with no move (Δ < threshold) is finalized without moving the
// camera — the press-time state is still discarded (受け入れ基準 4 / 6).
//
// 教訓 5.2「一時的 UI 状態は全経路で破棄する」。適用: pan transient (the PanReference
// and the per-pointer record) is dropped on release, pointercancel, pointerleave
// AND mode-change (`onModeChange`), so it never leaks into the next operation
// (受け入れ基準 6).

import {
  decideDispatch,
  exceedsDragThreshold,
  pointerButtonFromCode,
  DISPATCH_TARGET,
  POINTER_BUTTON,
  type DispatchTarget,
  type LeftPanRule,
  type PointerButton,
} from './dispatch';
import { panCameraTo, type PanReference } from './pan';
import type {
  AddPort,
  CameraPort,
  ContextMenuPort,
  EditSessionPort,
  HitTester,
  PointerCaptureTarget,
  PointerModifiers,
  SelectionPort,
} from './ports';
import { zoomStepAtCursor, type Camera, type ScreenPoint, type ZoomRange } from '../../render';
import type { EditMode } from '../state/session';

/**
 * A DOM-independent normalized pointer sample. The controller accepts these so
 * its sequencing logic is unit-testable in plain Node (NFR 5.8, 教訓 5.41); a thin
 * React handler builds one from a `PointerEvent`.
 */
export interface NormalizedPointer {
  /** Stable pointer identity for multi-pointer tracking (受け入れ基準 3 末項). */
  readonly pointerId: number;
  /** Screen coordinates relative to the map surface (CSS px). */
  readonly x: number;
  readonly y: number;
  /** The button that changed state (down/up). For move it is the held button. */
  readonly button: PointerButton;
  readonly modifiers: PointerModifiers;
}

/**
 * A normalized wheel sample. `deltaY` < 0 = zoom in (scroll up), > 0 = zoom out,
 * 0 = no-op. `deltaMode` is the DOM `WheelEvent.deltaMode` (0 = pixel, 1 = line,
 * 2 = page); it lets the dispatcher convert line/page deltas to a comparable pixel
 * magnitude so a trackpad (many tiny pixel deltas) and a notched mouse wheel
 * (large line deltas) zoom at a comparable, magnitude-proportional rate.
 */
export interface NormalizedWheel {
  readonly x: number;
  readonly y: number;
  readonly deltaY: number;
  /** DOM WheelEvent.deltaMode (0 pixel / 1 line / 2 page). Defaults to 0 (pixel). */
  readonly deltaMode?: number;
}

/** Approx CSS px per wheel "line" / "page" for deltaMode normalization. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

/**
 * The wheel zoom sensitivity: CSS px of (normalized) deltaY that corresponds to one
 * `wheelFactor` notch. A typical notched mouse wheel emits ~100px per notch, so
 * `factor = wheelFactor ** (-normalizedPx / WHEEL_NOTCH_PX)` reproduces the old
 * one-notch-per-event feel for a 100px event while scaling smoothly for trackpads.
 */
const WHEEL_NOTCH_PX = 100;

/**
 * Saturation cap (in notches) for a single wheel event's zoom step. A pathological
 * device/driver can emit a huge `deltaY` — and, multiplied by the page/line
 * normalization (×800 / ×16), `normalizedPx` can reach values whose exponent makes
 * `wheelFactor ** (-normalizedPx / WHEEL_NOTCH_PX)` overflow to ±Infinity (or
 * underflow to 0). A non-finite `factor` makes `camera.zoom * factor` non-finite,
 * and the clamp would then have to guess the intended bound. We instead saturate
 * the per-event exponent magnitude to a value that keeps the factor comfortably
 * finite while still being far larger than any real notch (≈ 50 notches spans the
 * whole 1×..50× range in one event), so an extreme notch zooms fully in the
 * CORRECT direction instead of overflowing into a reversed jump (bughunt).
 */
const WHEEL_MAX_NOTCHES = 50;

export interface PointerDispatcherOptions {
  /** Reads the current mode from U20 (called per event — mode is live). */
  readonly getMode: () => EditMode;
  readonly camera: CameraPort;
  readonly hitTester: HitTester;
  readonly selection: SelectionPort;
  /**
   * The U24 edit-session completion-trigger port (受け入れ基準9 / 教訓5.7). Optional:
   * when present, an edit-mode left press drives a U24 handle-drag session and the
   * release runs the confirm trigger (`confirmRelease` → U13). When absent, edit-
   * mode left is U22 selection only (the legacy behaviour) — the dispatcher never
   * silently swallows the confirm path, it simply has no session to drive.
   */
  readonly editSession?: EditSessionPort;
  readonly add: AddPort;
  readonly contextMenu: ContextMenuPort;
  /**
   * 編集中の左ボタンが地図を動かす条件（{@link LeftPanRule}。「選択」「動かす」の道具。押すたびに
   * 読む）。省略 ＝ 動かさない。
   */
  readonly getLeftPan?: () => LeftPanRule;
  /** Zoom clamp range (U16 settings); falls through to U17's FR-10 default. */
  readonly zoomRange?: ZoomRange;
  /**
   * A LIVE zoom-clamp range read on EVERY wheel notch (HB-1 / FR-10). The static
   * {@link zoomRange} above is fixed at construction, so a project-setting change
   * (U39 `supplyZoomRange`) — and the renderer's fit-world floor (`effectiveZoomRange`,
   * Codex medium #6) — would NOT reach the wheel path. When present this getter is
   * preferred so the wheel always clamps against the SAME effective range the
   * renderer draws with (単一の真実源, 教訓 5.29). Returning undefined falls back to
   * the static range, then U17's FR-10 default.
   */
  readonly getZoomRange?: () => ZoomRange | undefined;
  /** Multiplicative zoom factor per wheel notch. Default 1.1 (zoom in on up). */
  readonly wheelZoomFactor?: number;
  /**
   * ホイールの 1 ノッチが届いたことを、**倍率を書く前に** 知らせる口（増分 8E の手直し /
   * G-21）。上下限に着いているのにさらに回したことを、宿主が理由つきで知らせるのに使う。
   * ズームの計算とクランプには関わらない（読むだけ）。
   */
  readonly onWheelZoom?: (direction: 'in' | 'out', zoomBefore: number, range: ZoomRange) => void;
}

/** What kind of sequence a live pointer is driving (single行き先, 受け入れ基準 5). */
type ActiveKind =
  | typeof DISPATCH_TARGET.Pan
  | typeof DISPATCH_TARGET.SelectEdit
  | typeof DISPATCH_TARGET.Add;

/** Per-pointer transient record. Discarded on every teardown path (教訓 5.2). */
interface ActivePointer {
  readonly kind: ActiveKind;
  readonly button: PointerButton;
  /** Press origin in screen px (the click/drag judgement & pan reference base). */
  readonly originX: number;
  readonly originY: number;
  /**
   * Pan reference (only for kind === Pan). 途中でカメラが外から変わると（ホイール・鍵盤の拡大）
   * 付け替える（{@link PointerDispatcher.writePan}）。
   */
  panRef: PanReference | null;
  /** このパンが最後に書いた（または押した瞬間の）カメラ。外からの変更を見分ける。 */
  panCamera: Camera | null;
  /** このパンが最後にカメラへ反映した指の位置。起点を付け替えるときの新しい起点になる。 */
  panPoint: ScreenPoint | null;
  /**
   * The DOM element this pointer was captured on at press (only set for a pan that
   * captured). The dispatcher releases this on EVERY teardown path so capture is
   * never left dangling on a mid-pan abort — esp. when the overlay bridge element
   * unmounts on a tool/mode switch (BUGHUNT2, 教訓 5.2 全経路破棄).
   */
  readonly captureTarget: PointerCaptureTarget | null;
  /**
   * 押した瞬間の修飾キー（裁定 N-4 の「読むだけの左クリックで選ぶ」で使う）。
   * 解放時に読み直さないのは、押している最中の変化で画面と食い違わせないためである。
   */
  readonly modifiers: PointerModifiers;
  /** Whether movement has crossed the drag threshold yet (click vs drag). */
  dragged: boolean;
  /**
   * For a SelectEdit pointer: whether a U24 edit-session was started on press (a
   * handle drag). When true the release MUST fire the U24 completion trigger
   * (受け入れ基準9 / 教訓5.7); when false the gesture is U22 selection only.
   */
  editing: boolean;
}

/**
 * The multiplicative zoom step of ONE wheel notch (zoom in on scroll up). Exported
 * because the keyboard zoom (表示 → 拡大 / 縮小) expresses its own step as an integer
 * number of THESE notches rather than owning a second zoom-rate constant
 * (keyboard-zoom.ts, 単一真実源).
 */
export const WHEEL_ZOOM_FACTOR = 1.1;

export class PointerDispatcher {
  private readonly opts: PointerDispatcherOptions;
  private readonly wheelFactor: number;
  /** Live pointers keyed by pointerId so simultaneous presses never collide. */
  private readonly active = new Map<number, ActivePointer>();

  constructor(opts: PointerDispatcherOptions) {
    this.opts = opts;
    this.wheelFactor = opts.wheelZoomFactor ?? WHEEL_ZOOM_FACTOR;
  }

  /** Whether any pointer is currently driving a pan (test/instrumentation). */
  get isPanning(): boolean {
    for (const p of this.active.values()) {
      if (p.kind === DISPATCH_TARGET.Pan) return true;
    }
    return false;
  }

  /**
   * **頂点・辺・面を掴んだ押下が生きているか**（押した瞬間から離すまで）。店の年の関門が読む
   * （`mount/input.ts`）。しきい値を越えるまで待たない ―― 辺の中点のクリックは動かさずに離しても
   * 記録するので、押した年はここで決まる。地図の移動と矩形選択は記録しないので入らない。
   */
  get holdsEditPress(): boolean {
    for (const p of this.active.values()) {
      if (p.kind === DISPATCH_TARGET.SelectEdit && p.editing) return true;
    }
    return false;
  }

  /** Number of live tracked pointers (受け入れ基準 6 leak-check). */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Whether a select/edit gesture is already in flight on any pointer. Selection
   * and edit are single-pointer gestures backed by a single shared transient in
   * the SelectionPort / EditSessionPort, so a second concurrent select/edit press
   * is gated out (see the SelectEdit branch in {@link pointerDown}).
   */
  private hasActiveSelectEdit(): boolean {
    for (const p of this.active.values()) {
      if (p.kind === DISPATCH_TARGET.SelectEdit) return true;
    }
    return false;
  }

  /**
   * Handle a pointer press. Decides the single行き先 from (mode × button × hit)
   * and starts the matching sequence. A right-button press goes straight to the
   * context-menu port and starts no tracked sequence (no teardown needed).
   *
   * `captureTarget` (optional) is the DOM element to capture the pointer on when
   * the press starts a PAN, so the drag keeps tracking even if the cursor leaves
   * the element mid-drag (受け入れ基準 3 押下→移動→解放の連続保証). The dispatcher
   * performs the capture here and OWNS its release on every teardown path
   * (BUGHUNT2 root: a mid-pan tool/mode abort must release capture BEFORE the
   * overlay bridge element can unmount, not rely on the browser's implicit
   * on-removal release — 教訓 5.2 全経路破棄).
   */
  pointerDown(p: NormalizedPointer, captureTarget?: PointerCaptureTarget): DispatchTarget {
    const mode = this.opts.getMode();
    const point: ScreenPoint = { x: p.x, y: p.y };
    const hit = this.opts.hitTester.hitTest(point);
    const leftPan = this.opts.getLeftPan?.();
    const target = decideDispatch({
      mode,
      button: p.button,
      hit,
      ...(leftPan !== undefined ? { leftPan } : {}),
    });

    switch (target) {
      case DISPATCH_TARGET.Pan: {
        const { camera, viewport } = this.opts.camera.read();
        // Capture the pointer on the supplied element so the pan keeps tracking
        // off-element; remember the element so the dispatcher can release it on any
        // teardown path. The capture is bound to THIS gesture's record (per-pointer).
        const captured = captureTarget ?? null;
        captured?.setPointerCapture(p.pointerId);
        this.active.set(p.pointerId, {
          kind: DISPATCH_TARGET.Pan,
          button: p.button,
          originX: p.x,
          originY: p.y,
          panRef: { camera, viewport, origin: point },
          panCamera: camera,
          panPoint: point,
          captureTarget: captured,
          dragged: false,
          editing: false,
          // 裁定 N-4: 読むだけの左クリック（動かさなかったとき）は選択になる。
          // 押した瞬間の修飾キーをそのまま解放時へ運ぶ ―― 解放時に読み直すと、
          // 押している最中に Shift を離した／足したときに画面と食い違う。
          modifiers: p.modifiers,
        });
        break;
      }
      case DISPATCH_TARGET.SelectEdit: {
        // SINGLE-POINTER GATE (Codex multi-pointer finding, 教訓 5.2 / 5.9):
        // selection / edit is a single-pointer gesture. The SelectionPort and the
        // EditSessionPort each hold ONE press/session transient (a single `pressed`
        // / `session` variable) and take no pointerId. A SECOND simultaneous
        // edit-mode left press would overwrite the first's transient via
        // `selection.start` / `editSession.begin`, and then EITHER pointer's up /
        // cancel would consume the shared transient — finalizing or discarding the
        // wrong gesture (誤確定 / 取りこぼし). So while a select/edit gesture is
        // already in flight, a second one is IGNORED at the source: no port call,
        // no tracked record, so the first pointer's transient stays intact and only
        // its OWN release/cancel touches it. (A concurrent pan is fine — pan is
        // per-pointer and never shares the selection/edit transient.)
        if (this.hasActiveSelectEdit()) {
          return DISPATCH_TARGET.Ignore;
        }
        this.opts.selection.start(hit, point, p.modifiers);
        // Drive the U24 edit-session completion trigger when a handle was hit
        // (受け入れ基準9 / 教訓5.7). `begin` returns true iff this press started a
        // handle-drag session whose release must run `confirmRelease` → U13.
        const editing =
          this.opts.editSession !== undefined &&
          this.opts.editSession.begin(hit, point, p.modifiers);
        this.active.set(p.pointerId, {
          kind: DISPATCH_TARGET.SelectEdit,
          button: p.button,
          originX: p.x,
          originY: p.y,
          panRef: null,
          panCamera: null,
          panPoint: null,
          captureTarget: null,
          dragged: false,
          editing,
          modifiers: p.modifiers,
        });
        break;
      }
      case DISPATCH_TARGET.Add: {
        // Add is a press-only action (point placement); we still track the
        // pointer so a later move/release for the same id is handled coherently,
        // but the add operation itself fires on press.
        this.active.set(p.pointerId, {
          kind: DISPATCH_TARGET.Add,
          button: p.button,
          originX: p.x,
          originY: p.y,
          modifiers: p.modifiers,
          panRef: null,
          panCamera: null,
          panPoint: null,
          captureTarget: null,
          dragged: false,
          editing: false,
        });
        this.opts.add.press(point, hit, p.modifiers);
        break;
      }
      case DISPATCH_TARGET.ContextMenu:
        this.opts.contextMenu.request(point, hit);
        break;
      case DISPATCH_TARGET.Ignore:
        break;
    }
    return target;
  }

  /**
   * Handle a pointer move. Only a tracked pointer drives anything; an untracked
   * move (hover) is ignored. For a pan, computes the new camera against the
   * press-time reference and writes it to U16. Crossing the drag threshold flips
   * the click→drag判定 once (受け入れ基準 4).
   */
  pointerMove(p: NormalizedPointer): void {
    const rec = this.active.get(p.pointerId);
    if (rec === undefined) return;

    if (!rec.dragged && exceedsDragThreshold(rec.originX, rec.originY, p.x, p.y)) {
      rec.dragged = true;
    }

    const point: ScreenPoint = { x: p.x, y: p.y };
    if (rec.kind === DISPATCH_TARGET.Pan) {
      // Only move the camera once the drag threshold is crossed: a sub-threshold
      // wiggle stays a click and leaves the camera still (受け入れ基準 4).
      if (rec.dragged) this.writePan(rec, point);
    } else if (rec.kind === DISPATCH_TARGET.SelectEdit) {
      this.opts.selection.move(point);
      // Feed the same move to the live U24 edit session (transient preview / slide
      // / snap light path) when this press started one (受け入れ基準8 軽量更新).
      if (rec.editing && this.opts.editSession !== undefined) {
        this.opts.editSession.update(point);
      }
    }
    // Add has no move behavior here (placement fired on press).
  }

  /**
   * Handle a pointer release. ALWAYS clears the tracked record (教訓 5.8 / 5.2),
   * for both drag and click paths. A pan click (no threshold crossing) leaves the
   * camera untouched. A select/edit release forwards `end` with the final
   * click/drag judgement so U22 finalizes consistently.
   */
  pointerUp(p: NormalizedPointer): void {
    const rec = this.active.get(p.pointerId);
    if (rec === undefined) return;
    // Drop the record FIRST so any downstream callback cannot observe stale
    // transient state, and so an early return can never skip teardown.
    this.active.delete(p.pointerId);
    // Release any DOM pointer capture this pan held (symmetric with the press-time
    // capture; safe no-op when nothing was captured).
    releasePointerCapture(rec, p.pointerId);

    const point: ScreenPoint = { x: p.x, y: p.y };
    // **離した位置でもう一度しきい値を測り直す**（増分 5 の手直し A8 / GPT #12）。
    //
    // それまでは `pointerMove` が来たときにしか判定していなかったので、**移動の
    // 見本が 1 つも届かない（あるいは間引かれて最後の 1 つが落ちた）まま、押した所と
    // 離れた所が離れている**押下が「クリック」として扱われた。読むだけのときは
    // これがそのまま「離した場所の地物を選ぶ」になり、`dispatch.ts` が書いている
    // 契約（押下から解放までの総移動量で決める）とも食い違う。
    //
    // 判定は 1 方向にしか倒れない（クリック → ドラッグ）ので、ここで測り直しても
    // 「ドラッグだったものがクリックに戻る」ことは無い。
    if (!rec.dragged && exceedsDragThreshold(rec.originX, rec.originY, p.x, p.y)) {
      rec.dragged = true;
      // Pan は「しきい値を越えるまでカメラを動かさない」ので、越えたことがここで
      // 初めて分かった押下は、まだ 1 度もカメラを書いていない。下の確定の枝が
      // 最後の位置を書くので、そこで初めて視点が動く。
    }
    if (rec.kind === DISPATCH_TARGET.Pan) {
      // Finalize: if it was a real drag, write the final position once more so the
      // last sample is never lost; a pure click moves nothing.
      if (rec.dragged) {
        this.writePan(rec, point);
      } else if (rec.button === POINTER_BUTTON.Left) {
        // 左ボタンのパンは、読むだけのときと「選択」の押下、「動かす」の何もないところからの押下だけ
        // （B114 / 裁定 2026-11-01）。どれも、動かさずに離せばここで選択として解決する。
        //
        // **裁定 N-4（2026-09-03）: 読むだけでも地図をクリックして地物を選べる。**
        //
        // 読むだけのときは左ボタンがパンに割り当てられている（`PAN_BUTTONS`）ので、
        // 押した時点では行き先が Pan に決まる。**動かさずに離したとき**だけ、ここで
        // 選択として解決し直す ―― こうすると「左ドラッグで見て回る」を 1 つも損なわずに
        // 「左クリックで選ぶ」を足せる。押下時に行き先を Select へ変えてしまうと、
        // 読むだけの主要な操作であるパンが左ボタンから消える。
        //
        // **選ぶだけで、掴まない。** `editSession.begin` は呼ばない（頂点ハンドルは
        // どちらの局面でも描かれないので掴む対象も無い）。読むだけの素性欄は読めて、直せない。
        const hit = this.opts.hitTester.hitTest(point);
        this.opts.selection.start(hit, point, rec.modifiers);
        this.opts.selection.end(point, false);
      }
    } else if (rec.kind === DISPATCH_TARGET.SelectEdit) {
      this.opts.selection.end(point, rec.dragged);
      // Run the U24 COMPLETION TRIGGER on release for a handle drag (受け入れ基準9 /
      // 教訓5.7): the confirm-time integrity run is reached from real pointer input.
      // ALWAYS runs for both drag and click (教訓5.8); the no-op guard inside U24's
      // confirmRelease (教訓5.24) drops a zero-move click.
      if (rec.editing && this.opts.editSession !== undefined) {
        this.opts.editSession.release(point, rec.dragged);
      }
    }
    // Add: nothing to finalize on release.
  }

  /**
   * Handle pointercancel (or a forced abort for one pointer): discard the
   * transient WITHOUT applying a final move (教訓 5.2). A canceled select/edit is
   * forwarded to U22's cancel so its transient is dropped too.
   */
  pointerCancel(pointerId: number): void {
    const rec = this.active.get(pointerId);
    if (rec === undefined) return;
    this.active.delete(pointerId);
    // Release any DOM pointer capture this pan held (教訓 5.2 全経路破棄).
    releasePointerCapture(rec, pointerId);
    if (rec.kind === DISPATCH_TARGET.SelectEdit) {
      this.opts.selection.cancel();
      if (rec.editing && this.opts.editSession !== undefined) {
        this.opts.editSession.cancel();
      }
    }
  }

  /**
   * **進行中の選択・編集の押下を取り消す**（増分 8A の手直し / 設計書 §E.1 V9「ドラッグ中は
   * Escape で元の位置へ」）。頂点・辺・地物のドラッグも矩形選択も、何も確定せずに捨てる
   * （編集の口は `cancel` ＝下書きを捨てて元の位置で描き直す）。パンは触らない。
   * このあと届く同じポインタの解放は、記録が無いので何もしない。
   * 取り消したものがあれば true（呼び出し側はそのときだけ Escape を食べる）。
   */
  cancelSelectEdit(): boolean {
    let cancelled = false;
    for (const [pointerId, rec] of this.active) {
      if (rec.kind !== DISPATCH_TARGET.SelectEdit) continue;
      this.active.delete(pointerId);
      releasePointerCapture(rec, pointerId);
      this.opts.selection.cancel();
      if (rec.editing && this.opts.editSession !== undefined) {
        this.opts.editSession.cancel();
      }
      cancelled = true;
    }
    return cancelled;
  }

  /**
   * **確認の板が開いた合図を受けて、左の押下で始まった地図の移動を畳む**（B114 の検証）。板の裏で
   * 地図を動かさず、離しても選択を解決せず、板を閉じたあとに同じ押下の続きで動き出さない。あとに届く
   * 同じポインタの合図は、記録が無いので何もしない。
   *
   * 左のパンは押した要素へ入力を捕まえるので、板の覆いが開いても離す合図がここへ届く（捕まえない
   * 押下は覆いへ移った時点で `pointerLeave` が畳む）。中ボタンの移動は畳まない。畳んだものがあれば true。
   */
  foldPressedLeftPans(): boolean {
    let folded = false;
    for (const [pointerId, rec] of this.active) {
      if (rec.kind !== DISPATCH_TARGET.Pan || rec.button !== POINTER_BUTTON.Left) continue;
      this.active.delete(pointerId);
      releasePointerCapture(rec, pointerId);
      folded = true;
    }
    return folded;
  }

  /**
   * The pointer left the map area (pointerleave). Treated like a cancel for every
   * live pointer so a pan/selection can never be left dangling when the cursor
   * exits (教訓 5.2, 受け入れ基準 6). Does NOT apply a final camera move.
   */
  pointerLeave(): void {
    this.abortAll();
  }

  /**
   * Mode changed (U20). Any in-progress interaction is abandoned so a stale pan
   * reference or selection from the previous mode cannot bleed into the new mode
   * (教訓 5.2 / 5.5, 受け入れ基準 6). The camera is left where it is.
   */
  onModeChange(): void {
    this.abortAll();
  }

  /**
   * Handle a wheel event: cursor-anchored zoom in EVERY mode (FR-09). The new
   * camera (cursor invariant + clamp) is computed by U17's `zoomStepAtCursor`;
   * this unit only supplies the cursor + step direction and writes the result to
   * U16 — no zoom/clamp math here (受け入れ基準 2).
   */
  wheel(w: NormalizedWheel): void {
    // A zero (or non-finite) delta is NOT a zoom: some trackpads/devices fire
    // deltaY === 0 events, and the old sign-only branch treated those as zoom-OUT
    // (Codex medium #5). No-op so an idle wheel event never moves the camera.
    if (!Number.isFinite(w.deltaY) || w.deltaY === 0) return;

    // Normalize line/page deltas to a comparable pixel magnitude (deltaMode) so the
    // zoom rate is device-consistent; then scale the factor by the magnitude instead
    // of applying a constant step, so tiny trackpad deltas zoom slowly and a single
    // big notch is not amplified into a redraw storm (Codex medium #5).
    const pxPerUnit =
      w.deltaMode === 1 ? WHEEL_LINE_PX : w.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const normalizedPx = w.deltaY * pxPerUnit;
    // deltaY < 0 (scroll up) → zoom IN (factor > 1); > 0 → zoom OUT (factor < 1).
    // `wheelFactor ** (-notches)` ⇒ a ~100px notch reproduces the old one-step
    // feel, smaller deltas a proportionally smaller step. Saturate the per-event
    // notch count to ±WHEEL_MAX_NOTCHES FIRST so an extreme deltaY (esp. after the
    // ×800 page / ×16 line normalization) can never overflow the factor to
    // ±Infinity — which would push a non-finite zoom into the clamp and (formerly)
    // reverse an extreme zoom-IN into a full zoom-OUT (bughunt). Sign is preserved,
    // so the direction is always honoured.
    const notches = -normalizedPx / WHEEL_NOTCH_PX;
    const saturated = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, notches));
    const factor = Math.pow(this.wheelFactor, saturated);

    const { camera, viewport } = this.opts.camera.read();
    const cursor: ScreenPoint = { x: w.x, y: w.y };
    // Prefer the LIVE effective range (project-setting clamp + renderer fit-world
    // floor) so a settings change / fit floor reaches the wheel; fall back to the
    // static option, then U17's FR-10 default (受け入れ基準 2, 単一の真実源).
    const range = this.opts.getZoomRange?.() ?? this.opts.zoomRange;
    if (range !== undefined) this.opts.onWheelZoom?.(factor > 1 ? 'in' : 'out', camera.zoom, range);
    const next = zoomStepAtCursor(camera, viewport, cursor, factor, range);
    this.opts.camera.write(next);
  }

  /**
   * パンの続きをカメラへ書く。**起点は押した瞬間のカメラだが、途中でカメラが外から変わったら
   * （ホイール・鍵盤の拡大・全体表示）いまのカメラと最後に反映した指の位置へ付け替える。** 押した
   * 瞬間のカメラを持ち続けると、次の移動で倍率と位置がそこへ戻る。変わっていなければ付け替えない
   * ので、長いドラッグで誤差を積まない（受け入れ基準 4）。
   */
  private writePan(rec: ActivePointer, point: ScreenPoint): void {
    if (rec.panRef === null || rec.panPoint === null) return;
    const { camera, viewport } = this.opts.camera.read();
    if (!sameCamera(camera, rec.panCamera)) {
      rec.panRef = { camera, viewport, origin: rec.panPoint };
    }
    this.opts.camera.write(panCameraTo(rec.panRef, point));
    // 読み直す: 書く側が丸めた値（緯度の上下限など）を「外からの変更」と読まないため。
    rec.panCamera = this.opts.camera.read().camera;
    rec.panPoint = point;
  }

  /** Drop EVERY live pointer's transient (the shared全経路破棄 helper, 教訓 5.2). */
  private abortAll(): void {
    let hadSelectEdit = false;
    let hadEditSession = false;
    for (const [pointerId, rec] of this.active) {
      if (rec.kind === DISPATCH_TARGET.SelectEdit) {
        hadSelectEdit = true;
        if (rec.editing) hadEditSession = true;
      }
      // BUGHUNT2 root: release the DOM pointer capture this pan held BEFORE the
      // captured element (e.g. the overlay input bridge) can unmount on the
      // tool/mode switch that triggered this abort — so a mid-pan switch never
      // leaves capture dangling on a vanishing element (was: relied on the
      // browser's implicit on-removal release / the eventual pointerup).
      releasePointerCapture(rec, pointerId);
    }
    this.active.clear();
    if (hadSelectEdit) this.opts.selection.cancel();
    // Discard any live U24 edit-session transient too (教訓5.2 全経路破棄).
    if (hadEditSession && this.opts.editSession !== undefined) {
      this.opts.editSession.cancel();
    }
  }

  /** Build a {@link NormalizedPointer} from a DOM PointerEvent (接着層 helper). */
  static normalize(
    e: Pick<
      PointerEvent,
      'pointerId' | 'button' | 'buttons' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
    >,
    x: number,
    y: number,
    forMove = false,
  ): NormalizedPointer {
    // For a move event the `button` field is -1; the held button lives in the
    // `buttons` bitmask. We surface the down/up button directly and, for moves,
    // derive the primary held button so the tracked record (not the event) is the
    // source of行き先 — moves only update an already-decided sequence.
    const button = forMove
      ? pointerButtonFromCode(buttonFromButtonsMask(e.buttons))
      : pointerButtonFromCode(e.button);
    return {
      pointerId: e.pointerId,
      x,
      y,
      button,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    };
  }
}

function sameCamera(a: Camera, b: Camera | null): boolean {
  return (
    b !== null && a.centerLon === b.centerLon && a.centerLat === b.centerLat && a.zoom === b.zoom
  );
}

/**
 * Release the DOM pointer capture an {@link ActivePointer} pan held, if any.
 * Defensive: the capture may already be gone (browser auto-released it, or the
 * element was removed), so a throw from `releasePointerCapture` (e.g. an invalid
 * pointerId after implicit release) is swallowed — the goal is only to ensure the
 * dispatcher never LEAVES a capture dangling, never to assert one still exists.
 */
function releasePointerCapture(rec: ActivePointer, pointerId: number): void {
  if (rec.captureTarget === null) return;
  try {
    rec.captureTarget.releasePointerCapture(pointerId);
  } catch {
    // Already released / element detached — nothing to clean up.
  }
}

/**
 * Map a `PointerEvent.buttons` bitmask to a representative `button` code (0/1/2)
 * for move events. Bit 0 = left(0), bit 1 = right(2), bit 2 = middle(1). Returns
 * -1 (→ Other) when no relevant button is held. Pure helper.
 */
export function buttonFromButtonsMask(buttons: number): number {
  if ((buttons & 1) !== 0) return 0; // left
  if ((buttons & 4) !== 0) return 1; // middle
  if ((buttons & 2) !== 0) return 2; // right
  return -1;
}
