// 見た目の統一（増分 8E 後半 / N-24・N-25・N-26・N-28）を CSS の宣言で固定する。
//
// jsdom はレイアウトも CSS の適用も持たないので、ここで見るのは **宣言があること**だけ（教訓 5.49 の 1 段目）。
// 実寸は `e2e/inc8e-visual-unity.spec.ts` が見る（2 段目）。
//
// 守りたい形: ボタンと見出しの土台を `:where()` で 1 か所に置き、部品の側は違うところだけを書く。
// 土台が無くなるとブラウザ既定の `1.6px outset` の系統が戻り、もう 1 色の青を書くと「押されている青」が
// また 2 色になる。

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSourceText } from '../../test-support/read-source-text';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '..');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const shellCss = stripComments(readSourceText(resolve(here, 'shell.css')));
const allCss = cssFiles(uiRoot).map((path) => ({
  path,
  css: stripComments(readSourceText(path)),
}));

/** セレクタが完全一致する規則の本体。無ければ落とす。 */
function ruleBody(selector: string, css: string = shellCss): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (m === null) throw new Error(`CSS の規則が見つからない: ${selector}`);
  return m[1] ?? '';
}

function decl(body: string, name: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

/** 全部の CSS の規則（@media の中の規則も拾う）。 */
function allRules(): { readonly path: string; readonly selector: string; readonly body: string }[] {
  return allCss.flatMap(({ path, css }) =>
    Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
      path,
      selector: (m[1] ?? '').trim(),
      body: m[2] ?? '',
    })),
  );
}

describe('設計変数', () => {
  it('高さは 3 段、文字は 4 段で 1 か所に置く', () => {
    const root = ruleBody(':root');
    expect(decl(root, '--control-h-sm')).toBe('24px');
    expect(decl(root, '--control-h')).toBe('28px');
    expect(decl(root, '--control-h-lg')).toBe('32px');
    expect(decl(root, '--font-size-title')).toBe('16px');
    expect(decl(root, '--font-size-heading')).toBe('13px');
    expect(decl(root, '--font-size-body')).toBe('12px');
    expect(decl(root, '--font-size-small')).toBe('11px');
  });
});

describe('ボタンの土台（N-24 / N-26 / N-28）', () => {
  it('土台は詳細度 0 で、変数だけから見た目を決める', () => {
    const base = ruleBody(':where(button)');
    expect(decl(base, 'min-height')).toBe('var(--control-h)');
    expect(decl(base, 'font-size')).toBe('var(--font-size-body)');
    expect(decl(base, 'color')).toBe('var(--c-text)');
    expect(decl(base, 'background')).toBe('var(--c-surface)');
    expect(decl(base, 'border')).toBe('1px solid var(--c-border-strong)');
    expect(decl(base, 'border-radius')).toBe('var(--radius)');
    expect(decl(base, 'white-space')).toBe('nowrap');
  });

  it('「押されている」は土台の 1 色', () => {
    const pressed = ruleBody(":where(button[aria-pressed='true'])");
    expect(decl(pressed, 'background')).toBe('var(--c-accent)');
    expect(decl(pressed, 'border-color')).toBe('var(--c-accent)');
  });

  it('もう 1 色の青（#1565c0）と、消した独自の取りやめの色を CSS に書かない', () => {
    const offenders = allCss
      .filter(({ css }) => /#1565c0|#0d47a1|#eceff1/i.test(css))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('板の確定の列は折り返してよい（文字ではなくボタンごと次の行へ送る）', () => {
    const m = /:where\(\s*([^)]*)\)\s*\{\s*flex-wrap:\s*wrap;\s*\}/.exec(shellCss);
    expect(m, '確定の列の flex-wrap の規則').not.toBeNull();
    const list = (m?.[1] ?? '').split(',').map((s) => s.trim());
    expect(list).toEqual(
      expect.arrayContaining([
        '.unsaved-dialog__choices',
        '.settings-dialog__footer',
        '.conflict-dialog__actions',
        '.knife-dialog__footer',
      ]),
    );
  });
});

describe('無効の見え方（土台の 1 か所）', () => {
  it('土台が色の組を持ち、透明度を重ねない', () => {
    const root = ruleBody(':root');
    expect(decl(root, '--c-disabled-text')).toBe('var(--c-text-muted)');
    expect(decl(root, '--c-disabled-bg')).toBe('var(--c-panel)');
    const base = ruleBody('html button:disabled');
    expect(decl(base, 'color')).toBe('var(--c-disabled-text)');
    expect(decl(base, 'background')).toBe('var(--c-disabled-bg)');
    expect(decl(base, 'border-color')).toBe('var(--c-disabled-border)');
    expect(decl(base, 'opacity')).toBeUndefined();
  });

  it('部品の無効の規則は、地を透明にするだけ（色も透明度も書かない）', () => {
    const offenders = allRules()
      .filter(({ selector }) => /:disabled(?!\))/.test(selector.replace(/:not\(:disabled\)/g, '')))
      .filter(({ selector }) => !selector.startsWith('html '))
      .filter(({ body }) => ['opacity', 'color', 'border-color', 'cursor'].some((n) => decl(body, n) !== undefined))
      .map(({ path, selector }) => `${path}: ${selector}`);
    expect(offenders).toEqual([]);
  });

  it('無効な入力欄も同じ組で、Chromium の select の 0.7 を消す', () => {
    const rule = allRules().find(({ selector }) => selector.startsWith('html :is(input'));
    expect(rule, '入力欄の無効の規則').toBeDefined();
    expect(decl(rule?.body ?? '', 'color')).toBe('var(--c-disabled-text)');
    expect(decl(rule?.body ?? '', 'opacity')).toBe('1');
  });
});

describe('押された状態の色の組（教訓 5.104）', () => {
  /** 地が薄い色で、文字は部品の暗い色のままでよい規則（コントラストは E2E が測る）。 */
  const LIGHT_BACKGROUND = new Set([
    "html button[aria-pressed='true']:disabled",
    ".parent-tree__pick[aria-selected='true']",
    '.knife-choice--selected',
    '.anchor-list__row--selected',
    '.anchor-timebar__bar--selected',
  ]);

  it('押された・選ばれた状態で地を変えるなら、文字の色も一緒に書く', () => {
    const offenders = allRules()
      .filter(({ selector }) => /\[aria-(pressed|selected)='true'\]|--selected/.test(selector))
      .filter(({ body }) => decl(body, 'background') !== undefined || decl(body, 'background-color') !== undefined)
      .filter(({ body }) => decl(body, 'color') === undefined)
      .filter(({ selector }) => !LIGHT_BACKGROUND.has(selector))
      .map(({ path, selector }) => `${path}: ${selector}`);
    expect(offenders).toEqual([]);
  });

  it('詳細文書の切替は色の組を土台から受ける', () => {
    const property = allCss.find(({ path }) => path.endsWith('property.css'))?.css ?? '';
    const modes = ruleBody('.detail-document__modes button', property);
    expect(decl(modes, 'color')).toBeUndefined();
    expect(decl(modes, 'background')).toBeUndefined();
  });
});

describe('右クリックメニュー', () => {
  it('窓より高いときは中でスクロールし、行はアプリバーのメニューと同じ形', () => {
    const menu = ruleBody('.context-menu');
    expect(decl(menu, 'max-height')).toBe('calc(100vh - 8px)');
    expect(decl(menu, 'overflow-y')).toBe('auto');
    const rows = ruleBody('.menubar__item,\n.context-menu__item');
    expect(decl(rows, 'width')).toBe('100%');
    expect(decl(rows, 'background')).toBe('transparent');
    expect(decl(rows, 'border')).toBe('0');
  });

  it('3 つの器はどれも窓の中へ収める 1 本を通す（押した位置へ直接置かない）', () => {
    for (const file of ['shell/ContextMenu.tsx', 'map/MapContextMenu.tsx', 'timeline/RailContextMenu.tsx']) {
      const source = readSourceText(resolve(uiRoot, file));
      expect(source, file).toContain('useMenuInWindow(');
      expect(source, file).toContain('style={placed.style}');
      expect(source, file).not.toMatch(/position: 'fixed', left:/);
    }
  });
});

describe('板の確定の列（教訓 5.61 の形）', () => {
  it('設定とヘルプの板は本文だけがスクロールする', () => {
    const css = allCss.find(({ path }) => path.endsWith('help-tools.css'))?.css ?? '';
    for (const name of ['help-dialog', 'settings-dialog']) {
      const box = ruleBody(`.${name}`, css);
      expect(decl(box, 'display'), name).toBe('flex');
      expect(decl(box, 'flex-direction'), name).toBe('column');
      expect(decl(box, 'overflow'), name).toBe('hidden');
      const body = ruleBody(`.${name}__body`, css);
      expect(decl(body, 'overflow-y'), name).toBe('auto');
      expect(decl(body, 'flex'), name).toBe('1 1 auto');
    }
  });
});

describe('押せる高さ', () => {
  it('所属の候補の行は行の高さいっぱいを押せる', () => {
    const css = allCss.find(({ path }) => path.endsWith('reparent.css'))?.css ?? '';
    expect(decl(ruleBody('.parent-tree__pick', css), 'align-self')).toBe('stretch');
    expect(decl(ruleBody('.parent-tree__expand', css), 'align-self')).toBe('stretch');
  });

  it('状態行の × は行の高さいっぱい、結果に添えたボタンは 24px', () => {
    expect(decl(ruleBody('.statusbar__dismiss'), 'align-self')).toBe('stretch');
    expect(decl(ruleBody('.statusbar__action'), 'min-height')).toBe('var(--control-h-sm)');
  });
});

describe('文字の大きさの直値', () => {
  it('補助の文字は変数から引く（11px を直に書かない）', () => {
    const offenders = allCss.filter(({ css }) => /font-size:\s*11px/.test(css)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('10px のボタンは一覧の種別（56px の枠に種別名を入れる）と錨の時間棒（細い帯の中の年）だけ', () => {
    const offenders = allRules()
      .filter(({ body }) => decl(body, 'font-size') === '10px' && decl(body, 'cursor') === 'pointer')
      .map(({ selector }) => selector);
    expect(offenders.sort()).toEqual(['.anchor-timebar__bar', '.ledger__kind']);
  });
});

describe('メニューの中身（教訓 5.105）', () => {
  it('overflow: hidden のアプリバーを抜けるように fixed で置く', () => {
    expect(decl(ruleBody('.app-shell__menubar'), 'overflow')).toBe('hidden');
    const list = ruleBody('.menubar__items');
    expect(decl(list, 'position')).toBe('fixed');
    expect(decl(list, 'top')).toBe('var(--shell-appbar-h)');
  });
});

describe('見出しの土台（N-25）', () => {
  it('h1〜h6 に規則があり、大きさは変数から引く', () => {
    expect(decl(ruleBody(':where(h1, h2)'), 'font-size')).toBe('var(--font-size-title)');
    expect(decl(ruleBody(':where(h3)'), 'font-size')).toBe('var(--font-size-heading)');
    expect(decl(ruleBody(':where(h4, h5, h6)'), 'font-size')).toBe('var(--font-size-body)');
    for (const selector of [':where(h1, h2)', ':where(h3)', ':where(h4, h5, h6)']) {
      expect(decl(ruleBody(selector), 'margin'), selector).toMatch(/^0 0 \d+px$/);
      expect(decl(ruleBody(selector), 'font-weight'), selector).toBe('600');
    }
  });

  it('板の題（*-dialog__title）に大きさの直値を書かない', () => {
    const offenders: string[] = [];
    for (const { path, css } of allCss) {
      for (const m of css.matchAll(/([^{}]*-dialog__title[^{}]*)\{([^}]*)\}/g)) {
        const size = decl(m[2] ?? '', 'font-size');
        if (size !== undefined && !size.startsWith('var(')) {
          offenders.push(`${path}: ${(m[1] ?? '').trim()} ${size}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
