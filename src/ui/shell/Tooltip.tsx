// UI layer (U20 / shell): the shared tooltip primitive (FR-112 / FR-115).
//
// A common操作ガイド tooltip for toolbar buttons and menu items. Japanese text
// is supplied by the caller from the centralised strings module (strings.ts).
// The tooltip surfaces on hover/focus via the native `title` and an aria
// description, and renders an explicit bubble on hover so the guide text is
// asserted in component tests (受け入れ基準 6).
//
// 吹き出しの置き方（設計書 §H.2。N-01 / N-02 の直し）:
//
//  - **クリックを飲み込まない**（N-01）。吹き出しはすぐ上のボタンの真上に出るので、
//    `pointer-events` を指定しないと `elementFromPoint` が吹き出しを返し、真上のボタンが
//    押せなくなる（「結合」にマウスを置くと真上の「所属変更」が押せない、メニューでも
//    「保存」の吹き出しが「開く」を覆う）。CSS 側で `pointer-events: none` にしてある。
//  - **所属する枠の `overflow` の外へ出す**（N-02）。ツールレールは
//    `overflow-x: hidden`（HB-5 の幽霊横スクロールバー対策）なので、幅 119.2px の枠に
//    144px の吹き出しを出すと右へ 30.8px 切れて操作ガイドが読めなかった。`position: fixed`
//    にすると **祖先の `overflow` では切り取られない**（切り取るのは transform / filter /
//    contain を持つ祖先だけで、シェルにはそれが無いことを確認済み）。座標は開いた瞬間に
//    アンカーの矩形から計算し、窓の右端・上端からはみ出さないよう寄せる。
//    レールの `overflow-x: hidden` は外さない — 外すと HB-5 が再発するうえ、
//    `overflow-y: auto` と併存できず 800×600 で道具が隠れる。

import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface TooltipProps {
  /** The Japanese guide text (FR-115). */
  readonly text: string;
  readonly children: ReactNode;
  /**
   * 置き場所。`above`（既定）はアンカーの上。`beside-menu` はメニューの器の外の横で、縦に並んだ
   * 項目の文字を隠さない（上に出すと、すぐ上の項目を幅 432px の帯が覆っていた）。
   */
  readonly placement?: 'above' | 'beside-menu';
}

/** 吹き出しと窓の端との余白（px）。 */
const VIEWPORT_MARGIN = 4;
/** 吹き出しとアンカーの隙間（px）。 */
const ANCHOR_GAP = 4;

interface BubblePosition {
  readonly left: number;
  readonly top: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * メニューの項目の吹き出しの位置。器の右 → 左 → 器の下の順に、窓に入る最初の場所へ置く。
 * どの場所も器の外なので、項目の文字を隠さない。
 */
export function bubbleBesideMenu(
  item: Box,
  menu: Box,
  bubble: { readonly width: number; readonly height: number },
  windowSize: { readonly width: number; readonly height: number },
): BubblePosition {
  const maxTop = Math.max(VIEWPORT_MARGIN, windowSize.height - bubble.height - VIEWPORT_MARGIN);
  const top = Math.min(Math.max(item.top, VIEWPORT_MARGIN), maxTop);
  const right = menu.right + ANCHOR_GAP;
  if (right + bubble.width + VIEWPORT_MARGIN <= windowSize.width) return { left: right, top };
  const left = menu.left - ANCHOR_GAP - bubble.width;
  if (left >= VIEWPORT_MARGIN) return { left, top };
  const maxLeft = Math.max(VIEWPORT_MARGIN, windowSize.width - bubble.width - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(menu.left, VIEWPORT_MARGIN), maxLeft),
    top: menu.bottom + ANCHOR_GAP,
  };
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const { text, children, placement = 'above' } = props;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<BubblePosition | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  // 開いた直後に、アンカーの矩形と吹き出しの実寸から置き場所を決める。レイアウト効果に
  // するのは「描いたあと・見える前」に置きたいから（描画後に動くとちらつく）。jsdom では
  // 矩形が全部 0 なので位置は 0 になるが、それで壊れるものは無い（表示の有無は `hidden`）。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (anchor === null || bubble === null) return;
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const menu = placement === 'beside-menu' ? anchor.closest('[role="menu"]') : null;
    if (menu !== null) {
      const beside = bubbleBesideMenu(a, menu.getBoundingClientRect(), b, {
        width: viewportWidth,
        height: window.innerHeight,
      });
      setPosition((prev) => (prev !== null && prev.left === beside.left && prev.top === beside.top ? prev : beside));
      return;
    }
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - b.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(a.left, VIEWPORT_MARGIN), maxLeft);
    // 既定はアンカーの上。上に入りきらなければ下へ回す（メニューバーの項目がこれ）。
    const above = a.top - b.height - ANCHOR_GAP;
    const top = above >= VIEWPORT_MARGIN ? above : a.bottom + ANCHOR_GAP;
    setPosition((prev) =>
      prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [open, text, placement]);

  return (
    <span
      className="tooltip"
      data-testid="tooltip"
      ref={anchorRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
    >
      <span aria-describedby={id} title={text}>
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        hidden={!open}
        ref={bubbleRef}
        className="tooltip__bubble"
        data-testid="tooltip-bubble"
        style={position === null ? undefined : { left: position.left, top: position.top }}
      >
        {text}
      </span>
    </span>
  );
}
