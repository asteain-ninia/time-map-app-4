// UI layer (U20 / shell): オプションバーの「◯◯ ▾」ポップオーバーの **共通の器**
// （設計書 §B.5 の台帳 #5 / §C.4 の設定欄）。
//
// **なぜ共通の器を作るのか**: 増分 3 の「吸着 ▾」と増分 4 の「表示 ▾」は、同じ作法
// （`position: fixed` で置く・`[hidden]` の打ち消しを必ず書く・背面に板を置かない・
// 文書の押下と Escape で閉じる・状態が移ったら閉じる）を **それぞれ自分の中に写して**
// いた。増分 5 で「深さ ▾」「経度 ▾」がさらに 2 つ増えるので、写しを 4 枚にすると
// 教訓 5.44（共通ロジックの写しが残ると経路によって新旧が混ざる）と教訓 5.56
// （`[hidden]` の打ち消しを 1 枚でも書き忘れると、閉じているのに下のクリックを奪う）
// の両方を確実に踏む。**器を 1 つにして、中身だけを渡す形にする。**
//
// **守っている作法**（増分 3 で実際に事故を出した順に）:
//   1. **`position: fixed` でアンカーの矩形から座標を出す。** 帯は `overflow: hidden`
//      なので、帯の子として下へ伸ばすと切れる。
//   2. **`[hidden]` の打ち消しを CSS に必ず書く**（`.foo__panel[hidden] { display: none }`）。
//      クラスの `display` は属性セレクタに勝つので、書かないと閉じているのに画面左上に
//      居座り、下のボタンのクリックを奪う（教訓 5.56 / K-2）。**要素は消さずに残す** ――
//      消すと開くたびに矩形の計算がやり直しになる。
//   3. **背面を覆う板を置かない**（K-2 / 教訓 5.14）。閉じるのは文書全体の `pointerdown`
//      を捕捉段で聞く形にする。
//   4. **状態が移ったら閉じる**（K-5）。道具・モード・時刻・プロジェクトが変わったら
//      黙って閉じる ―― 中身が古いまま開き続けるのを防ぐ。
//   5. **開閉を呼び出し側へ報せる**（`onOpenChange`）。鍵盤の持ち主（`focusOwner` の
//      `popover`）を App が 1 か所で導出できるようにするため（設計書 §D.1 / 結合点 #5）。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** 画面の端からの余白（増分 3 の `SnapOptions` と同じ値）。 */
const VIEWPORT_MARGIN = 8;
/** アンカーとパネルのすき間。 */
const ANCHOR_GAP = 4;

export interface OptionPopoverRenderContext {
  /** いま開いているか（中身を開いている間だけ数え直したいときに使う）。 */
  readonly open: boolean;
  /** 中身から閉じる（「閉じる」ボタン・確定後など）。 */
  readonly close: () => void;
}

export interface OptionPopoverProps {
  /** アンカーの文字（▾ はこの部品が付ける）。 */
  readonly label: string;
  /** アンカーの `data-testid`。 */
  readonly buttonTestId: string;
  /** パネルの `data-testid`。 */
  readonly panelTestId: string;
  /** アンカーの class（既存のポップオーバーの見た目をそのまま持ち越すため）。 */
  readonly buttonClassName: string;
  /** パネルの class。**`[hidden]` の打ち消しを必ず CSS に書くこと**（上の作法 2）。 */
  readonly panelClassName: string;
  /** パネルの読み上げ名。 */
  readonly ariaLabel: string;
  /**
   * **状態の指紋**。この値が変わったら開いているパネルを閉じる（作法 4）。
   * 呼び出し側が「何が変わったら閉じるか」を決める ―― 道具・モード・時刻・
   * プロジェクトの識別子を 1 本の文字列に畳んで渡すのがふつう。
   */
  readonly closeKey: string;
  /**
   * **置き場所を計算し直す契機**。中身の高さが変わる（行が増える）ときに渡す。
   * 既定（省略）では開いた瞬間にだけ測る。
   */
  readonly measureKey?: unknown;
  /** 開閉の報せ（`focusOwner` の導出に使う）。 */
  readonly onOpenChange?: (open: boolean) => void;
  /** パネルの中身。 */
  readonly children: (ctx: OptionPopoverRenderContext) => ReactNode;
}

export function OptionPopover(props: OptionPopoverProps): JSX.Element {
  const {
    label,
    buttonTestId,
    panelTestId,
    buttonClassName,
    panelClassName,
    ariaLabel,
    closeKey,
    measureKey,
    onOpenChange,
    children,
  } = props;

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // 開閉を呼び出し側へ報せる。**部品ごと消えるときも閉じたことにする** ―― 開いたまま
  // 消えると、`focusOwner` が `popover` のまま固まって鍵盤が戻らない（K-5）。
  //
  // 報せ口は ref 越しに読む。**後片付けの登録し直しを避けるため**である ―― 依存に
  // 関数そのものを入れると、呼び出し側が毎レンダー新しい関数を渡した瞬間に
  // 「後片付け（false を送る）→ 登録」が毎回走り、開いているのに false が流れる。
  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;
  useEffect(() => {
    openChangeRef.current?.(open);
  }, [open]);
  useEffect(
    () => () => {
      openChangeRef.current?.(false);
    },
    [],
  );

  // 開いた直後に、アンカーの矩形と実寸から置き場所を決める（作法 1）。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
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
    setPosition((prev) =>
      prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [open, measureKey]);

  // 閉じる契機（作法 3）: 外を押す／Escape。**バックドロップは置かない**（K-2）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panel?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  // 状態が移ったら閉じる（作法 4 / K-5）。
  const closeKeyRef = useRef(closeKey);
  useEffect(() => {
    const prev = closeKeyRef.current;
    closeKeyRef.current = closeKey;
    if (!open) return;
    if (prev === closeKey) return;
    close();
  }, [open, closeKey, close]);

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={buttonClassName}
        data-testid={buttonTestId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {label} ▾
      </button>
      <div
        id={panelId}
        ref={panelRef}
        className={panelClassName}
        data-testid={panelTestId}
        role="dialog"
        aria-label={ariaLabel}
        hidden={!open}
        style={position === null ? undefined : { left: position.left, top: position.top }}
      >
        {children({ open, close })}
      </div>
    </>
  );
}
