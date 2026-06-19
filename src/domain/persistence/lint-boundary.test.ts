// U14 受け入れ基準8 / R8 / FR-104 — the persistence parse boundary is enforced
// STRUCTURALLY, not by convention. External input (IPC / file read / external
// map input) may only become a domain `Manifest` through `parseManifest` (the
// Zod boundary in ./boundary.ts). The lower-level `deserialize` trusts its
// argument is an already-validated `Manifest`, so importing it from OUTSIDE the
// persistence module would smuggle unvalidated `unknown` into the domain.
//
// `eslint.config.js`'s `no-restricted-imports` rule (the `persistenceBoundary`
// block) forbids every consumer outside `src/domain/persistence/**` from
// importing `deserialize` — whether via `./persistence/serialize`, the
// `@/domain/persistence` barrel, or a relative `.../persistence` path.
//
// This test makes that guarantee REPRODUCIBLE: it runs the project's REAL
// ESLint flat config (no inline/duplicated rule definition) over in-memory
// source strings and asserts the rule actually FIRES on every forbidden import
// shape and stays SILENT for the allowed `parseManifest` entry and for the
// persistence module's own (exempt) files. It replaces the throwaway "__probe__"
// scaffold the earlier report relied on — that approach (a) left files behind
// that broke `tsc`, and (b) was not reproducible because ESLint ignores ad-hoc
// probe directories by default ("No files matching the pattern"). Linting text
// with an explicit `filePath` matches config by the path string, so no files
// touch the tree and the check is deterministic.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Project root = three levels up from src/domain/persistence/.
const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const RULE = 'no-restricted-imports';

let eslint: ESLint;

beforeAll(() => {
  // Use the repository's real eslint.config.js (overrideConfigFile defaults to
  // auto-discovery from cwd) so this test verifies the SHIPPED rule, not a copy.
  eslint = new ESLint({ cwd: projectRoot });
});

/** Lint a source string as if it lived at `relPath`; return triggered rule ids. */
async function ruleIdsFor(code: string, relPath: string): Promise<(string | null)[]> {
  const results = await eslint.lintText(code, {
    filePath: path.join(projectRoot, relPath),
  });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId));
}

describe('persistence parse boundary is structurally enforced by ESLint (受け入れ基準8 / R8)', () => {
  it('FIRES when an outside consumer imports deserialize from the serialize module', async () => {
    const ids = await ruleIdsFor(
      `import { deserialize } from '@/domain/persistence/serialize';\nconsole.log(deserialize);\n`,
      'src/ui/__boundary_check__.ts',
    );
    expect(ids).toContain(RULE);
  });

  it('FIRES when an outside consumer imports deserialize via the @/ barrel', async () => {
    const ids = await ruleIdsFor(
      `import { deserialize } from '@/domain/persistence';\nconsole.log(deserialize);\n`,
      'src/ui/__boundary_check__.ts',
    );
    expect(ids).toContain(RULE);
  });

  it('FIRES when an outside consumer imports deserialize via a relative serialize path', async () => {
    const ids = await ruleIdsFor(
      `import { deserialize } from '../domain/persistence/serialize';\nconsole.log(deserialize);\n`,
      'src/render/__boundary_check__.ts',
    );
    expect(ids).toContain(RULE);
  });

  it('FIRES when an outside consumer imports deserialize via a relative barrel path', async () => {
    const ids = await ruleIdsFor(
      `import { deserialize } from '../domain/persistence';\nconsole.log(deserialize);\n`,
      'src/render/__boundary_check__.ts',
    );
    expect(ids).toContain(RULE);
  });

  it('stays SILENT for the allowed boundary entry parseManifest', async () => {
    const ids = await ruleIdsFor(
      `import { parseManifest } from '@/domain/persistence';\nconsole.log(parseManifest);\n`,
      'src/ui/__boundary_check__.ts',
    );
    expect(ids).not.toContain(RULE);
  });

  it('stays SILENT for serialize (write side is public, not the boundary hole)', async () => {
    const ids = await ruleIdsFor(
      `import { serialize } from '@/domain/persistence';\nconsole.log(serialize);\n`,
      'src/ui/__boundary_check__.ts',
    );
    expect(ids).not.toContain(RULE);
  });

  it('EXEMPTS the persistence module itself (round-trip imports deserialize internally)', async () => {
    const ids = await ruleIdsFor(
      `import { deserialize } from './serialize';\nconsole.log(deserialize);\n`,
      'src/domain/persistence/__boundary_check__.ts',
    );
    expect(ids).not.toContain(RULE);
  });
});
