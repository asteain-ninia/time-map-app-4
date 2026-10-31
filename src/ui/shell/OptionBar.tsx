// UI layer (U20 / shell): the option bar — the tool's own row (設計書 §C.4 / §B.4).
//
// 「いま持っている道具の、いまの状況」を 1 行で見せる帯。5 区画（道具名 112 / 対象 240 /
// 次の一手 1fr / 設定 可変 / 確定 176）の**器だけ**をここが持ち、中身は道具の実装が
// {@link OptionBarStore} の 4 本の API で押し込む。
//
// **地図セルの外のシェル行である**（K-4 / 結合点 #1）。地図セルの DOM の入れ子
// （`map-area > map-canvas-mount + map-input-layer`）に一切触れないので、`onMapMount` の
// `querySelector` も `data-zoom` / `data-pan-x` / `data-pan-y` の取り付け先（T-3）も
// 崩さない。地図に重なる部品ではないので K-2 の事故（クリックを奪う）も構造的に起きない。
//
// **確定ボタンはここに置く**（U-10。位置は地図下端中央から移すが「全ツールで同じ場所」
// は守る）。地図の中に確定ボタンを置かないのが K-2 に対する構造的な答えである。
//
// --- 設定欄の畳み「≫」（増分 5 の手直し D3 / 設計書 §B.4）-----------------------
//
// 窓幅が狭いと設定欄に部品が入り切らず、**右から順に切り落とされて「表示 ▾」に手が
// 届かなくなっていた**（設定欄は `overflow: hidden` なので、切れていることすら見えない）。
// 設計書 §B.4 の畳み表が言う「設定の一部を『≫』へ」を実装する。
//
// **入るかどうかは実測で決める。** CSS だけでは決められない ―― 部品の幅は中身の文字数で
// 変わるし、`.option-bar__settings` の幅は「次の一手」の長さにも左右される。したがって
// 器の幅と各部品の幅を実際に測り、入り切らないぶんを「≫」へ送る。
//
// **測れないときは全部そのまま出す。** jsdom はレイアウトを計算せず幅が全部 0 になる
// （開発ガイド §5.49）ので、0 を「入らない」と読むと単体テストの世界で部品が全部
// 「≫」の中へ消えてしまう。幅 0 は「まだ分からない」であって「狭い」ではない。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { OPTION_BAR_STRINGS } from './strings';
import type { OptionBarSlot, OptionBarState, OptionBarStore } from './option-bar';


/** 設定欄の部品どうしのすき間（`shell.css` の共有規則の `gap: 6px` と同じ値）。 */
const SETTINGS_GAP = 6;
/** 「≫」がまだ描かれていなくて実測できないときに見込む幅。 */
const OVERFLOW_BUTTON_FALLBACK_WIDTH = 30;
/** 小数の丸めで 1px 足りずに 1 個落ちるのを防ぐ余裕。 */
const FIT_TOLERANCE = 0.5;
/**
 * 測り直しの打ち止め。器の幅は中身の量に左右される（`flex: 0 1 auto`）ので、
 * 「隠す → 器が縮む → もっと隠す」と数回ぶんは往復しうる。往復は必ず収束する
 * （隠す数が増えると器は狭くなる一方なので単調で、循環しない）が、将来 CSS を
 * 変えたときに無限に測り直すことがないよう上限を切っておく。
 *
 * **数えるのは 1 回の測定の連鎖だけ**（自分が置き場を変えた再描画で続く測り直し）。中身や親の
 * 再描画など外から来た測り直しは新しい測定として 0 から数える。持ち越すと、測量の入り切りを
 * 6 回繰り返したところで上限に達し、「表示 ▾」が「≫」に残ったまま戻らなくなる。
 */
const MEASURE_STEP_LIMIT = 12;

/** 画面の端からの余白（`OptionPopover` と同じ値）。 */
const VIEWPORT_MARGIN = 8;
/** アンカーとパネルのすき間（`OptionPopover` と同じ値）。 */
const ANCHOR_GAP = 4;

/**
 * **設定欄に配れる幅**（増分 5 の手直し D3 の直し ＋ 2 回目の手直し）。
 *
 * **設定欄自身の `clientWidth` を測ってはいけない。** 設定欄は幅が中身の量で決まるので、
 * 部品を「≫」へ送ると器も縮み、縮んだ器で測り直すともっと送ることになり、**入るはずの
 * ものまで全部が「≫」の中へ落ちる**（教訓 5.69。実測: 測量を ON にすると読み取りが
 * 丸ごと畳まれ、測っているのに距離が読めなくなった）。
 *
 * だから **中身に依らない予算**を計算する: 帯の内寸から、幅の決まっている 3 区画
 * （道具名・対象・確定）と部品どうしのすき間、そして「次の一手」に必ず残す幅を引く。
 * 引き算の材料はどれも中身で動かないので、送る数が増えても予算は変わらない（収束する）。
 *
 * **予算は「見込み」ではなく「本当にその幅になる」ことまで面倒を見る**（2 回目の手直し）。
 * 1 回目は予算を出すだけで、設定欄の実寸は flex の配分に任せていた ―― 「次の一手」は
 * `flex: 1 1 auto` なので、あふれたときは **基準幅に比例して**縮む。実測 1120px では
 * 「次の一手」が 160px の見込みに対して 189〜204px を取り、設定欄は予算より 36px 狭く
 * なって、いちばん右の「≫」が欄の外へこぼれた（`overflow: hidden` なので見えない
 * ＝ 格子・深さに手が届かない）。いまは **設定欄を縮まない区画にして
 * （`shell.css` の `flex: 0 0 auto`）、この予算を `max-width` として実際に嵌める** ――
 * 中身は必ず予算の内側に収まり、余りは「次の一手」が受け取る。
 */
function settingsBudget(settings: HTMLElement): number {
  const bar = settings.parentElement;
  if (bar === null) return 0;
  // 値が読めない環境（レイアウトを計算しない）は 0 として扱う ―― 下の「0 なら
  // 全部そのまま出す」に落ちる。
  const px = (value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  const barStyle = getComputedStyle(bar);
  const inner = bar.clientWidth - px(barStyle.paddingLeft) - px(barStyle.paddingRight);
  if (inner <= 0) return 0;
  const gap = px(barStyle.columnGap === '' ? barStyle.gap : barStyle.columnGap);
  let fixed = 0;
  for (const key of ['tool', 'target', 'commit'] as const) {
    const el = bar.querySelector<HTMLElement>(`.option-bar__${key}`);
    if (el !== null) fixed += el.getBoundingClientRect().width;
  }
  // 帯の 5 区画のあいだのすき間は 4 つ。
  return inner - fixed - gap * 4 - NEXT_STEP_RESERVE;
}

/**
 * 「次の一手」に必ず残す幅。**案内の文は設定欄より優先する** ―― 次に何をすればよいか
 * 分からない画面より、設定が「≫」の中にある画面のほうがまだましだからである。
 */
const NEXT_STEP_RESERVE = 160;

/**
 * 設定欄の下限（`shell.css` の `.option-bar__settings` の `min-width` と同じ値）。
 *
 * 予算がこれを下回る窓幅では、CSS の下限が勝って設定欄はこの幅になる。畳む判断も
 * その幅で行わないと **入るものまで畳んでしまう**ので、予算の下限として使う。
 * **同じ値が 2 か所にあるのは承知のうえ**である ―― 片方は CSS の宣言、片方は測り方で、
 * 値を変えるときは両方を直すこと（`shell.css` 側の注記にも同じ断りを書いた）。
 */
const SETTINGS_MIN_WIDTH = 136;

/**
 * 「≫」の中の部品の幅を控える。閉じた板は `display: none` で幅が測れないので、描く前の同じ
 * 処理の中でだけ `hidden` を外し、見えないまま測って戻す（画面には出ない。入力も奪わない）。
 */
function measureOverflowSlots(
  panel: HTMLDivElement | null,
  widths: Map<string, number>,
): void {
  if (panel === null) return;
  const closed = panel.hidden;
  if (closed) {
    panel.hidden = false;
    panel.style.visibility = 'hidden';
  }
  for (const el of Array.from(panel.querySelectorAll<HTMLElement>('[data-overflow-slot-id]'))) {
    const id = el.dataset['overflowSlotId'];
    if (id !== undefined) widths.set(id, el.getBoundingClientRect().width);
  }
  if (closed) {
    panel.style.removeProperty('visibility');
    panel.hidden = true;
  }
}

export interface OptionBarProps {
  readonly store: OptionBarStore;
  /**
   * 「≫」を開いた／閉じたことの報せ（増分 5 の手直し D3 / 設計書 §D.1 の「鍵盤の
   * 持ち主」）。開いているあいだは鍵盤の持ち主がポップオーバーになるので、呼び出し側が
   * `focusOwner` を 1 か所で導出できるように口だけ開けておく。
   */
  readonly onOverflowOpenChange?: (open: boolean) => void;
}

export function OptionBar(props: OptionBarProps): JSX.Element {
  const { store, onOverflowOpenChange } = props;
  const state: OptionBarState = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => store.get(),
  );

  const target = state.target;
  const slots = state.slots;
  // スロットの顔ぶれ（並び順込み）の指紋。変わったら測り直す。
  const slotsKey = slots.map((s) => s.id).join('');

  // --- 設定欄の畳み（実測）-------------------------------------------------
  //
  // `visibleCount === null` は「測れていない ＝ 全部そのまま出す」。数値なら
  // 「先頭から数えてこの数だけ帯に出し、残りは『≫』へ送る」。
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 部品ごとの実測幅。帯に出ている部品も「≫」の中の部品も、測るたびに測り直す。 */
  const widthsRef = useRef<Map<string, number>>(new Map());
  const slotsRef = useRef<readonly OptionBarSlot[]>(slots);
  slotsRef.current = slots;
  const lastAvailRef = useRef<number>(-1);
  const stepsRef = useRef(0);
  /** 次の測り直しが、自分の `setVisibleCount` の再描画で呼ばれる印（連鎖の続きかどうか）。 */
  const chainedRef = useRef(false);
  const visibleCountRef = useRef<number | null>(visibleCount);
  visibleCountRef.current = visibleCount;

  // 顔ぶれが変わったら、いったん全部出して測り直す（控えた幅も捨てる）。
  useLayoutEffect(() => {
    widthsRef.current = new Map();
    lastAvailRef.current = -1;
    stepsRef.current = 0;
    setVisibleCount(null);
  }, [slotsKey]);

  const measure = useCallback(() => {
    // 自分が置き場を変えた再描画の続きでなければ、新しい測定として数え直す。
    if (chainedRef.current) chainedRef.current = false;
    else stepsRef.current = 0;

    const box = settingsRef.current;
    if (box === null) return;

    /** 置き場を変える（同じなら何もしない）。変えたぶんだけ連鎖の回数を数える。 */
    const placeCount = (next: number | null): void => {
      if (visibleCountRef.current === next) return;
      stepsRef.current += 1;
      chainedRef.current = true;
      setVisibleCount(next);
    };

    // 出ている部品の実測幅を控える（次に隠したあとも、この値で判断できる）。
    //
    // **幅 0 も控える。** `data-slot-id` を持つのは **帯に出ている**部品だけで、「≫」へ
    // 送ったぶんはこの走査に現れない（あちらの span には `data-slot-id` を付けていない）。
    // だから「幅 0 は測れなかった値」ではなく、**中身が空の部品**である ―― 測量の
    // 読み取りは測っていないあいだ何も描かないので、まさにこれに当たる。0 を控えないと
    // 下の「まだ測れていない部品があるうちは判断しない」で永久に止まり、**畳みが
    // 1 度も働かなくなる**（実際にこれで測量 OFF のとき「≫」が出なかった）。
    for (const el of Array.from(box.querySelectorAll<HTMLElement>('[data-slot-id]'))) {
      const id = el.dataset['slotId'];
      if (id !== undefined) widthsRef.current.set(id, el.getBoundingClientRect().width);
    }
    // **「≫」の中の部品も測り直す**（B103）。部品の幅は顔ぶれが同じでも中身で変わる ―― 測量の
    // 読み取りは測っている間だけ幅を持つ。控えた幅のままだと、測量を切って空になった読み取りが
    // 測っていた時の幅のまま「入らない」と読まれ、800×600 で「表示 ▾」まで「≫」に残り続けた。
    measureOverflowSlots(panelRef.current, widthsRef.current);

    const ids = slotsRef.current.map((s) => s.id);
    const raw = settingsBudget(box);
    // **測れない（幅 0）ときは全部そのまま出す**（jsdom / まだ描かれていない）。
    // 嵌めた `max-width` も外す ―― 測れない環境で幅を縛ると、中身が理由なく切れる。
    if (raw <= 0 || ids.length === 0) {
      box.style.removeProperty('max-width');
      setVisibleCount(null);
      return;
    }
    // 予算が CSS の下限を下回る窓幅では、下限のほうが勝って設定欄はその幅になる。
    // 畳む判断も実際になる幅で行う（下回る予算で畳むと、入るものまで畳んでしまう）。
    const avail = Math.max(raw, SETTINGS_MIN_WIDTH);
    // **予算をそのまま嵌める。** 設定欄は縮まない区画（`flex: 0 0 auto`）なので、
    // これで中身は必ず予算の内側に収まり、余りは「次の一手」が受け取る。
    box.style.maxWidth = `${String(avail)}px`;
    // まだ 1 度も測れていない部品があるうちは判断しない（全部出したまま次の測りを待つ）。
    if (ids.some((id) => !widthsRef.current.has(id))) return;

    // 器の幅が変わったら往復の数え直し（新しい窓幅で測り直す）。
    if (Math.abs(avail - lastAvailRef.current) > FIT_TOLERANCE) {
      lastAvailRef.current = avail;
      stepsRef.current = 0;
    } else if (stepsRef.current >= MEASURE_STEP_LIMIT) {
      return;
    }

    const widths = ids.map((id) => widthsRef.current.get(id) ?? 0);
    const totalAll =
      widths.reduce((a, b) => a + b, 0) + SETTINGS_GAP * Math.max(0, ids.length - 1);
    if (totalAll <= avail + FIT_TOLERANCE) {
      placeCount(null);
      return;
    }

    // 入り切らない。「≫」ぶんの幅を先に取り置いてから、前から順に詰める。
    const buttonWidth = overflowButtonRef.current?.getBoundingClientRect().width ?? 0;
    let used = buttonWidth > 0 ? buttonWidth : OVERFLOW_BUTTON_FALLBACK_WIDTH;
    let fit = 0;
    for (const width of widths) {
      const next = used + SETTINGS_GAP + width;
      if (next > avail + FIT_TOLERANCE) break;
      used = next;
      fit += 1;
    }
    placeCount(fit);
  }, []);

  // **毎レンダーのあとに測る。** 隠した結果で器の幅が変わるので、1 回では決まらない
  // （同じ値なら React が再レンダーしないので、そこで止まる）。
  useLayoutEffect(measure);

  // 窓幅が変わったときの測り直し。`ResizeObserver` が無い環境（レイアウトを計算しない
  // テスト環境）でも落ちないように、存在を確かめてから使う。
  //
  // **見張るのは帯そのもの**であって設定欄ではない。設定欄には下限（`min-width`）が
  // あるので、**畳んだあとは窓幅を変えても設定欄の幅が動かない** ―― そこを見張ると
  // 通知が二度と来ず、**一度畳んだら二度と戻らない**（実測: 1920px まで広げても
  // 「表示 ▾」が「≫」の中に居座った）。帯の幅は窓幅にそのまま追随する。
  useEffect(() => {
    const bar = settingsRef.current?.parentElement ?? null;
    if (bar === null) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    return () => {
      ro.disconnect();
    };
  }, [measure]);

  const shownSlots = visibleCount === null ? slots : slots.slice(0, visibleCount);
  const overflowSlots = visibleCount === null ? [] : slots.slice(visibleCount);
  const hasOverflow = overflowSlots.length > 0;

  // --- 「≫」のポップオーバー -----------------------------------------------
  //
  // `OptionPopover` と同じ作法（`position: fixed` で置く・`[hidden]` の打ち消しを CSS に
  // 併記する＝開発ガイド §5.56・背面に板を置かない＝K-2・文書の押下と Escape で閉じる）。
  // **共通の器そのものは使えない** ―― `OptionPopover` はアンカーの文字のうしろに「▾」を
  // 必ず付けるので、「≫」が「≫ ▾」になってしまう。
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const panelId = useId();

  const closeOverflow = useCallback(() => {
    setOverflowOpen(false);
  }, []);

  // 送るものが無くなったら閉じる（窓を広げた・道具が変わった）。
  useEffect(() => {
    if (!hasOverflow) setOverflowOpen(false);
  }, [hasOverflow]);
  useEffect(() => {
    setOverflowOpen(false);
  }, [slotsKey]);

  // 開閉の報せ。ref 越しに読むのは `OptionPopover` と同じ理由（毎レンダー新しい関数を
  // 渡されても登録し直しが起きないように）。部品ごと消えるときも閉じたことにする。
  const openChangeRef = useRef(onOverflowOpenChange);
  openChangeRef.current = onOverflowOpenChange;
  useEffect(() => {
    openChangeRef.current?.(overflowOpen);
  }, [overflowOpen]);
  useEffect(
    () => () => {
      openChangeRef.current?.(false);
    },
    [],
  );

  // 開いた直後に、アンカーの矩形と実寸から置き場所を決める。
  useLayoutEffect(() => {
    if (!overflowOpen) return;
    const anchor = overflowButtonRef.current;
    const panel = panelRef.current;
    if (anchor === null || panel === null) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - p.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(a.left, VIEWPORT_MARGIN), maxLeft);
    const below = a.bottom + ANCHOR_GAP;
    const top =
      below + p.height + VIEWPORT_MARGIN <= window.innerHeight
        ? below
        : Math.max(VIEWPORT_MARGIN, a.top - p.height - ANCHOR_GAP);
    setPanelPos((prev) =>
      prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [overflowOpen, overflowSlots.length]);

  // 閉じる契機: 外を押す／Escape。**背面を覆う板は置かない**（K-2）。
  useEffect(() => {
    if (!overflowOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target_ = e.target;
      if (!(target_ instanceof Node)) return;
      if (panelRef.current?.contains(target_) === true) return;
      if (overflowButtonRef.current?.contains(target_) === true) return;
      closeOverflow();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      closeOverflow();
      overflowButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [overflowOpen, closeOverflow]);

  return (
    <div
      className="option-bar"
      role="toolbar"
      aria-label={OPTION_BAR_STRINGS.ariaLabel}
      data-testid="option-bar"
    >
      <div className="option-bar__tool" data-testid="option-bar-tool">
        {state.toolName ?? OPTION_BAR_STRINGS.defaultToolName}
      </div>

      <div className="option-bar__target" data-testid="option-bar-target">
        {target.stage !== null && (
          <span className="option-bar__stage" data-testid="option-bar-stage">
            {target.stage}
          </span>
        )}
        {target.name !== null ? (
          <span className="option-bar__target-name">{target.name}</span>
        ) : (
          <span className="option-bar__muted">{OPTION_BAR_STRINGS.noTarget}</span>
        )}
      </div>

      <div className="option-bar__next" data-testid="option-bar-next-step">
        {/* **全文を `title` にも持たせる**（増分 8C）。この欄は縮む役なので、1280px の窓では
            文が「…」で切れる（測るの「測っている間は地物を選べません」は後半ごと切れていた）。
            指を載せれば切れた後ろまで読める。 */}
        <span
          className="option-bar__next-text"
          title={state.nextStep ?? OPTION_BAR_STRINGS.defaultNextStep}
        >
          {state.nextStep ?? OPTION_BAR_STRINGS.defaultNextStep}
        </span>
        {/* 次の一手を **押せる形**で置く口（手直し E1 / 設計書 §H.5）。 */}
        {state.nextStepActions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="option-bar__next-action"
            data-testid={`option-bar-next-action-${action.id}`}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="option-bar__settings" data-testid="option-bar-settings" ref={settingsRef}>
        {slots.length === 0 ? (
          <span className="option-bar__muted">{OPTION_BAR_STRINGS.noSettings}</span>
        ) : (
          <>
            {shownSlots.map((slot) => (
              <span
                key={slot.id}
                className="option-bar__slot"
                data-slot-id={slot.id}
                data-testid={`option-slot-${slot.id}`}
              >
                {slot.node}
              </span>
            ))}
            {hasOverflow && (
              <button
                type="button"
                ref={overflowButtonRef}
                className="option-bar__overflow-button"
                data-testid="option-bar-overflow"
                aria-label={OPTION_BAR_STRINGS.overflowAriaLabel}
                aria-expanded={overflowOpen}
                aria-haspopup="dialog"
                aria-controls={panelId}
                onClick={() => setOverflowOpen((v) => !v)}
              >
                {OPTION_BAR_STRINGS.overflowLabel}
              </button>
            )}
          </>
        )}
      </div>

      {/* 「≫」の中身。**要素は消さずに `hidden` で閉じる**（開くたびに矩形を測り直さない
          ため）。`[hidden]` の打ち消しは `shell.css` に併記してある ―― 書き忘れると
          閉じているのに画面左上に居座って下のクリックを奪う（開発ガイド §5.56 / K-2）。
          **`data-testid` は帯に出ているときと同じ `option-slot-<id>` のまま**である
          （T-1: 置き場が変わっても役割は同じ）。 */}
      {hasOverflow && (
        <div
          id={panelId}
          ref={panelRef}
          className="option-bar__overflow-panel"
          data-testid="option-bar-overflow-panel"
          role="dialog"
          aria-label={OPTION_BAR_STRINGS.overflowPanelAriaLabel}
          hidden={!overflowOpen}
          style={panelPos === null ? undefined : { left: panelPos.left, top: panelPos.top }}
        >
          {overflowSlots.map((slot) => (
            <span
              key={slot.id}
              className="option-bar__slot"
              data-overflow-slot-id={slot.id}
              data-testid={`option-slot-${slot.id}`}
            >
              {slot.node}
            </span>
          ))}
        </div>
      )}

      {/* 確定欄: 確定の要らない道具のときも空の 176px として残す（K-3, 設計書 §B.4）。 */}
      <div className="option-bar__commit" data-testid="option-bar-commit">
        {state.commit.map((button) => (
          <button
            key={button.id}
            type="button"
            className="option-bar__commit-button"
            data-testid={button.testId ?? `option-bar-commit-${button.id}`}
            disabled={button.disabled ?? false}
            onClick={button.onClick}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}
