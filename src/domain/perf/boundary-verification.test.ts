// U42 — verification lens over the E2E-unstable DOMAIN boundaries
// (受け入れ基準 5 / 教訓 5.41): 外部地図入力 (FR-04) + .tmap 往復 (FR-103).
//
// These boundaries are hard to drive deterministically through Playwright (they
// open OS dialogs / read files / touch fs), so per 教訓 5.41 they are double-fixed
// as PURE unit checks here, with the SAME expectation the matching E2E asserts —
// so an E2E failure can be triaged to (UI wiring) vs (boundary logic) by seeing
// which lens is red. Each check re-uses the production domain function (no logic
// re-implementation): only the EXPECTATION is restated from U42's standpoint.
//
// 終了確認ガード (FR-107) is a UI-layer boundary; its U42 verification lens lives
// in src/ui/file-ops/exit-guard-verification.test.ts (the domain layer must not
// import from ui — 依存方向は内向き).

import { describe, it, expect } from 'vitest';

import {
  validateImageDescriptor,
  decideBasemapReplacement,
  isFormatAdequate,
  IMAGE_VALIDATION_ERROR,
  BASEMAP_OUTCOME,
} from '../basemap/format';
import { SCHEMA_VERSION } from '../persistence/schema';
import { serialize, manifestToProject, projectsEqual } from '../persistence/serialize';
import { richValidProject } from '../persistence/fixtures';

// --- 外部地図入力 (FR-04): the E2E would import an image; pure lens here. --------

describe('外部地図適合判定 純粋判定 (FR-04, verification lens)', () => {
  it('a valid 2:1 equirectangular image is adequate (E2E: imports without fallback)', () => {
    const v = validateImageDescriptor({ widthPx: 2000, heightPx: 1000, source: 'world.png' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(isFormatAdequate(v.descriptor)).toBe(true);
  });

  it('a too-small image is rejected (E2E: shows an error, no import)', () => {
    const v = validateImageDescriptor({ widthPx: 0, heightPx: 1000, source: 'bad.png' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe(IMAGE_VALIDATION_ERROR.TooSmall);
  });

  it('an adequate image yields an ADOPTED decision (E2E: background replaced)', () => {
    const v = validateImageDescriptor({ widthPx: 4000, heightPx: 2000, source: 'big.png' });
    const decision = decideBasemapReplacement(v);
    expect(decision.outcome).toBe(BASEMAP_OUTCOME.Adopted);
  });

  it('an invalid image falls back to the preset (E2E: preset stays displayed)', () => {
    const v = validateImageDescriptor({ widthPx: Number.NaN, heightPx: 1000, source: 'x.png' });
    const decision = decideBasemapReplacement(v);
    expect(decision.outcome).toBe(BASEMAP_OUTCOME.FallbackToPreset);
  });
});

// --- 保存・読込 往復 (FR-103): the E2E saves→loads a .tmap; pure lens here. ------

describe('.tmap 往復シリアライズ 純粋判定 (FR-103, verification lens)', () => {
  it('a rich project round-trips losslessly (E2E: 保存→読込 で論理的完全復元)', () => {
    const project = richValidProject();
    const restored = manifestToProject(serialize(project));
    expect(projectsEqual(project, restored)).toBe(true);
  });

  it('serialize carries the schema version (E2E: バージョン情報の保持 FR-104)', () => {
    const manifest = serialize(richValidProject());
    expect(manifest.version).toBe(SCHEMA_VERSION);
  });
});
