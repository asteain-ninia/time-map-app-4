// 読み込みの間は書類を変える書き込みを断る（`docs/現状.md` の B120 の直し）。
//
// 店へ直接書く経路（履歴の漏斗 `App.recordCommand` を通らないもの）の表。1 行増やすのが、保存される中身を
// 書く口を足すときの手続きになる。実際の操作の通し検査は `e2e/load-gate.spec.ts`。

import { describe, expect, it, vi } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { BUNDLE_KIND } from '../discovery/index';

import { createSessionStore } from './store';

interface TestDomain {
  readonly tag: string;
}

const BUNDLE = {
  presetId: 'kana-area',
  label: 'b',
  kind: BUNDLE_KIND.Expression,
  expression: 'x',
  members: [
    { featureId: asFeatureId('a'), baselineName: 'a', baselineKindLabel: '' },
    { featureId: asFeatureId('b'), baselineName: 'b', baselineKindLabel: '' },
  ],
  cursor: 0,
  createdAt: '2026-09-05T00:00:00.000Z',
};

function storeOf() {
  return createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
}

const WRITES: ReadonlyArray<readonly [string, (s: ReturnType<typeof storeOf>) => void]> = [
  ['setDomainState', (s) => s.getState().setDomainState({ tag: 'd1' })],
  ['updateProjectSetting', (s) => s.getState().updateProjectSetting('gridVisible', false)],
  ['setProjectTimelineRangeYears', (s) => s.getState().setProjectTimelineRangeYears(10, 20)],
  ['setBundle', (s) => s.getState().setBundle(BUNDLE)],
];

describe('読み込みの間の書き込み', () => {
  it.each(WRITES)('%s: 読み込みの間は断って知らせ、何も変えない', (_name, write) => {
    const store = storeOf();
    const refused = vi.fn();
    store.getState().addLoadRefusalListener(refused);
    store.getState().setDocumentLoadActive(true);
    const before = store.getState();
    write(store);
    expect(refused).toHaveBeenCalledTimes(1);
    const after = store.getState();
    expect(after.domain).toBe(before.domain);
    expect(after.projectSettings).toBe(before.projectSettings);
    expect(after.ledger).toBe(before.ledger);
    expect(after.projectDirty).toBe(false);
  });

  it.each(WRITES)('%s: 読み込みが終われば普通に書ける（断りは残らない）', (_name, write) => {
    const store = storeOf();
    const refused = vi.fn();
    store.getState().addLoadRefusalListener(refused);
    store.getState().setDocumentLoadActive(true);
    store.getState().setDocumentLoadActive(false);
    write(store);
    expect(refused).not.toHaveBeenCalled();
    expect(store.getState().projectDirty).toBe(true);
  });

  it('束の送りも断る（送りは保存される）', () => {
    const store = storeOf();
    store.getState().setBundle(BUNDLE);
    const before = store.getState().ledger;
    store.getState().setDocumentLoadActive(true);
    store.getState().setBundleCursor(1);
    expect(store.getState().ledger).toBe(before);
  });

  it('アプリの設定は、書類を未保存にする鍵だけ断る', () => {
    const store = storeOf();
    store.getState().setDocumentLoadActive(true);
    const before = store.getState().appSettings;
    store.getState().updateAppSetting('renderFps', 30);
    expect(store.getState().appSettings).toBe(before);
    store.getState().updateAppSetting('showConflictGuide', !before.showConflictGuide);
    expect(store.getState().appSettings.showConflictGuide).toBe(!before.showConflictGuide);
    expect(store.getState().projectDirty).toBe(false);
  });

  it('反映は断らず、同じ書き込みで読み込みを終える', () => {
    const store = storeOf();
    store.getState().setDocumentLoadActive(true);
    const seen: boolean[] = [];
    store.subscribe((s) => seen.push(s.domain.tag === 'loaded' && s.documentLoadActive));
    store.getState().reflectLoadedProject({ tag: 'loaded' }, {});
    expect(store.getState().domain.tag).toBe('loaded');
    expect(store.getState().documentLoadActive).toBe(false);
    expect(seen).not.toContain(true);
  });

  it('動いていないときの関門は偽を返し、知らせない', () => {
    const store = storeOf();
    const refused = vi.fn();
    const remove = store.getState().addLoadRefusalListener(refused);
    expect(store.getState().refuseEditDuringLoad()).toBe(false);
    store.getState().setDocumentLoadActive(true);
    expect(store.getState().refuseEditDuringLoad()).toBe(true);
    remove();
    expect(store.getState().refuseEditDuringLoad()).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
