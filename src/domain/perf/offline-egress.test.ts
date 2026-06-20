// U42 — offline完結 (FR-02) verified statically: NO network-egress call sites in
// the renderer/domain/render layers (受け入れ基準 1 FR-02 / 5 オフライン性の検査点).
//
// 教訓 5.41 適用: 「外部発信が一切ないこと」を E2E の実行時観測だけに頼らず、副作用
// 境界（ネットワーク呼び出し点）の有無として静的・単体レベルでも確認できる形に落と
// す。This scans the renderer-facing source for forbidden egress primitives
// (fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / import() of a
// URL). It is the別レンズ that double-fixes the E2E「外部発信なし」assertion: if
// this fails, an egress slipped into the renderer even if the E2E happened to not
// trigger it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', '..'); // src/

/** Layers that ship into the renderer (offline-bound). `shell` is exempt: the
 * Electron main process legitimately may not, but for THIS app it also has no
 * network — we scan it too to be strict. */
const SCAN_DIRS = ['domain', 'render', 'ui', 'shell'].map((d) => join(srcRoot, d));

/** Egress primitives that would constitute外部発信 from the renderer (FR-02). */
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  /\bimport\s*\(\s*['"`]https?:/,
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (
      (full.endsWith('.ts') || full.endsWith('.tsx')) &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.test.tsx') &&
      !full.endsWith('.test-d.ts')
    ) {
      yield full;
    }
  }
}

describe('offline完結 — no network egress in shipped source (FR-02)', () => {
  it('no fetch / XHR / WebSocket / EventSource / sendBeacon / URL-import anywhere', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN) {
          if (pattern.test(text)) {
            offenders.push(`${file.replace(srcRoot, 'src')} matches ${pattern}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans a non-trivial number of files (guards against an empty/broken scan)', () => {
    let count = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        if (file.length > 0) count += 1;
      }
    }
    expect(count).toBeGreaterThan(50);
  });
});
