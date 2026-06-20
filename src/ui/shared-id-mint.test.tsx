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

  it('two tools sharing ONE minter produce disjoint ids (no Add/Knife collision)', () => {
    // Simulate the App wiring: a single minter handed to two bootstraps.
    const mint = createSharedIdMint(() => projectWithOneLeaf());
    const addIds = [mint('v'), mint('f'), mint('r')];
    const knifeIds = [mint('v'), mint('f'), mint('r')];
    const all = new Set([...addIds, ...knifeIds]);
    expect(all.size).toBe(addIds.length + knifeIds.length);
  });
});
