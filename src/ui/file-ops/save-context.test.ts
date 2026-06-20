import { describe, expect, it } from 'vitest';

import { PRESET_BASEMAP_ID } from '../../domain/basemap/preset';

import {
  EMPTY_PROJECT_METADATA,
  buildNewProjectContext,
  contextAfterSave,
  contextForLoadedFile,
  markDirty,
  needsSaveAs,
} from './save-context';

describe('buildNewProjectContext (教訓 5.36 / 受け入れ基準 4 同時初期化)', () => {
  it('initialises ALL save-context fields together', () => {
    const ctx = buildNewProjectContext();
    expect(ctx.savePath).toBeNull();
    expect(ctx.backupTarget).toBeNull();
    expect(ctx.metadata).toEqual(EMPTY_PROJECT_METADATA);
    expect(ctx.baseMapId).toBe(PRESET_BASEMAP_ID); // 出界図 (FR-03)
    expect(ctx.dirty).toBe(false); // clean baseline
    expect(ctx.exitGuardEnabled).toBe(true); // 終了確認ガード有効化
  });

  it('a new project routes 保存 → 名前を付けて保存 (savePath null)', () => {
    expect(needsSaveAs(buildNewProjectContext())).toBe(true);
  });

  it('returns a fresh value each call (no shared mutable default)', () => {
    expect(buildNewProjectContext()).not.toBe(buildNewProjectContext());
  });
});

describe('contextForLoadedFile (load establishes a fresh baseline)', () => {
  it('adopts path + backup target, carries metadata/baseMap, clean dirty', () => {
    const ctx = contextForLoadedFile({
      path: '/tmp/world.tmap',
      metadata: { name: '世界A', description: 'desc' },
      baseMapId: 'user-map',
    });
    expect(ctx.savePath).toBe('/tmp/world.tmap');
    expect(ctx.backupTarget).toBe('/tmp/world.tmap');
    expect(ctx.metadata).toEqual({ name: '世界A', description: 'desc' });
    expect(ctx.baseMapId).toBe('user-map');
    expect(ctx.dirty).toBe(false);
    expect(ctx.exitGuardEnabled).toBe(true);
    expect(needsSaveAs(ctx)).toBe(false);
  });
});

describe('markDirty + contextAfterSave (baseline 一致, 教訓 5.24)', () => {
  it('markDirty sets dirty true and is idempotent', () => {
    const clean = buildNewProjectContext();
    const dirty = markDirty(clean);
    expect(dirty.dirty).toBe(true);
    expect(markDirty(dirty)).toBe(dirty); // idempotent (returns same value)
  });

  it('contextAfterSave adopts the saved path as path+backup and clears dirty', () => {
    const dirty = markDirty(buildNewProjectContext());
    const saved = contextAfterSave(dirty, '/tmp/new.tmap');
    expect(saved.savePath).toBe('/tmp/new.tmap');
    expect(saved.backupTarget).toBe('/tmp/new.tmap');
    expect(saved.dirty).toBe(false);
    // After the first save the project no longer needs 名前を付けて保存.
    expect(needsSaveAs(saved)).toBe(false);
  });
});
