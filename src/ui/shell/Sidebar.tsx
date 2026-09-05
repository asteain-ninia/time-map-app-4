// UI layer (U20 / shell): 右パネル（設計書 §B.1 / §E-1 / FR-111）。
//
// **増分 4 で排他タブをやめた。** 上下 2 区画（地物一覧 / 選んだ地物）を **同時に**出す。
// 理由は C5「探す・見る・直すが 1 画面で閉じない」で、タブだと「一覧で探す → タブを
// 切り替える → 直す → タブを戻す」を 220 回繰り返すことになる。FR-111 が求めている
// 「2 区画」という数はそのまま守る（区画の数は変えず、**同時に見えるか**だけを変えた）。
//
// **見出しのボタンは残す**（`sidebar-tab-list` / `sidebar-tab-properties`）。役割は
// 「タブを切り替える」から **「その区画へ寄せる」** に変わったが、T-1 の趣旨（testid は
// 役割で維持する）に照らすと、利用者から見た役割は「その区画を見る」で変わっていない。
// 22 本の E2E がこの 2 つを押して区画を出しているので、押したら寄せる形にしておけば
// 意図も検査も生きたまま残る。**ただし `role="tab"` / `aria-selected` はやめた** ――
// 2 つとも見えている状態で「選ばれているタブ」を名乗るのは嘘になるので、押されている
// 状態は `aria-pressed`（トグルボタン）で表す。
//
// **仕切りは動かせる**（設計書 §B.1 の「台帳 470 / 素性 312」）。既定は上が 60% で、
// 1600×1000 なら 470/312、1280×800 なら 350/232 になる（どちらも 60:40）。
// 動かした値は px で覚える（窓を変えても同じ見た目に戻る、という要求は無い）。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { APP_STRINGS, SIDEBAR_SECTION_TITLES } from './strings';
import type { SidebarFocusStore, SidebarFocusSection } from './sidebar-focus';

/** The sidebar section keys, in display order (上 → 下). */
export const SIDEBAR_SECTION = {
  List: 'list',
  Properties: 'properties',
} as const;

export type SidebarSection = (typeof SIDEBAR_SECTION)[keyof typeof SIDEBAR_SECTION];

// 上の区画（地物一覧）の既定の割合（上 60% / 下 40%）は **CSS が持つ**
// （`.sidebar__panel[data-testid='sidebar-panel-list'] { flex: 0 1 60% }`）。
// ここに同じ数を持つ定数を置いていたが、呼び出し元が 1 つも無く、CSS を直しても
// こちらは古いまま残る形だったので消した（同じ寸法の真実源を 2 つ持たない）。

/**
 * 上段（地物一覧）がこれ以上小さくならない高さ（px）。
 *
 * **「行が 1 行は見える高さ」** ＝ 見出し 31 ＋ 余白 20 ＋ 一覧の見出し群 90 ＋ 行 28。
 * ここが 60px だったので、既定の 1280×800 では上段が 108px しか取れず、**一覧の行が
 * 1 行も区画の中に入っていなかった**。CSS 側の `min-height` と同じ値で、片方だけ
 * 動かすと仕切りの可動域と実際の見た目が食い違う。 */
export const SIDEBAR_LIST_MIN_HEIGHT = 172;

/**
 * 下段（選んだ地物）の下限の**上限**（px）。実際の下限は窓に追随する
 * （{@link propertiesMinHeight}）。
 *
 * 下端に固定した保存列（36px）とその上の予告・断りの行が同時に見えていないと、保存列が
 * 節の見出しを覆って「押せるはずのものが押せない」になる（教訓 5.14）。ただし **300px を
 * 固定値で先に取ると上段が潰れる** ので、列が低いときは割合のほうが効く。 */
export const SIDEBAR_PROPERTIES_MIN_HEIGHT = 300;

/** 下段の下限が窓に追随するときの割合（列の高さの 55%）。CSS の `min(300px, 55%)` と同値。 */
export const SIDEBAR_PROPERTIES_MIN_RATIO = 0.55;

/** 仕切りの高さ（px）。CSS の `.sidebar__splitter` と同値。 */
export const SIDEBAR_SPLITTER_HEIGHT = 6;

/** 鍵盤で仕切りを動かす 1 回ぶん（px）。 */
const SPLITTER_KEY_STEP = 16;

/**
 * その列の高さでの、下段の実際の下限（px）。CSS の `min(300px, 55%)` と同じ規則を
 * ここでも使う ―― 仕切りの可動域と CSS がずれると、引き切った位置で見た目が跳ねる。
 */
export function propertiesMinHeight(total: number): number {
  return Math.min(SIDEBAR_PROPERTIES_MIN_HEIGHT, total * SIDEBAR_PROPERTIES_MIN_RATIO);
}

export interface SidebarProps {
  /** 上段（地物一覧＝台帳）の中身。`SidebarContent` が組み立てて渡す。 */
  readonly listContent?: ReactNode;
  /** 下段（選んだ地物＝素性欄）の中身。 */
  readonly propertiesContent?: ReactNode;
  /**
   * 「どの区画に注目させるか」の口（結合点 #3）。右クリックの「プロパティを編集」と
   * 追加の確定がここを呼ぶ。渡さなければ寄せる要求は来ない（見出しを押す道は残る）。
   */
  readonly focusStore?: SidebarFocusStore;
  /** 最初に印が付いている区画。既定は「選んだ地物」。 */
  readonly initialSection?: SidebarSection;
}

const SECTION_TITLE: Readonly<Record<SidebarSection, string>> = {
  [SIDEBAR_SECTION.List]: SIDEBAR_SECTION_TITLES.list,
  [SIDEBAR_SECTION.Properties]: SIDEBAR_SECTION_TITLES.properties,
};

export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    listContent,
    propertiesContent,
    focusStore,
    initialSection = SIDEBAR_SECTION.Properties,
  } = props;

  // 「いまどちらを見ればよいか」の印。**区画の表示/非表示ではない**（両方いつも見えている）。
  const [focused, setFocused] = useState<SidebarSection>(initialSection);
  /** 上段の高さ（px）。null なら既定の割合で決める。 */
  const [topHeight, setTopHeight] = useState<number | null>(null);

  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const bodyRefs = useRef<Partial<Record<SidebarSection, HTMLDivElement | null>>>({});

  /**
   * その区画へ寄せる（設計書 §I.3）。**先頭までスクロールし、印を移す。**
   * 焦点そのものは区画の中身が持っている（素性欄の名前欄など）ので、ここでは触らない
   * ―― 中身を知らない器が中身の焦点を決めると、中身を差し替えたときに黙って壊れる。
   */
  const reveal = useCallback((section: SidebarFocusSection): void => {
    setFocused(section as SidebarSection);
    const body = bodyRefs.current[section as SidebarSection];
    if (body != null) body.scrollTop = 0;
  }, []);

  useEffect(() => {
    if (focusStore === undefined) return;
    return focusStore.subscribe((request) => {
      reveal(request.section);
    });
  }, [focusStore, reveal]);

  // --- 仕切りのドラッグ -------------------------------------------------------
  //
  // ポインタを掴んだら `setPointerCapture` で最後まで受け取る（教訓 5.8: 押下 → 移動 →
  // 解放を全パスで保証する。窓の外へ出ても解放が届く）。
  const dragRef = useRef<{ readonly startY: number; readonly startHeight: number } | null>(
    null,
  );

  const clampTop = useCallback((next: number): number => {
    const total = sectionsRef.current?.getBoundingClientRect().height ?? 0;
    if (total <= 0) return next;
    const max = Math.max(
      SIDEBAR_LIST_MIN_HEIGHT,
      total - propertiesMinHeight(total) - SIDEBAR_SPLITTER_HEIGHT,
    );
    return Math.min(Math.max(next, SIDEBAR_LIST_MIN_HEIGHT), max);
  }, []);

  /** いまの上段の高さ（px）。鍵盤の操作と ARIA の現在値がここを読む。 */
  const currentTopHeight = useCallback((): number => {
    if (topHeight !== null) return topHeight;
    const list = bodyRefs.current[SIDEBAR_SECTION.List]?.parentElement;
    return list?.getBoundingClientRect().height ?? 0;
  }, [topHeight]);

  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const list = bodyRefs.current[SIDEBAR_SECTION.List]?.parentElement;
      const startHeight = list?.getBoundingClientRect().height ?? 0;
      if (startHeight <= 0) return;
      dragRef.current = { startY: e.clientY, startHeight };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [],
  );

  const onSplitterPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      setTopHeight(clampTop(drag.startHeight + (e.clientY - drag.startY)));
    },
    [clampTop],
  );

  const onSplitterPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // 窓が縮んで上段が入らなくなったら、その場で詰める（教訓 5.5: 依存する状態は変化時に
  // 再検証する）。既定（null）のままなら割合で決まるので何もしない。
  useLayoutEffect(() => {
    if (topHeight === null) return;
    const clamped = clampTop(topHeight);
    if (clamped !== topHeight) setTopHeight(clamped);
  }, [topHeight, clampTop]);

  // --- 仕切りの鍵盤操作と ARIA の現在値 ---------------------------------------
  //
  // `role="separator"` は「動かせる仕切り」を名乗るので、**動かす手段と現在値を
  // 両方持たなければ嘘になる**（矢印で動かせない・支援技術に値が伝わらない）。
  // 値は実測なので、列の高さと上段の高さを測って持つ。
  const [measured, setMeasured] = useState<{ total: number; top: number }>({
    total: 0,
    top: 0,
  });
  useLayoutEffect(() => {
    const sections = sectionsRef.current;
    const list = bodyRefs.current[SIDEBAR_SECTION.List]?.parentElement ?? null;
    if (sections === null || list === null) return;
    const measure = (): void => {
      const total = sections.getBoundingClientRect().height;
      const top = list.getBoundingClientRect().height;
      setMeasured((prev) => (prev.total === total && prev.top === top ? prev : { total, top }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(sections);
    ro.observe(list);
    return () => {
      ro.disconnect();
    };
  }, []);

  const splitterMax = Math.max(
    SIDEBAR_LIST_MIN_HEIGHT,
    measured.total - propertiesMinHeight(measured.total) - SIDEBAR_SPLITTER_HEIGHT,
  );

  const onSplitterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const total = sectionsRef.current?.getBoundingClientRect().height ?? 0;
      let next: number | null = null;
      if (e.key === 'ArrowUp') next = currentTopHeight() - SPLITTER_KEY_STEP;
      else if (e.key === 'ArrowDown') next = currentTopHeight() + SPLITTER_KEY_STEP;
      else if (e.key === 'Home') next = SIDEBAR_LIST_MIN_HEIGHT;
      else if (e.key === 'End') next = total;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      setTopHeight(clampTop(next));
    },
    [clampTop, currentTopHeight],
  );

  const content: Record<SidebarSection, ReactNode> = {
    [SIDEBAR_SECTION.List]: listContent,
    [SIDEBAR_SECTION.Properties]: propertiesContent,
  };

  return (
    <aside className="sidebar" aria-label={APP_STRINGS.sidebarAriaLabel} data-testid="sidebar">
      <div className="sidebar__sections" ref={sectionsRef}>
        <ContiguousSection
          section={SIDEBAR_SECTION.List}
          focused={focused === SIDEBAR_SECTION.List}
          onReveal={reveal}
          {...(topHeight !== null ? { fixedHeight: topHeight } : {})}
          bodyRef={(el) => {
            bodyRefs.current[SIDEBAR_SECTION.List] = el;
          }}
        >
          {content[SIDEBAR_SECTION.List]}
        </ContiguousSection>
        <div
          className="sidebar__splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label={APP_STRINGS.sidebarSplitterAriaLabel}
          data-testid="sidebar-splitter"
          tabIndex={0}
          aria-valuenow={Math.round(measured.top)}
          aria-valuemin={SIDEBAR_LIST_MIN_HEIGHT}
          aria-valuemax={Math.round(splitterMax)}
          onPointerDown={onSplitterPointerDown}
          onPointerMove={onSplitterPointerMove}
          onPointerUp={onSplitterPointerUp}
          onPointerCancel={onSplitterPointerUp}
          onKeyDown={onSplitterKeyDown}
        />
        <ContiguousSection
          section={SIDEBAR_SECTION.Properties}
          focused={focused === SIDEBAR_SECTION.Properties}
          onReveal={reveal}
          bodyRef={(el) => {
            bodyRefs.current[SIDEBAR_SECTION.Properties] = el;
          }}
        >
          {content[SIDEBAR_SECTION.Properties]}
        </ContiguousSection>
      </div>
    </aside>
  );
}

function ContiguousSection(props: {
  readonly section: SidebarSection;
  readonly focused: boolean;
  readonly onReveal: (section: SidebarFocusSection) => void;
  readonly fixedHeight?: number;
  readonly bodyRef: (el: HTMLDivElement | null) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const { section, focused, onReveal, fixedHeight, bodyRef, children } = props;
  return (
    <section
      id={`sidebar-panel-${section}`}
      aria-labelledby={`sidebar-tab-${section}`}
      className="sidebar__panel"
      data-testid={`sidebar-panel-${section}`}
      data-focused={focused ? 'true' : 'false'}
      style={
        fixedHeight === undefined
          ? undefined
          : { flex: `0 0 ${String(fixedHeight)}px` }
      }
    >
      <div className="sidebar__panel-head">
        <button
          type="button"
          id={`sidebar-tab-${section}`}
          aria-controls={`sidebar-panel-${section}`}
          aria-pressed={focused}
          data-testid={`sidebar-tab-${section}`}
          className="sidebar__panel-title"
          onClick={() => onReveal(section)}
        >
          {SECTION_TITLE[section]}
        </button>
      </div>
      <div className="sidebar__panel-body" ref={bodyRef}>
        {children}
      </div>
    </section>
  );
}
