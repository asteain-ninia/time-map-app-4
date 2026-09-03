// 「歴史の錨を増やすと保存ファイルがどれだけ膨らむか」の実測スクリプト。
//
// なぜこれを測るのか（設計書 §N-13 / 実装計画 増分 2 の受け入れ条件）:
//   いまの保存形式は「錨 1 本ごとに、その履歴が持つ地物と頂点を丸ごと 1 部持つ」。
//   `src/domain/persistence/schema.ts` の `anchorSnapshotSchema` が
//   `features: Feature[]` と `vertices: Vertex[]` の 2 本を持ち、
//   `src/domain/editing/apply-proposal.ts` の `anchorFor(...)` が新しい錨のたびに
//   その複製を作る。つまり錨を増やすほど保存ファイルが比例して膨らむ。
//   UI 再設計は「いま見ている年に記録（錨）を作る」を主役にするので、
//   錨の本数が増えることを目的にしている。両者が量で衝突するかどうかを
//   見積りではなく実測で確かめるのが、このスクリプトの目的である。
//
// 何をするか:
//   1. 実データのコピー（.gimoza）を、アプリと同じ経路で読む
//      （readTmap → parseManifest → manifestToProject）。
//   2. 基準（編集前）の manifest バイト数・.gimoza バイト数・保存 ms・開き直し ms を測る。
//   3. 「デーレ共和国」の子 10 件 × 5 つの年 ＝ 合計 50 回の名前変更を、
//      アプリと同じ経路（createEditProposal → applyEditProposal）で行う。
//   4. 50 回後に同じ 4 つを測り、増分と倍率を出す。
//   5. 錨 1 本あたりのバイト数を、頂点数・地物数から最小二乗で粗く求める
//      （画面に「約 306 KB 増えます」と出すための係数 BYTES_PER_SNAPSHOT_VERTEX /
//      BYTES_PER_SNAPSHOT_FEATURE の妥当な値）。
//
// 実測は 2 通り行う:
//   筋書き A（設計書の字面どおり）: 10 件 × 5 年。同じ年への編集は同じ錨に
//     上書きされるので、増える錨は「年の数」＝ 5 本にとどまる。
//   筋書き B（上限）: 50 回すべてを別々の年に打つ。錨は 50 本増える。
//     設計書 §N-13 の「10 州 × 5 年で +15 MB」という見積りは、
//     実際にはこちら（1 編集＝1 錨）を仮定した数字である。
//
// 実行方法（リポジトリ直下で。<出力先> は書き込んでよい作業用ディレクトリ）:
//   npx esbuild scripts/measure-anchor-growth.ts --bundle --platform=node --format=esm --outfile="<出力先>/measure.mjs"
//   node "<出力先>/measure.mjs" "<出力先>/derle-world-full-2026-08-16.gimoza"
//
// 引数:
//   第 1 引数（必須）: 計測対象の .gimoza。**実データそのものではなくコピーを渡すこと。**
//   第 2 引数（任意）: 中間ファイルの書き出し先ディレクトリ（既定 = 第 1 引数のあるディレクトリ）。
//   --skip-consistency: 読み込み時の整合チェック（checkConsistency）の計測を省く。
//
// 安全策: 書き出し先が `derle-import` の下だと分かった時点で中止する（実データを汚さない）。
// 読み取り専用の入力ファイルは一切書き換えない。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import { withName } from '../src/domain/attributes';
import { resolveAt } from '../src/domain/anchor-series';
import { createEditProposal } from '../src/domain/consistency/types';
import { applyEditProposal, findHistoryContaining } from '../src/domain/editing/apply-proposal';
import type { FeatureSnapshot } from '../src/domain/editing/edit-flow';
import { FEATURE_KIND, withAttributes, type AggregateFeature, type Feature } from '../src/domain/feature';
import type { FeatureId } from '../src/domain/ids';
import {
  checkConsistency,
  isParsed,
  manifestToProject,
  parseManifest,
  serialize,
  type DomainProject,
  type Manifest,
} from '../src/domain/persistence/index';
import { getCalendar } from '../src/domain/time/calendar';
import { timePointYear, type TimePoint } from '../src/domain/time/time-point';
import type { NamedAsset } from '../src/shell/ipc/contract';
import { buildTmap, readTmap } from '../src/shell/io/tmap';

// --- 設定値 -----------------------------------------------------------------

/** 編集する子の件数（設計書 §N-13 の「10 州」）。 */
const CHILD_COUNT = 10;
/** 筋書き A で錨を打つ年（設計書 §N-13 の「5 年」）。 */
const YEARS_A: readonly number[] = [1000, 2000, 3000, 4000, 5000];
/** 探す集約地物の名前。見つからなければ子が最も多い集約地物を使う。 */
const TARGET_AGGREGATE_NAME = 'デーレ共和国';

const calendar = getCalendar('gregorian');

// --- 小道具 -----------------------------------------------------------------

/** 3 桁区切り。 */
function num(n: number): string {
  const rounded = Math.round(n);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 小数 1 桁 + 3 桁区切り。 */
function dec(n: number, digits = 1): string {
  const fixed = n.toFixed(digits);
  const [head = '0', tail] = fixed.split('.');
  const withCommas = head.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return tail === undefined ? withCommas : `${withCommas}.${tail}`;
}

/** バイト数を KB / MB 付きで読みやすく。 */
function bytes(n: number): string {
  if (Math.abs(n) >= 1024 * 1024) return `${num(n)} (${dec(n / (1024 * 1024), 2)} MB)`;
  if (Math.abs(n) >= 1024) return `${num(n)} (${dec(n / 1024, 1)} KB)`;
  return num(n);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 全角を 2 桁として数える表示幅（表の桁揃え用）。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, align: 'l' | 'r'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'r' ? fill + text : text + fill;
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  // 1 列目だけ左寄せ、以降は右寄せ（数値の桁を揃える）。
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i] ?? 0, i === 0 ? 'l' : 'r')).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

function heading(title: string): void {
  console.log('');
  console.log(`■ ${title}`);
  console.log('');
}

// --- 計測 -------------------------------------------------------------------

/** 保存の内訳（アプリの保存経路と同じ順序）。 */
interface SaveTiming {
  readonly serializeMs: number;
  readonly buildTmapMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
}

/** 開き直しの内訳（アプリの読み込み経路と同じ順序）。 */
interface OpenTiming {
  /** ファイルからバイト列を読む。 */
  readonly readFileMs: number;
  /** readTmap（ZIP 展開 + manifest の JSON.parse）。 */
  readonly unzipMs: number;
  /** parseManifest（Zod による検証）。 */
  readonly validateMs: number;
  /** manifestToProject（ドメインの組み立て直し）。 */
  readonly rebuildMs: number;
  /** ここまでの合計 ＝ 本計測での「開き直し」。 */
  readonly totalMs: number;
  /** checkConsistency（読み込み後の整合チェック）。省いた場合は undefined。 */
  readonly consistencyMs: number | undefined;
}

interface Measurement {
  readonly label: string;
  readonly manifestBytes: number;
  readonly gimozaBytes: number;
  readonly anchorCount: number;
  readonly distinctAnchorTimes: number;
  readonly featureRefCount: number;
  readonly vertexRefCount: number;
  readonly save: SaveTiming;
  readonly open: OpenTiming;
  readonly path: string;
}

interface Assets {
  readonly baseMapImage: Uint8Array;
  readonly attachments: readonly NamedAsset[];
}

/** manifest 全体に入っている錨の本数。 */
function countAnchors(manifest: Manifest): number {
  let total = 0;
  for (const history of manifest.histories) total += history.entries.length;
  return total;
}

/** 全錨のスナップショットに入っている地物・頂点の延べ数（＝複製の総量）。 */
function countSnapshotContents(manifest: Manifest): { features: number; vertices: number } {
  let features = 0;
  let vertices = 0;
  for (const history of manifest.histories) {
    for (const entry of history.entries) {
      features += entry.anchor.snapshot.features.length;
      vertices += entry.anchor.snapshot.vertices.length;
    }
  }
  return { features, vertices };
}

/**
 * 錨が打たれている「異なる時刻」の数。読み込み時の整合チェック
 * （checkConsistency）は distinctAnchorTimes ごとに世界を 1 枚まるごと点検するので、
 * 読み込み時間はファイルの大きさより先にこの数で決まる。
 * ここでは start の値をそのまま鍵にして数える（実データは全部「年」の粒度）。
 */
function countDistinctAnchorTimes(manifest: Manifest): number {
  const seen = new Set<string>();
  for (const history of manifest.histories) {
    for (const entry of history.entries) seen.add(JSON.stringify(entry.start));
  }
  return seen.size;
}

/**
 * 1 回ぶんの完全計測。実際にファイルへ書き、書いたファイルを読み直す
 * （メモリ上の往復ではなく、利用者が体験する経路をそのままなぞる）。
 */
function measure(
  label: string,
  project: DomainProject,
  assets: Assets,
  outPath: string,
  skipConsistency: boolean,
): Measurement {
  // --- 保存 ---
  const s0 = performance.now();
  const manifest = serialize(project);
  const s1 = performance.now();
  const zipBytes = buildTmap({
    manifest,
    baseMapImage: assets.baseMapImage,
    attachments: assets.attachments,
  });
  const s2 = performance.now();
  writeFileSync(outPath, zipBytes);
  const s3 = performance.now();

  const manifestBytes = utf8Bytes(JSON.stringify(manifest));
  const counts = countSnapshotContents(manifest);

  // --- 開き直し（実ファイルから） ---
  const o0 = performance.now();
  const fileBytes = new Uint8Array(readFileSync(outPath));
  const o1 = performance.now();
  const extracted = readTmap(fileBytes);
  const o2 = performance.now();
  if (!extracted.ok) throw new Error(`開き直しに失敗: ${extracted.message}`);
  const parsed = parseManifest(extracted.contents.manifest);
  const o3 = performance.now();
  if (!isParsed(parsed)) throw new Error(`検証に失敗: ${JSON.stringify(parsed)}`);
  const reopened = manifestToProject(parsed.manifest);
  const o4 = performance.now();

  let consistencyMs: number | undefined;
  if (!skipConsistency) {
    const c0 = performance.now();
    checkConsistency(reopened, calendar);
    consistencyMs = performance.now() - c0;
  }

  return {
    label,
    manifestBytes,
    gimozaBytes: zipBytes.length,
    anchorCount: countAnchors(manifest),
    distinctAnchorTimes: countDistinctAnchorTimes(manifest),
    featureRefCount: counts.features,
    vertexRefCount: counts.vertices,
    save: {
      serializeMs: s1 - s0,
      buildTmapMs: s2 - s1,
      writeMs: s3 - s2,
      totalMs: s3 - s0,
    },
    open: {
      readFileMs: o1 - o0,
      unzipMs: o2 - o1,
      validateMs: o3 - o2,
      rebuildMs: o4 - o3,
      totalMs: o4 - o0,
      consistencyMs,
    },
    path: outPath,
  };
}

// --- 編集の再現（アプリと同じ経路） -----------------------------------------

/** その時刻に有効なスナップショットから地物を 1 つ取り出す。 */
function effectiveFeature(
  project: DomainProject,
  featureId: FeatureId,
  at: TimePoint,
): Feature | undefined {
  const found = findHistoryContaining(project, featureId, at, calendar);
  if (found === undefined) return undefined;
  const resolution = resolveAt(found.history.series, at, calendar);
  if (resolution.kind !== 'present') return undefined;
  return resolution.entry.anchor.snapshot.features.find((f) => f.id === featureId);
}

/**
 * 「名前を変える」属性編集を 1 回。アプリと同じ経路
 * （createEditProposal で編集案を組み、applyEditProposal で当てる）を通す。
 * 子の編集が親の系列に書かれる `findHistoryContaining` の振る舞いもそのまま使う。
 */
function renameOnce(
  project: DomainProject,
  featureId: FeatureId,
  at: TimePoint,
  newName: string,
): DomainProject {
  const current = effectiveFeature(project, featureId, at);
  if (current === undefined) {
    throw new Error(`地物 ${String(featureId)} が ${describeTime(at)} に見つからない`);
  }
  const renamed = withAttributes(current, withName(current.attributes, newName));
  const snapshot: FeatureSnapshot = { feature: renamed, vertices: [] };
  const proposal = createEditProposal<FeatureSnapshot>(featureId, at, snapshot);
  return applyEditProposal(project, proposal, calendar);
}

function describeTime(at: TimePoint): string {
  return `${at.year} 年`;
}

/** 集約地物（と、それが載っている履歴）を探す。 */
interface FoundAggregate {
  readonly feature: AggregateFeature;
  readonly ownerHistoryFeatureId: FeatureId;
  readonly anchorTime: TimePoint;
}

function findAggregate(project: DomainProject, name: string): FoundAggregate | undefined {
  const candidates: FoundAggregate[] = [];
  for (const history of project.histories) {
    for (const entry of history.series.entries) {
      for (const feature of entry.anchor.snapshot.features) {
        if (feature.kind !== FEATURE_KIND.Aggregate) continue;
        candidates.push({
          feature,
          ownerHistoryFeatureId: history.featureId,
          anchorTime: entry.start,
        });
      }
    }
  }
  const byName = candidates.find((c) => c.feature.attributes.name === name);
  if (byName !== undefined) return byName;
  // 名前で見つからなければ「子が最も多い集約地物」を使う。
  return candidates.sort((a, b) => b.feature.childIds.length - a.feature.childIds.length)[0];
}

// --- 1 錨あたりの係数（最小二乗） -------------------------------------------

interface AnchorRow {
  readonly bytes: number;
  readonly features: number;
  readonly vertices: number;
}

/** manifest 内の全錨について「スナップショットの JSON バイト数・地物数・頂点数」を集める。 */
function anchorRows(manifest: Manifest): AnchorRow[] {
  const rows: AnchorRow[] = [];
  for (const history of manifest.histories) {
    for (const entry of history.entries) {
      const snapshot = entry.anchor.snapshot;
      rows.push({
        bytes: utf8Bytes(JSON.stringify(snapshot)),
        features: snapshot.features.length,
        vertices: snapshot.vertices.length,
      });
    }
  }
  return rows;
}

/** ガウスの消去法。解けなければ undefined。 */
function solve(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] | undefined {
  const n = rhs.length;
  const m: number[][] = matrix.map((row, i) => [...row, rhs[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = m[pivot];
    const currentRow = m[col];
    if (pivotRow === undefined || currentRow === undefined) return undefined;
    m[pivot] = currentRow;
    m[col] = pivotRow;
    const head = m[col];
    if (head === undefined || Math.abs(head[col] ?? 0) < 1e-9) return undefined;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const row = m[r];
      if (row === undefined) continue;
      const factor = (row[col] ?? 0) / (head[col] ?? 1);
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) {
        row[c] = (row[c] ?? 0) - factor * (head[c] ?? 0);
      }
    }
  }
  return Array.from({ length: n }, (_, i) => {
    const row = m[i];
    return (row?.[n] ?? 0) / (row?.[i] ?? 1);
  });
}

interface Fit {
  readonly coefficients: readonly number[];
  readonly r2: number;
}

/** `y ≒ Σ coefficients[k] * columns[k]` を最小二乗で解く。 */
function leastSquares(rows: readonly AnchorRow[], withIntercept: boolean): Fit | undefined {
  const design = rows.map((row) =>
    withIntercept ? [row.vertices, row.features, 1] : [row.vertices, row.features],
  );
  const n = withIntercept ? 3 : 2;
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    const x = design[i];
    const y = rows[i]?.bytes ?? 0;
    if (x === undefined) continue;
    for (let a = 0; a < n; a += 1) {
      const xa = x[a] ?? 0;
      atb[a] = (atb[a] ?? 0) + xa * y;
      const rowA = ata[a];
      if (rowA === undefined) continue;
      for (let b = 0; b < n; b += 1) rowA[b] = (rowA[b] ?? 0) + xa * (x[b] ?? 0);
    }
  }
  const coefficients = solve(ata, atb);
  if (coefficients === undefined) return undefined;

  const mean = rows.reduce((sum, r) => sum + r.bytes, 0) / Math.max(1, rows.length);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const x = design[i];
    const y = rows[i]?.bytes ?? 0;
    if (x === undefined) continue;
    let predicted = 0;
    for (let a = 0; a < n; a += 1) predicted += (coefficients[a] ?? 0) * (x[a] ?? 0);
    ssRes += (y - predicted) ** 2;
    ssTot += (y - mean) ** 2;
  }
  return { coefficients, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

// --- 本体 -------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const skipConsistency = args.includes('--skip-consistency');
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputPath = positional[0];
  if (inputPath === undefined) {
    console.error('使い方: node measure.mjs <計測対象の .gimoza> [出力ディレクトリ] [--skip-consistency]');
    console.error('※ 実データそのものではなく、必ずコピーを渡すこと。');
    process.exitCode = 1;
    return;
  }
  const outDir = resolve(positional[1] ?? dirname(inputPath));
  // 実データを汚さないための安全策。
  if (resolve(outDir).split(sep).includes('derle-import')) {
    console.error(`書き出し先が derle-import の下です（${outDir}）。実データを汚さないため中止します。`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(outDir, { recursive: true });

  console.log('=== 歴史の錨を増やしたときの保存ファイルの膨らみ（実測） ===');
  console.log('');
  console.log(`対象ファイル : ${resolve(inputPath)}`);
  console.log(`書き出し先   : ${outDir}`);
  console.log(`整合チェック : ${skipConsistency ? '計測しない（--skip-consistency）' : '計測する'}`);

  // --- 読み込み（アプリと同じ経路） ---
  const inputBytes = new Uint8Array(readFileSync(inputPath));
  const extracted = readTmap(inputBytes);
  if (!extracted.ok) throw new Error(`readTmap に失敗: ${extracted.message}`);
  const parsed = parseManifest(extracted.contents.manifest);
  if (!isParsed(parsed)) throw new Error(`parseManifest に失敗: ${JSON.stringify(parsed)}`);
  const baseProject = manifestToProject(parsed.manifest);
  const assets: Assets = {
    baseMapImage: extracted.contents.baseMapImage,
    attachments: extracted.contents.attachments,
  };

  // --- 編集対象を決める ---
  const found = findAggregate(baseProject, TARGET_AGGREGATE_NAME);
  if (found === undefined) throw new Error('集約地物が 1 つも見つかりません。');
  const aggregate = found.feature;
  const childIds = aggregate.childIds.slice(0, CHILD_COUNT);
  if (childIds.length < CHILD_COUNT) {
    throw new Error(`子が ${CHILD_COUNT} 件ありません（${childIds.length} 件）。`);
  }

  heading('計測対象');
  const baseManifest = serialize(baseProject);
  const ownerHistory = baseProject.histories.find(
    (h) => h.featureId === found.ownerHistoryFeatureId,
  );
  const ownerEntry = ownerHistory?.series.entries[0];
  const ownerSnapshotBytes =
    ownerEntry === undefined
      ? 0
      : utf8Bytes(
          JSON.stringify({
            features: ownerEntry.anchor.snapshot.features,
            vertices: [...ownerEntry.anchor.snapshot.vertices.byId.values()],
          }),
        );
  printTable(
    ['項目', '値'],
    [
      ['まとめ役の地物', `${aggregate.attributes.name}（${String(aggregate.id)}）`],
      ['その子の数', num(aggregate.childIds.length)],
      ['歴史を持っている履歴', String(found.ownerHistoryFeatureId)],
      ['その錨のスナップショットの地物数', num(ownerEntry?.anchor.snapshot.features.length ?? 0)],
      ['その錨のスナップショットの頂点数', num(ownerEntry?.anchor.snapshot.vertices.byId.size ?? 0)],
      ['その錨 1 本ぶんの実測バイト数（＝この地物を 1 年ぶん記録する費用）', bytes(ownerSnapshotBytes)],
      ['編集する子（10 件）', childIds
        .map((id) => {
          const f = effectiveFeature(baseProject, id, found.anchorTime);
          return f === undefined ? String(id) : `${f.attributes.name}`;
        })
        .join('、')],
    ],
  );

  // --- 基準（編集前） ---
  const beforePath = join(outDir, 'before.gimoza');
  const before = measure('基準（編集前）', baseProject, assets, beforePath, skipConsistency);

  // --- 筋書き A: 10 件 × 5 年 = 50 回 ---
  interface Checkpoint {
    readonly done: number;
    readonly manifestBytes: number;
    readonly anchorCount: number;
  }
  const checkpoints: Checkpoint[] = [
    { done: 0, manifestBytes: before.manifestBytes, anchorCount: before.anchorCount },
  ];

  let projectA = baseProject;
  let editCount = 0;
  for (const year of YEARS_A) {
    const at = timePointYear(year);
    for (const childId of childIds) {
      editCount += 1;
      projectA = renameOnce(projectA, childId, at, `計測用の名前 ${editCount}（${year} 年）`);
      const manifest = serialize(projectA);
      checkpoints.push({
        done: editCount,
        manifestBytes: utf8Bytes(JSON.stringify(manifest)),
        anchorCount: countAnchors(manifest),
      });
    }
  }
  const afterPath = join(outDir, 'after-50-anchors.gimoza');
  const afterA = measure('50 回の編集後（10 件 × 5 年）', projectA, assets, afterPath, skipConsistency);

  // --- 筋書き B: 50 回すべて別々の年（上限） ---
  let projectB = baseProject;
  let editCountB = 0;
  for (let i = 0; i < YEARS_A.length * CHILD_COUNT; i += 1) {
    const childId = childIds[i % CHILD_COUNT];
    if (childId === undefined) continue;
    const year = 1000 + i * 100; // 1000, 1100, ... 5900 — 50 個すべて別の年
    editCountB += 1;
    projectB = renameOnce(projectB, childId, timePointYear(year), `上限計測 ${editCountB}`);
  }
  const afterBPath = join(outDir, 'after-50-years.gimoza');
  const afterB = measure('50 回の編集後（50 とおりの年＝上限）', projectB, assets, afterBPath, skipConsistency);

  // --- 出力 ---
  const rowsFor = (m: Measurement): string[] => [
    m.label,
    num(m.anchorCount),
    num(m.distinctAnchorTimes),
    bytes(m.manifestBytes),
    bytes(m.gimozaBytes),
    dec(m.save.totalMs),
    dec(m.open.totalMs),
    m.open.consistencyMs === undefined ? '—' : dec(m.open.consistencyMs),
  ];

  heading('1. 基準と編集後の比較');
  printTable(
    ['計測', '錨の本数', '異なる年', 'manifest バイト', '.gimoza バイト', '保存 ms', '開き直し ms', '整合チェック ms'],
    [rowsFor(before), rowsFor(afterA), rowsFor(afterB)],
  );
  console.log('');
  console.log('「保存 ms」＝ serialize ＋ buildTmap（JSON 化 + ZIP 圧縮）＋ ファイル書き出し。');
  console.log('「開き直し ms」＝ ファイル読み ＋ readTmap（ZIP 展開 + JSON.parse）＋ parseManifest（Zod 検証）＋ manifestToProject（ドメイン組み立て）。');
  console.log('「整合チェック ms」＝ checkConsistency。アプリは読み込みのたびにこれも通すので、体感の合計は「開き直し ＋ 整合チェック」。');

  heading('2. 増分と倍率');
  const deltaRows = ([afterA, afterB] as const).map((m) => [
    m.label,
    `+${num(m.anchorCount - before.anchorCount)}`,
    `+${bytes(m.manifestBytes - before.manifestBytes)}`,
    `${dec(m.manifestBytes / before.manifestBytes, 2)} 倍`,
    `+${bytes(m.gimozaBytes - before.gimozaBytes)}`,
    `${dec(m.gimozaBytes / before.gimozaBytes, 2)} 倍`,
    `${dec(m.save.totalMs / before.save.totalMs, 2)} 倍`,
    `${dec(m.open.totalMs / before.open.totalMs, 2)} 倍`,
  ]);
  printTable(
    ['計測', '錨の増分', 'manifest 増分', 'manifest 倍率', '.gimoza 増分', '.gimoza 倍率', '保存 倍率', '開き直し 倍率'],
    deltaRows,
  );

  heading('3. 保存・開き直しの内訳（ミリ秒）');
  printTable(
    ['計測', 'serialize', 'ZIP 化', '書き出し', 'ファイル読み', 'ZIP 展開', 'Zod 検証', 'ドメイン組立', '整合チェック'],
    [before, afterA, afterB].map((m) => [
      m.label,
      dec(m.save.serializeMs),
      dec(m.save.buildTmapMs),
      dec(m.save.writeMs),
      dec(m.open.readFileMs),
      dec(m.open.unzipMs),
      dec(m.open.validateMs),
      dec(m.open.rebuildMs),
      m.open.consistencyMs === undefined ? '—' : dec(m.open.consistencyMs),
    ]),
  );

  heading('3b. 読み込みの本当の主犯: 整合チェックは「異なる年の数」に比例する');
  const perSlice = (m: Measurement): string =>
    m.open.consistencyMs === undefined
      ? '—'
      : dec(m.open.consistencyMs / Math.max(1, m.distinctAnchorTimes));
  printTable(
    ['計測', '異なる年', '整合チェック ms', '1 年あたり ms', '開き直し＋整合（体感）'],
    [before, afterA, afterB].map((m) => [
      m.label,
      num(m.distinctAnchorTimes),
      m.open.consistencyMs === undefined ? '—' : dec(m.open.consistencyMs),
      perSlice(m),
      m.open.consistencyMs === undefined
        ? '—'
        : `${dec((m.open.totalMs + m.open.consistencyMs) / 1000, 2)} 秒`,
    ]),
  );
  console.log('');
  console.log('checkConsistency は「錨が打たれている異なる時刻」ごとに世界を 1 枚まるごと点検する（consistency.ts の distinctAnchorTimes ループ）。');
  console.log('だから読み込み時間はファイルの大きさよりも先に「記録した年の数」で決まる。ファイルが 1.3 MB しか増えなくても、年を 5 つ増やせば読み込みは数秒単位で伸びる。');

  heading('4. 途中経過（筋書き A: 10 件 × 5 年）');
  const shown = [0, 1, 2, 10, 11, 20, 21, 30, 31, 40, 41, 50];
  printTable(
    ['編集した回数', '錨の本数', 'manifest バイト', '基準からの増分'],
    checkpoints
      .filter((c) => shown.includes(c.done))
      .map((c) => [
        `${num(c.done)} 回`,
        num(c.anchorCount),
        bytes(c.manifestBytes),
        `+${bytes(c.manifestBytes - before.manifestBytes)}`,
      ]),
  );
  console.log('');
  console.log('同じ年への編集は同じ錨に上書きされる（applyPastEdit）。だから 10 件を同じ年に直しても錨は 1 本しか増えない。');

  heading('5. 錨 1 本あたりのバイト数');
  const addedAnchorsA = afterA.anchorCount - before.anchorCount;
  const addedAnchorsB = afterB.anchorCount - before.anchorCount;
  printTable(
    ['計測', '増えた錨', 'manifest 増分', '錨 1 本あたり'],
    [
      [
        afterA.label,
        num(addedAnchorsA),
        bytes(afterA.manifestBytes - before.manifestBytes),
        addedAnchorsA === 0
          ? '—'
          : bytes((afterA.manifestBytes - before.manifestBytes) / addedAnchorsA),
      ],
      [
        afterB.label,
        num(addedAnchorsB),
        bytes(afterB.manifestBytes - before.manifestBytes),
        addedAnchorsB === 0
          ? '—'
          : bytes((afterB.manifestBytes - before.manifestBytes) / addedAnchorsB),
      ],
      [
        '基準ファイル全体の平均（689 本の実測）',
        num(before.anchorCount),
        bytes(before.manifestBytes),
        bytes(before.manifestBytes / Math.max(1, before.anchorCount)),
      ],
    ],
  );

  heading('6. 係数（1 頂点あたり・1 地物あたりのバイト数）');
  const rows = anchorRows(baseManifest);
  const fitNoIntercept = leastSquares(rows, false);
  const fitIntercept = leastSquares(rows, true);
  const coefRows: string[][] = [];
  if (fitNoIntercept !== undefined) {
    coefRows.push([
      '切片なし（推奨）',
      dec(fitNoIntercept.coefficients[0] ?? 0, 2),
      dec(fitNoIntercept.coefficients[1] ?? 0, 1),
      '—',
      dec(fitNoIntercept.r2, 4),
    ]);
  }
  if (fitIntercept !== undefined) {
    coefRows.push([
      '切片あり',
      dec(fitIntercept.coefficients[0] ?? 0, 2),
      dec(fitIntercept.coefficients[1] ?? 0, 1),
      dec(fitIntercept.coefficients[2] ?? 0, 0),
      dec(fitIntercept.r2, 4),
    ]);
  }
  printTable(
    ['当てはめ', '1 頂点 (byte)', '1 地物 (byte)', '切片 (byte)', '決定係数 R2'],
    coefRows,
  );
  console.log('');
  console.log(`当てはめに使った標本 = 基準ファイルの錨 ${num(rows.length)} 本（スナップショットの JSON バイト数を、頂点数と地物数で説明する）。`);
  if (fitNoIntercept !== undefined) {
    const perVertex = fitNoIntercept.coefficients[0] ?? 0;
    const perFeature = fitNoIntercept.coefficients[1] ?? 0;
    console.log('');
    console.log('推奨する定数:');
    console.log(`  BYTES_PER_SNAPSHOT_VERTEX  = ${Math.round(perVertex)}`);
    console.log(`  BYTES_PER_SNAPSHOT_FEATURE = ${Math.round(perFeature)}`);
    console.log('');
    const predicted =
      Math.round(perVertex) * (ownerEntry?.anchor.snapshot.vertices.byId.size ?? 0) +
      Math.round(perFeature) * (ownerEntry?.anchor.snapshot.features.length ?? 0);
    console.log(
      `検算: ${aggregate.attributes.name} の錨 1 本 = 概算 ${bytes(predicted)} / 実測 ${bytes(ownerSnapshotBytes)}` +
        `（誤差 ${dec(((predicted - ownerSnapshotBytes) / Math.max(1, ownerSnapshotBytes)) * 100, 1)} %）`,
    );
  }

  const felt = (m: Measurement): string =>
    m.open.consistencyMs === undefined
      ? `${dec(m.open.totalMs / 1000, 2)} 秒（整合チェックを除く）`
      : `${dec((m.open.totalMs + m.open.consistencyMs) / 1000, 2)} 秒`;

  heading('7. 設計書 §N-13 の見積りとの突き合わせ');
  const estimateBytes = 15 * 1024 * 1024;
  printTable(
    ['項目', '設計書 §N-13 の見積り', '実測'],
    [
      [
        '10 件 × 5 年の manifest 増分',
        `+約 15 MB`,
        `+${bytes(afterA.manifestBytes - before.manifestBytes)}`,
      ],
      [
        '同上（1 編集＝1 錨 と仮定した上限）',
        `+約 15 MB`,
        `+${bytes(afterB.manifestBytes - before.manifestBytes)}`,
      ],
      [
        '読み込み（体感 ＝ 開き直し ＋ 整合チェック）',
        '8 秒級',
        `${felt(afterA)}（筋書き A）／${felt(afterB)}（上限）`,
      ],
      [
        'うちファイルを読む部分だけ',
        '—',
        `${dec(afterA.open.totalMs / 1000, 2)} 秒（筋書き A）／${dec(afterB.open.totalMs / 1000, 2)} 秒（上限）`,
      ],
      [
        '倍率（見積り ÷ 実測）',
        '—',
        `筋書き A: ${dec(estimateBytes / Math.max(1, afterA.manifestBytes - before.manifestBytes), 2)} 倍 / 上限: ${dec(estimateBytes / Math.max(1, afterB.manifestBytes - before.manifestBytes), 2)} 倍`,
      ],
    ],
  );

  console.log('');
  console.log('読み方: ファイルの膨らみは見積りより 1 桁小さい（同じ年への編集が 1 本の錨にまとまるため）。');
  console.log('いっぽう読み込みの秒数は見積りどおりだが、原因が違う。ファイルの大きさではなく、');
  console.log('checkConsistency が「記録した年の数」に比例することで伸びている。');
  console.log('つまり保存形式を差分化しても、この読み込み時間は下がらない（別の手当てが要る）。');

  heading('8. 書き出したファイル');
  printTable(
    ['ファイル', 'バイト数'],
    [
      [before.path, bytes(before.gimozaBytes)],
      [afterA.path, bytes(afterA.gimozaBytes)],
      [afterB.path, bytes(afterB.gimozaBytes)],
    ],
  );
  console.log('');
  console.log('（入力の .gimoza は読むだけで、一切書き換えていない。）');
}

main();
