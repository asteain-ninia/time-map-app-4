// 普段用の短い確認（npm run check）。受け入れの全件ゲートの代わりにはならない。
//
//   npm run check                いま手元で変えている分（未コミット＋未追跡）を見る
//   npm run check -- --base=HEAD~3   そのコミットからの変更を見る
//
// 順に走らせ、最初の赤で止まる:
//   1. 型検査（増分。キャッシュは node_modules/.cache/tsc）
//   2. lint（増分。キャッシュは node_modules/.cache/eslint）
//   3. 単体: 変更が import 経由で届くテスト（vitest --changed）
//   4. 単体: ソースや CSS を文字として読むテスト（TEXT_READING_TESTS。--changed では拾えない）
//   5. E2E: src か e2e が変わっていれば build して launch.spec.ts と、変えた spec だけ
//
// 見逃す範囲（開発ガイド §1.12）:
//   - E2E は変えた spec と起動の確認だけ。アプリ本体を変えても、そこを通る他の spec は走らない。
//   - lint のキャッシュはファイルの中身と設定で判定する。別のファイルの変更で赤に変わる規則
//     （import の解決先の消失など）は、触っていないファイルでは再検査されない。
//   - --changed は静的な import をたどる。動的に組み立てたパスや実データは追えない。
// だから受け入れでは全件のゲート（typecheck、lint、test、build、e2e、e2e:explore）を通す。
import { spawnSync } from 'node:child_process';

/** ソースや CSS を文字として読むので、import をたどっても届かないテスト。実データを開くものは入れない。 */
const TEXT_READING_TESTS = [
  'src/test-support/',
  'src/domain/perf/offline-egress.test.ts',
  'src/domain/persistence/lint-boundary.test.ts',
  'src/ui/a11y/modal-registration.test.tsx',
  'src/ui/add/add-input-layout.test.tsx',
  'src/ui/knife/InheritorModal.preview-geometry.test.tsx',
  'src/ui/map/mount/render.test.ts',
  'src/ui/property/property-layout.test.ts',
  'src/ui/shell/command-result.test.ts',
  'src/ui/shell/shell-layout.test.ts',
  'src/ui/shell/ui-text-catalog.test.ts',
  'src/ui/shell/ui-text-tables.test.ts',
  'src/ui/shell/visual-unity.test.ts',
];

const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const base = baseArg === undefined ? undefined : baseArg.slice('--base='.length);

function run(label, command) {
  const started = Date.now();
  console.log(`\n=== ${label}\n$ ${command}`);
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`\n[check] 赤: ${label}（${seconds} 秒）`);
    process.exit(result.status ?? 1);
  }
  console.log(`[check] 緑: ${label}（${seconds} 秒）`);
}

function gitLines(command) {
  const result = spawnSync(command, { encoding: 'utf8', shell: true });
  if (result.status !== 0) throw new Error(`git が失敗した: ${command}\n${result.stderr}`);
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

const changed = [
  ...gitLines(`git -c core.quotepath=off diff --name-only ${base ?? 'HEAD'}`),
  ...gitLines('git -c core.quotepath=off ls-files --others --exclude-standard'),
];

run('型検査（増分）', 'npm run -s typecheck');
run('lint（増分）', 'npm run -s lint:cached');
run('単体（変更が届くもの）', `npx vitest run --changed ${base ?? ''} --passWithNoTests`);
run('単体（文字として読むもの）', `npx vitest run ${TEXT_READING_TESTS.join(' ')}`);

const isAppSource = (file) => file.startsWith('src/') && !/\.test\.tsx?$/.test(file);
const specs = changed.filter((file) => file.startsWith('e2e/') && file.endsWith('.spec.ts'));
const helperChanged = changed.some((file) => file.startsWith('e2e/') && !file.endsWith('.spec.ts'));
if (changed.some(isAppSource) || specs.length > 0 || helperChanged) {
  run('build', 'npm run -s build');
  const targets = ['e2e/launch.spec.ts', ...specs].join(' ');
  run('E2E（起動の確認と、変えた spec）', `npx playwright test --project=main --project=explore ${targets}`);
  if (helperChanged) {
    console.log('[check] 注意: e2e の共通部品を変えた。全部の spec に関わるので、npm run e2e を流すこと。');
  }
} else {
  console.log('\n[check] src（テスト以外）も e2e も変わっていないので、E2E は走らせない。');
}
console.log('\n[check] 短い確認は緑。受け入れでは全件のゲートを通すこと（開発ガイド §1.12）。');
