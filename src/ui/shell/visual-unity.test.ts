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
