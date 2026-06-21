// Regression for finding 3: the composition root's SHARED id minter must seed
// from existing project ids AND never repeat across calls, so Add and Knife
// (which share it) cannot collide with each other or with loaded data.

import { describe, expect, it } from 'vitest';

import { collectProjectRawIds, createSharedIdMint } from './App';
import {
  DEFAULT_SETTINGS,
  DEFAULT_BASEMAP,
  singleAnchorHistory,
  squareLeaf,
} from '../domain/persistence/fixtures';
import type { DomainProject } from '../domain/persistence/index';
import { createVertexStore } from '../domain/vertex';

function projectWithOneLeaf(): DomainProject {
  const leaf = squareLeaf('seed', '種国', 0, 0);
  return {
    histories: [singleAnchorHistory('seed', [leaf.feature], createVertexStore(leaf.vertices))],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('createSharedIdMint (finding 3: single generator + reservation set)', () => {
  it('collects every feature / vertex / ring id present in the project', () => {
    const ids = collectProjectRawIds(projectWithOneLeaf());
    // The leaf feature, its 4 vertices, its ring, plus the history featureId.
    expect(ids.has('seed')).toBe(true);
    expect(ids.has('seed-r')).toBe(true); // the ring id from squareLeaf
    expect(ids.has('seed-0')).toBe(true); // a vertex id
    expect(ids.has('seed-3')).toBe(true);
  });

  it('never reissues an id within one minter (Add+Knife share it)', () => {
    const mint = createSharedIdMint(() => projectWithOneLeaf());
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      // alternate prefixes the way add (f/v/r) and knife (f/v/r) both do
      const id = mint(i % 3 === 0 ? 'f' : i % 3 === 1 ? 'v' : 'r');
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('never mints an id that already exists in the loaded project', () => {
    const project = projectWithOneLeaf();
    const existing = collectProjectRawIds(project);
    const mint = createSharedIdMint(() => project);
    for (let i = 0; i < 50; i += 1) {
      const id = mint('v');
      expect(existing.has(id)).toBe(false);
    }
  });

  it('does NOT re-scan the whole project on every mint (bughunt2 perf)', () => {
    // The old code called collectProjectRawIds(getRoot()) on EVERY mint, so
    // assembling one add proposal with V vertices did V+ full project
    // traversals → O(V × project_size). The root is immutable until commit, so
    // a stable root must be scanned exactly ONCE across many mints. We count how
    // often the project actually gets WALKED by wrapping the histories array in
    // an access-counting proxy (collectProjectRawIds reads root.histories).
    const project = projectWithOneLeaf();
    let histAccesses = 0;
    const counting: DomainProject = new Proxy(project, {
      get(target, prop, receiver) {
        if (prop === 'histories') histAccesses += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const mint = createSharedIdMint(() => counting);
    for (let i = 0; i < 100; i += 1) mint('v');
    // Exactly one scan for the single immutable root, not one per mint.
    expect(histAccesses).toBe(1);
  });

  it('re-scans only when the root reference changes (next commit)', () => {
    // After a commit the store hands back a NEW immutable root object, so the
    // cache must invalidate and freshly include the newly-committed ids.
    let current = projectWithOneLeaf();
    const mint = createSharedIdMint(() => current);
    // First batch over root A → one scan's worth of work, all ids disjoint.
    const batchA = [mint('v'), mint('v'), mint('f')];
    // Simulate a commit: a brand-new root object (different identity) that now
    // also contains a second leaf, so its ids must be respected too.
    const second = squareLeaf('seed2', '種国2', 10, 10);
    current = {
      histories: [
        ...projectWithOneLeaf().histories,
        singleAnchorHistory('seed2', [second.feature], createVertexStore(second.vertices)),
      ],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const existingAfterCommit = collectProjectRawIds(current);
    const batchB = [mint('v'), mint('f'), mint('r')];
    // None of batch B may collide with the now-larger project…
    for (const id of batchB) expect(existingAfterCommit.has(id)).toBe(false);
    // …nor with anything issued in batch A (session reservation persists).
    const all = new Set([...batchA, ...batchB]);
    expect(all.size).toBe(batchA.length + batchB.length);
  });

  it('two tools sharing ONE minter produce disjoint ids (no Add/Knife collision)', () => {
    // Simulate the App wiring: a single minter handed to two bootstraps.
    const mint = createSharedIdMint(() => projectWithOneLeaf());
    const addIds = [mint('v'), mint('f'), mint('r')];
    const knifeIds = [mint('v'), mint('f'), mint('r')];
    const all = new Set([...addIds, ...knifeIds]);
    expect(all.size).toBe(addIds.length + knifeIds.length);
  });
});
