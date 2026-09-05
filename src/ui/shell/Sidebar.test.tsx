// U20 の部品テスト: 右パネルの **上下 2 区画の同時表示**（増分 4 / FR-111 / 設計書 §E-1）。
//
// **増分 4 で排他タブをやめた。** それまでは「片方が `hidden`、押すと入れ替わる」を
// 固定していたが、上下 2 区画では **両方いつも見えている**のが正しい。ここで固定するのは
// 3 つ:
//   1. 2 つの区画が同時に居て、どちらにも `hidden` が付いていない
//   2. 見出しのボタンは「その区画へ寄せる」印を移す（`aria-pressed`）
//   3. 外から寄せる口（`SidebarFocusStore`）が効く ＝ 結合点 #3 の置き換え
//
// **`role="tab"` / `aria-selected` は使わない。** 2 つとも見えている状態で「選ばれている
// タブ」を名乗るのは嘘になるので、押されている状態はトグルボタンの `aria-pressed` で表す。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sidebar, SIDEBAR_SECTION } from './Sidebar';
import { SidebarFocusStore } from './sidebar-focus';

describe('Sidebar（増分 4: 上下 2 区画の同時表示）', () => {
  it('地物一覧と選んだ地物の 2 区画が同時に出ていて、どちらも隠れていない', () => {
    render(
      <Sidebar
        initialSection={SIDEBAR_SECTION.List}
        listContent={<div data-testid="ls" />}
        propertiesContent={<div data-testid="pr" />}
      />,
    );
    // FR-111 の「2 区画」という数は守る。変わったのは **同時に見えるか** だけである。
    expect(screen.getByTestId('sidebar-panel-list')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    // 両方の中身が同時に載っている（＝タブを押さなくても素性欄が読める）。
    expect(screen.getByTestId('ls')).toBeInTheDocument();
    expect(screen.getByTestId('pr')).toBeInTheDocument();
  });

  it('見出しのボタンを押すと「いまどちらを見るか」の印が移る（区画は消えない）', () => {
    render(
      <Sidebar
        initialSection={SIDEBAR_SECTION.List}
        listContent={<div data-testid="ls" />}
        propertiesContent={<div data-testid="pr" />}
      />,
    );
    expect(screen.getByTestId('sidebar-tab-list')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sidebar-tab-properties')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByTestId('sidebar-tab-properties'));

    expect(screen.getByTestId('sidebar-tab-properties')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('sidebar-tab-list')).toHaveAttribute('aria-pressed', 'false');
    // **押しても区画は消えない**（ここが排他タブとの違い）。
    expect(screen.getByTestId('sidebar-panel-list')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('ls')).toBeInTheDocument();
  });

  it('見出しと区画が id + aria-controls / aria-labelledby で結ばれている', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.List} />);
    const head = screen.getByTestId('sidebar-tab-list');
    const panel = screen.getByTestId('sidebar-panel-list');
    expect(head).toHaveAttribute('id', 'sidebar-tab-list');
    expect(head).toHaveAttribute('aria-controls', 'sidebar-panel-list');
    expect(panel).toHaveAttribute('id', 'sidebar-panel-list');
    expect(panel).toHaveAttribute('aria-labelledby', 'sidebar-tab-list');
  });

  // 結合点 #3 の置き換え。旧実装は `document.getElementById('sidebar-tab-properties')
  // ?.click()` で、**DOM に在ることと押すと切り替わることの両方**に依存していた。
  it('外からの「この区画へ寄せて」の口が効く（結合点 #3 の置き換え）', () => {
    const focusStore = new SidebarFocusStore();
    render(
      <Sidebar
        initialSection={SIDEBAR_SECTION.List}
        focusStore={focusStore}
        listContent={<div data-testid="ls" />}
        propertiesContent={<div data-testid="pr" />}
      />,
    );
    expect(screen.getByTestId('sidebar-tab-properties')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    act(() => {
      focusStore.focus(SIDEBAR_SECTION.Properties);
    });

    expect(screen.getByTestId('sidebar-tab-properties')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('同じ区画へ続けて 2 回寄せても、2 回とも届く（要求ごとに別物として扱う）', () => {
    const focusStore = new SidebarFocusStore();
    const seen: string[] = [];
    focusStore.subscribe((r) => seen.push(`${r.section}:${String(r.nonce)}`));
    focusStore.focus(SIDEBAR_SECTION.Properties);
    focusStore.focus(SIDEBAR_SECTION.Properties);
    expect(seen).toEqual(['properties:1', 'properties:2']);
  });

  it('仕切りが居る（掴んで上下に動かせる）', () => {
    render(<Sidebar />);
    const splitter = screen.getByTestId('sidebar-splitter');
    expect(splitter).toHaveAttribute('role', 'separator');
    expect(splitter).toHaveAttribute('aria-orientation', 'horizontal');
  });

  // `role="separator"` は「動かせる仕切り」を名乗る。**動かす手段と現在値を両方
  // 持たなければ嘘**になるので、鍵盤の到達（tabIndex）・矢印・Home/End と、
  // 支援技術へ渡す現在値（aria-valuenow / min / max）をここで固定する。
  it('仕切りは鍵盤で動かせて、現在値を持っている', () => {
    render(<Sidebar listContent={<div />} propertiesContent={<div />} />);
    const splitter = screen.getByTestId('sidebar-splitter');
    expect(splitter).toHaveAttribute('tabindex', '0');
    expect(splitter).toHaveAttribute('aria-valuenow');
    expect(splitter).toHaveAttribute('aria-valuemin', '172');
    expect(splitter).toHaveAttribute('aria-valuemax');

    const list = screen.getByTestId('sidebar-panel-list');
    // レイアウトを持たない環境なので、寸法そのものは測れない（教訓 5.49）。
    // ここで見るのは「鍵盤が届いて、上段の高さが px で固定される」ところまで。
    expect(list.getAttribute('style') ?? '').not.toContain('flex');
    fireEvent.keyDown(splitter, { key: 'ArrowDown' });
    expect(list.getAttribute('style') ?? '').toContain('flex');
    const afterDown = list.getAttribute('style') ?? '';
    fireEvent.keyDown(splitter, { key: 'Home' });
    expect(list.getAttribute('style') ?? '').toContain('172px');
    expect(list.getAttribute('style') ?? '').not.toBe(afterDown);
  });
});
