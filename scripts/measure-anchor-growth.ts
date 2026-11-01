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
// 測る筋書きは 2 つ。名前は「年」を基準にしている（錨は「年」に打たれ、
// 同じ年への編集は同じ錨に上書きされるので、増える錨の本数は年の数で決まる）:
//
//   筋書き 1「年が揃う」  : 10 件 × 同じ 5 年 ＝ 50 回の編集。
//                          同じ年への編集は 1 本の錨にまとまるので、錨は 5 本しか増えない。
//                          設計書 §N-13 の「10 州 × 5 年」の字面どおりの読み。
//   筋書き 2「年がばらける」: 10 件 × それぞれ別の年 ＝ 50 とおりの年、50 回の編集。
//                          1 編集 ＝ 1 錨 なので錨は 50 本増える。これが上限側の姿で、
//                          設計書 §N-13 の「+15 MB」という見積りはこちらを仮定した数字である。
//
// 計測のやり方（外部審査の指摘を受けての改訂）:
//   * どの時間も「捨て打ち 1 回」のあとに複数回測り、最小 / 中央値 / 最大を出す。
//     1 回しか測らないと JIT の暖まり具合と実行順にそのまま引きずられるため。
//   * 実行順による偏りを消すため、各ラウンドで 3 つの筋書きの計測順をシャッフルする
//     （乱数の種は出力に書くので、同じ種を渡せば同じ順序を再現できる）。
//   * 読み込みは cold（そのファイルをこのプロセスで初めて開く 1 回目）と
//     warm（2 回目以降の中央値）を分けて出す。
//   * 大きさは manifest（非圧縮の JSON）と .gimoza（ZIP 圧縮後の実ファイル）を
//     厳密に別物として報告する。単位は 1024 基準なので MiB / KiB と書く。
//
// 実行方法（リポジトリ直下で。<出力先> は書き込んでよい作業用ディレクトリ）:
//   npx esbuild scripts/measure-anchor-growth.ts --bundle --platform=node --format=esm --outfile="<出力先>/measure.mjs"
//   node "<出力先>/measure.mjs" "<出力先>/derle-world-full-2026-08-16.gimoza"
//
// 引数:
//   第 1 引数（必須）: 計測対象の .gimoza。**実データそのものではなくコピーを渡すこと。**
//   第 2 引数（任意）: 中間ファイルの書き出し先ディレクトリ（既定 = 第 1 引数のあるディレクトリ）。
//   --repeats=N             保存・開き直しの計測回数（既定 4。捨て打ち 1 回は別）。
//   --consistency-repeats=N 整合チェックの計測回数（既定 2。1 回が重いので既定を小さくしてある）。
//   --seed=N                計測順シャッフルの乱数の種（既定は時刻から作る）。
//   --skip-consistency      整合チェック（checkConsistency）の計測を省く。
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
import { normalize } from '../src/domain/time/normalized';
import { timePointYear, type TimePoint } from '../src/domain/time/time-point';
import type { NamedAsset } from '../src/shell/ipc/contract';
import { buildTmap, readTmap } from '../src/shell/io/tmap';

// --- 設定値 -----------------------------------------------------------------

/** 編集する子の件数（設計書 §N-13 の「10 州」）。 */
const CHILD_COUNT = 10;
/** 筋書き「年が揃う」で錨を打つ年（設計書 §N-13 の「5 年」）。 */
const ALIGNED_YEARS: readonly number[] = [1000, 2000, 3000, 4000, 5000];
/** 探す集約地物の名前。見つからなければ子が最も多い集約地物を使う。 */
const TARGET_AGGREGATE_NAME = 'デーレ共和国';

/** 画面に出している概算の係数（src/ui/property/edit-plan.ts の現行値）との突き合わせ用。 */
const SHIPPED_BYTES_PER_VERTEX = 75;
const SHIPPED_BYTES_PER_FEATURE = 728;

const calendar = getCalendar('gregorian');

// --- 小道具 -----------------------------------------------------------------

/** 3 桁区切り。 */
function num(n: number): string {
  const rounded = Math.round(n);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 小数 1 桁 + 3 桁区切り。 */
function dec(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(digits);
  const [head = '0', tail] = fixed.split('.');
  const withCommas = head.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return tail === undefined ? withCommas : `${withCommas}.${tail}`;
}

/**
 * バイト数を読みやすく。**単位は 1024 基準なので MiB / KiB と書く**
 * （1000 基準の MB / KB と混ぜない。外部審査の指摘 12-3）。
 */
function bytes(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1024 * 1024) return `${num(n)} B (${sign}${dec(abs / (1024 * 1024), 2)} MiB)`;
  if (abs >= 1024) return `${num(n)} B (${sign}${dec(abs / 1024, 1)} KiB)`;
  return `${num(n)} B`;
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

// --- 統計（複数回の計測をまとめる） -----------------------------------------

/**
 * 何回か測った時間のまとめ。標本数が 4 程度なので p95 は事実上「最大値」になる。
 * そのため報告は最小 / 中央 / 最大を主にし、p95 は参考として持つだけにする
 * （外部審査の指摘 12-2 の「中央値と p95、または最小/中央/最大」の後者を採る）。
 */
interface Stats {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly p95: number;
}

const EMPTY_STATS: Stats = { n: 0, min: NaN, median: NaN, max: NaN, p95: NaN };

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return EMPTY_STATS;
  const at = (i: number): number => sorted[Math.min(n - 1, Math.max(0, i))] ?? NaN;
  const median = n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
  return { n, min: at(0), median, max: at(n - 1), p95: at(Math.ceil(0.95 * n) - 1) };
}

/** 「最小 / 中央 / 最大」の 1 セル表記。 */
function span(s: Stats): string {
  if (s.n === 0) return '—';
  if (s.n === 1) return dec(s.median);
  return `${dec(s.min)} / ${dec(s.median)} / ${dec(s.max)}`;
}

// --- 計測順のシャッフル（実行順の偏りを消す） -------------------------------

/**
 * 種を指定できる乱数（mulberry32）。同じ種なら同じ計測順を再現できる。
 * 単純な線形合同法だと、連続して取り出した 2 つ組に規則性が残り、
 * 3 つの筋書きを並べ替えると同じ順番が連続して出やすかったのでこちらにしてある。
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

// --- 大きさと本数（1 回だけ数えれば足りるもの） -----------------------------

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
 * 錨が打たれている「異なる時刻」の数。
 *
 * **整合チェック（checkConsistency）が実際に使う数え方と一致させてある**
 * （外部審査の指摘 12-4）。`src/domain/persistence/consistency.ts` の
 * `distinctAnchorTimes` は、各錨の **start と end の両方**を `normalize` した
 * 整数で重複除去している（end は「その状態が消える瞬間」なので、そこも点検の対象）。
 * 以前この関数は start の JSON 表現だけを数えていたので、整合チェックの実際の
 * 反復回数より小さい数を「1 年あたり ms」の分母に使ってしまっていた。
 */
function countDistinctAnchorTimes(manifest: Manifest): number {
  const seen = new Set<number>();
  for (const history of manifest.histories) {
    for (const entry of history.entries) {
      seen.add(normalize(entry.start, calendar));
      if (entry.end !== null) seen.add(normalize(entry.end, calendar));
    }
  }
  return seen.size;
}

/** 参考: 昔の数え方（start だけ）。両者の差を出して、直した効果を見えるようにする。 */
function countDistinctStartsOnly(manifest: Manifest): number {
  const seen = new Set<number>();
  for (const history of manifest.histories) {
    for (const entry of history.entries) seen.add(normalize(entry.start, calendar));
  }
  return seen.size;
}

interface Shape {
  readonly manifestBytes: number;
  readonly anchorCount: number;
  readonly distinctAnchorTimes: number;
  readonly distinctStartsOnly: number;
  readonly featureRefCount: number;
  readonly vertexRefCount: number;
}

function shapeOf(manifest: Manifest): Shape {
  const counts = countSnapshotContents(manifest);
  return {
    manifestBytes: utf8Bytes(JSON.stringify(manifest)),
    anchorCount: countAnchors(manifest),
    distinctAnchorTimes: countDistinctAnchorTimes(manifest),
    distinctStartsOnly: countDistinctStartsOnly(manifest),
    featureRefCount: counts.features,
    vertexRefCount: counts.vertices,
  };
}

// --- 1 回ぶんの計測（保存 / 開き直し / 整合チェック） ------------------------

interface Assets {
  readonly baseMapImage: Uint8Array;
  readonly attachments: readonly NamedAsset[];
}

/** 保存 1 回の内訳（アプリの保存経路と同じ順序）。 */
interface SaveSample {
  readonly serializeMs: number;
  readonly buildTmapMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
  /** .gimoza（ZIP 圧縮後の実ファイル）のバイト数。 */
  readonly gimozaBytes: number;
}

/** 開き直し 1 回の内訳（アプリの読み込み経路と同じ順序）。 */
interface OpenSample {
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
}

/** 保存 1 回。実際にファイルへ書く（メモリ上の往復ではなく利用者が体験する経路）。 */
function saveOnce(project: DomainProject, assets: Assets, outPath: string): SaveSample {
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
  return {
    serializeMs: s1 - s0,
    buildTmapMs: s2 - s1,
    writeMs: s3 - s2,
    totalMs: s3 - s0,
    gimozaBytes: zipBytes.length,
  };
}

/** 開き直し 1 回。組み立て直したプロジェクトも返す（整合チェックの入力に使う）。 */
function openOnce(path: string): { sample: OpenSample; project: DomainProject } {
  const o0 = performance.now();
  const fileBytes = new Uint8Array(readFileSync(path));
  const o1 = performance.now();
  const extracted = readTmap(fileBytes);
  const o2 = performance.now();
  if (!extracted.ok) throw new Error(`開き直しに失敗: ${extracted.message}`);
  const parsed = parseManifest(extracted.contents.manifest);
  const o3 = performance.now();
  if (!isParsed(parsed)) throw new Error(`検証に失敗: ${JSON.stringify(parsed)}`);
  const project = manifestToProject(parsed.manifest);
  const o4 = performance.now();
  return {
    sample: {
      readFileMs: o1 - o0,
      unzipMs: o2 - o1,
      validateMs: o3 - o2,
      rebuildMs: o4 - o3,
      totalMs: o4 - o0,
    },
    project,
  };
}

/** 整合チェック 1 回。 */
function consistencyOnce(project: DomainProject): number {
  const c0 = performance.now();
  checkConsistency(project, calendar);
  return performance.now() - c0;
}

// --- 筋書き 1 つぶんの箱 -----------------------------------------------------

interface Scenario {
  /** 「基準（編集前）」「年が揃う」「年がばらける」。 */
  readonly label: string;
  readonly project: DomainProject;
  readonly path: string;
  readonly shape: Shape;
  /** 保存の計測（捨て打ちを除く）。 */
  readonly saveSamples: SaveSample[];
  /** 開き直し cold ＝ このプロセスで初めてそのファイルを開いた 1 回目。 */
  coldOpen: OpenSample | undefined;
  /** 開き直し warm ＝ 2 回目以降。 */
  readonly warmOpenSamples: OpenSample[];
  /** 整合チェックの計測。 */
  readonly consistencySamples: number[];
  /** cold の開き直しで得たプロジェクト（整合チェックの入力に使い回す）。 */
  reopened: DomainProject | undefined;
  /** .gimoza のバイト数（保存のたびに同じ値になるはずなので最初の 1 回を採る）。 */
  gimozaBytes: number;
}

function makeScenario(label: string, project: DomainProject, path: string, shape: Shape): Scenario {
  return {
    label,
    project,
    path,
    shape,
    saveSamples: [],
    coldOpen: undefined,
    warmOpenSamples: [],
    consistencySamples: [],
    reopened: undefined,
    gimozaBytes: 0,
  };
}

function saveStats(s: Scenario): Stats {
  return stats(s.saveSamples.map((x) => x.totalMs));
}
function warmOpenStats(s: Scenario): Stats {
  return stats(s.warmOpenSamples.map((x) => x.totalMs));
}
function consistencyStats(s: Scenario): Stats {
  return stats(s.consistencySamples);
}
/** 体感の読み込み時間 ＝ warm の開き直し中央値 ＋ 整合チェック中央値。 */
function feltOpenMs(s: Scenario): number {
  const open = warmOpenStats(s).median;
  const check = consistencyStats(s).median;
  return open + (Number.isFinite(check) ? check : 0);
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

/**
 * 概算（係数で出した値）が実測に対して多めに出るか少なめに出るかを、
 * 全錨について比（概算 ÷ 実測）で見る（外部審査の指摘 12-6）。
 */
interface Bias {
  readonly medianRatio: number;
  readonly minRatio: number;
  readonly maxRatio: number;
  /** 概算が実測を上回った錨の割合（0〜1）。 */
  readonly overShare: number;
}

function biasOf(rows: readonly AnchorRow[], perVertex: number, perFeature: number): Bias {
  const ratios: number[] = [];
  let over = 0;
  for (const row of rows) {
    if (row.bytes <= 0) continue;
    const predicted = perVertex * row.vertices + perFeature * row.features;
    const ratio = predicted / row.bytes;
    ratios.push(ratio);
    if (ratio > 1) over += 1;
  }
  const s = stats(ratios);
  return {
    medianRatio: s.median,
    minRatio: s.min,
    maxRatio: s.max,
    overShare: ratios.length === 0 ? NaN : over / ratios.length,
  };
}

/** 「多めに出る」「少なめに出る」を日本語で言い切る。 */
function biasWord(ratio: number): string {
  if (!Number.isFinite(ratio)) return '判定できない';
  if (ratio > 1.02) return `多めに出る（実測の ${dec(ratio, 2)} 倍）`;
  if (ratio < 0.98) return `少なめに出る（実測の ${dec(ratio, 2)} 倍）`;
  return `ほぼ一致（実測の ${dec(ratio, 2)} 倍）`;
}

// --- 本体 -------------------------------------------------------------------

function intOption(args: readonly string[], name: string, fallback: number): number {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const value = Number.parseInt(hit.slice(name.length + 3), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function main(): void {
  const args = process.argv.slice(2);
  const skipConsistency = args.includes('--skip-consistency');
  const repeats = intOption(args, 'repeats', 4);
  const consistencyRepeats = intOption(args, 'consistency-repeats', 2);
  const seed = intOption(args, 'seed', (Date.now() & 0x7fffffff) || 1);
  const rng = makeRng(seed);
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputPath = positional[0];
  if (inputPath === undefined) {
    console.error('使い方: node measure.mjs <計測対象の .gimoza> [出力ディレクトリ] [オプション]');
    console.error('  --repeats=N --consistency-repeats=N --seed=N --skip-consistency');
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
  console.log(`対象ファイル       : ${resolve(inputPath)}`);
  console.log(`書き出し先         : ${outDir}`);
  console.log(`保存・開き直しの回数: 捨て打ち 1 回 ＋ 計測 ${repeats} 回`);
  console.log(
    `整合チェックの回数 : ${
      skipConsistency ? '計測しない（--skip-consistency）' : `捨て打ち 1 回（基準のみ）＋ 計測 ${consistencyRepeats} 回`
    }`,
  );
  console.log(`計測順の乱数の種   : ${seed}（--seed=${seed} で同じ順序を再現できる）`);
  console.log('大きさの単位       : 1024 基準。MiB = 1,048,576 B、KiB = 1,024 B（1000 基準の MB / KB ではない）。');

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

  const baseManifest = serialize(baseProject);
  const baseShape = shapeOf(baseManifest);

  // 集約地物の錨 1 本ぶんの「manifest 上の実測バイト数」。
  // 保存されるのは manifest の形なので、ドメイン側のオブジェクトではなく
  // manifest の該当エントリをそのまま数える。
  const ownerManifestHistory = baseManifest.histories.find(
    (h) => h.featureId === found.ownerHistoryFeatureId,
  );
  const ownerAnchorKey = normalize(found.anchorTime, calendar);
  const ownerManifestEntry =
    ownerManifestHistory?.entries.find((e) => normalize(e.start, calendar) === ownerAnchorKey) ??
    ownerManifestHistory?.entries[0];
  const ownerSnapshotBytes =
    ownerManifestEntry === undefined
      ? 0
      : utf8Bytes(JSON.stringify(ownerManifestEntry.anchor.snapshot));
  const ownerFeatureCount = ownerManifestEntry?.anchor.snapshot.features.length ?? 0;
  const ownerVertexCount = ownerManifestEntry?.anchor.snapshot.vertices.length ?? 0;

  heading('1. 計測対象');
  printTable(
    ['項目', '値'],
    [
      ['集約地物', `${aggregate.attributes.name}（${String(aggregate.id)}）`],
      ['その子の数', num(aggregate.childIds.length)],
      ['歴史を持っている履歴', String(found.ownerHistoryFeatureId)],
      ['その錨のスナップショットの地物数', num(ownerFeatureCount)],
      ['その錨のスナップショットの頂点数', num(ownerVertexCount)],
      [
        `その錨 1 本の manifest 上の実測バイト数`,
        bytes(ownerSnapshotBytes),
      ],
      [
        '編集する子（10 件）',
        childIds
          .map((id) => {
            const f = effectiveFeature(baseProject, id, found.anchorTime);
            return f === undefined ? String(id) : `${f.attributes.name}`;
          })
          .join('、'),
      ],
    ],
  );
  console.log('');
  console.log('「manifest 上の実測バイト数」＝ 圧縮していない JSON としての大きさ。');
  console.log('.gimoza は これを ZIP で圧縮したものなので、ファイルとしての増分はこれより小さい（後述 §8）。');

  // --- 筋書きを 2 つ作る ---------------------------------------------------
  //
  // 途中経過（何回目の編集で何本の錨になったか）は表示する点でだけ数える。
  // 毎回 serialize すると 50 回ぶんで数十秒かかるので、必要な点だけに絞ってある。
  const CHECKPOINTS: readonly number[] = [0, 1, 2, 10, 11, 20, 21, 30, 31, 40, 41, 50];
  interface Checkpoint {
    readonly done: number;
    readonly manifestBytes: number;
    readonly anchorCount: number;
    readonly distinctTimes: number;
  }

  const alignedCheckpoints: Checkpoint[] = [
    {
      done: 0,
      manifestBytes: baseShape.manifestBytes,
      anchorCount: baseShape.anchorCount,
      distinctTimes: baseShape.distinctAnchorTimes,
    },
  ];
  const scatteredCheckpoints: Checkpoint[] = [...alignedCheckpoints];

  // 筋書き 1「年が揃う」: 10 件 × 同じ 5 年（＝ 5 とおりの年）。
  let alignedProject = baseProject;
  let alignedEdits = 0;
  for (const year of ALIGNED_YEARS) {
    const at = timePointYear(year);
    for (const childId of childIds) {
      alignedEdits += 1;
      alignedProject = renameOnce(alignedProject, childId, at, `計測用の名前 ${alignedEdits}（${year} 年）`);
      if (CHECKPOINTS.includes(alignedEdits)) {
        const m = serialize(alignedProject);
        alignedCheckpoints.push({
          done: alignedEdits,
          manifestBytes: utf8Bytes(JSON.stringify(m)),
          anchorCount: countAnchors(m),
          distinctTimes: countDistinctAnchorTimes(m),
        });
      }
    }
  }

  // 筋書き 2「年がばらける」: 10 件 × それぞれ別の年（＝ 50 とおりの年）。
  let scatteredProject = baseProject;
  let scatteredEdits = 0;
  for (let i = 0; i < ALIGNED_YEARS.length * CHILD_COUNT; i += 1) {
    const childId = childIds[i % CHILD_COUNT];
    if (childId === undefined) continue;
    const year = 1000 + i * 100; // 1000, 1100, ... 5900 — 50 個すべて別の年
    scatteredEdits += 1;
    scatteredProject = renameOnce(
      scatteredProject,
      childId,
      timePointYear(year),
      `計測用の名前 ${scatteredEdits}（${year} 年）`,
    );
    if (CHECKPOINTS.includes(scatteredEdits)) {
      const m = serialize(scatteredProject);
      scatteredCheckpoints.push({
        done: scatteredEdits,
        manifestBytes: utf8Bytes(JSON.stringify(m)),
        anchorCount: countAnchors(m),
        distinctTimes: countDistinctAnchorTimes(m),
      });
    }
  }

  const scenarios: Scenario[] = [
    makeScenario('基準（編集前）', baseProject, join(outDir, 'before.gimoza'), baseShape),
    makeScenario(
      '年が揃う（10 件 × 同じ 5 年）',
      alignedProject,
      join(outDir, 'after-aligned-years.gimoza'),
      shapeOf(serialize(alignedProject)),
    ),
    makeScenario(
      '年がばらける（10 件 × 別々の 50 年）',
      scatteredProject,
      join(outDir, 'after-scattered-years.gimoza'),
      shapeOf(serialize(scatteredProject)),
    ),
  ];
  const base = scenarios[0];
  const aligned = scenarios[1];
  const scattered = scenarios[2];
  if (base === undefined || aligned === undefined || scattered === undefined) {
    throw new Error('筋書きの組み立てに失敗しました。');
  }

  // --- 保存: 捨て打ち 1 回 → 計測 repeats 回（毎ラウンド順序をシャッフル） ---
  const orders: string[] = [];
  for (const s of scenarios) {
    const warm = saveOnce(s.project, assets, s.path); // 捨て打ち。ここでファイルが出来る。
    s.gimozaBytes = warm.gimozaBytes;
  }
  for (let round = 0; round < repeats; round += 1) {
    const order = shuffled(scenarios, rng);
    orders.push(`保存 R${round + 1}: ${order.map((s) => s.label).join(' → ')}`);
    for (const s of order) s.saveSamples.push(saveOnce(s.project, assets, s.path));
  }

  // --- 開き直し: cold（1 回目）→ warm（2 回目以降、順序シャッフル） ---
  for (const s of shuffled(scenarios, rng)) {
    const first = openOnce(s.path);
    s.coldOpen = first.sample;
    s.reopened = first.project;
  }
  for (let round = 0; round < repeats; round += 1) {
    const order = shuffled(scenarios, rng);
    orders.push(`開き直し R${round + 1}: ${order.map((s) => s.label).join(' → ')}`);
    for (const s of order) s.warmOpenSamples.push(openOnce(s.path).sample);
  }

  // --- 整合チェック: 基準で捨て打ち 1 回 → 各筋書き consistencyRepeats 回 ---
  if (!skipConsistency) {
    if (base.reopened !== undefined) consistencyOnce(base.reopened); // 捨て打ち（JIT を暖める）
    for (let round = 0; round < consistencyRepeats; round += 1) {
      const order = shuffled(scenarios, rng);
      orders.push(`整合チェック R${round + 1}: ${order.map((s) => s.label).join(' → ')}`);
      for (const s of order) {
        if (s.reopened === undefined) continue;
        s.consistencySamples.push(consistencyOnce(s.reopened));
      }
    }
  }

  // --- 出力 ---------------------------------------------------------------

  heading('2. 大きさ（manifest = 非圧縮 JSON、.gimoza = ZIP 圧縮後の実ファイル）');
  printTable(
    ['筋書き', '錨の本数', '異なる年', 'manifest（非圧縮 JSON）', '.gimoza（実ファイル）', '圧縮率'],
    scenarios.map((s) => [
      s.label,
      num(s.shape.anchorCount),
      num(s.shape.distinctAnchorTimes),
      bytes(s.shape.manifestBytes),
      bytes(s.gimozaBytes),
      `${dec((s.gimozaBytes / s.shape.manifestBytes) * 100, 1)} %`,
    ]),
  );
  console.log('');
  console.log('「異なる年」＝ 整合チェックが世界を 1 枚まるごと点検する回数。');
  console.log('  consistency.ts の distinctAnchorTimes と同じ数え方（各錨の start と end の両方を normalize して重複除去）。');
  console.log(
    `  参考: start だけを数えた場合は ${scenarios
      .map((s) => `${s.label}=${num(s.shape.distinctStartsOnly)}`)
      .join('、')}。`,
  );
  console.log('  以前のこのスクリプトは start の JSON 表現だけを数えていた。この実データでは各錨の end が');
  console.log('  null か次の錨の start と一致するため両者は同じ数になるが、一般には一致しない。');
  console.log('  同じ関数（normalize）で start と end の両方を数えるようにしたので、以後は必ず点検回数と一致する。');

  heading('3. 増分（基準との差）');
  printTable(
    ['筋書き', '錨の増分', '異なる年の増分', 'manifest 増分', 'manifest 倍率', '.gimoza 増分', '.gimoza 倍率'],
    [aligned, scattered].map((s) => [
      s.label,
      `+${num(s.shape.anchorCount - base.shape.anchorCount)}`,
      `+${num(s.shape.distinctAnchorTimes - base.shape.distinctAnchorTimes)}`,
      `+${bytes(s.shape.manifestBytes - base.shape.manifestBytes)}`,
      `${dec(s.shape.manifestBytes / base.shape.manifestBytes, 3)} 倍`,
      `+${bytes(s.gimozaBytes - base.gimozaBytes)}`,
      `${dec(s.gimozaBytes / base.gimozaBytes, 3)} 倍`,
    ]),
  );

  heading('4. 時間（ミリ秒。最小 / 中央 / 最大）');
  printTable(
    [
      '筋書き',
      `保存（n=${repeats}）`,
      '開き直し cold（n=1）',
      `開き直し warm（n=${repeats}）`,
      skipConsistency ? '整合チェック（計測しない）' : `整合チェック（n=${consistencyRepeats}）`,
    ],
    scenarios.map((s) => [
      s.label,
      span(saveStats(s)),
      s.coldOpen === undefined ? '—' : dec(s.coldOpen.totalMs),
      span(warmOpenStats(s)),
      span(consistencyStats(s)),
    ]),
  );
  console.log('');
  console.log('「保存」＝ serialize ＋ buildTmap（JSON 化 + ZIP 圧縮）＋ ファイル書き出し。');
  console.log('「開き直し」＝ ファイル読み ＋ readTmap（ZIP 展開 + JSON.parse）＋ parseManifest（Zod 検証）＋ manifestToProject（ドメイン組み立て）。');
  console.log('「整合チェック」＝ checkConsistency。アプリは読み込みのたびにこれも通すので、体感の合計は「開き直し ＋ 整合チェック」。');
  console.log('');
  console.log('cold / warm の定義:');
  console.log('  cold = そのファイルをこのプロセスで初めて開いた 1 回目。');
  console.log('         ただし直前に自分で書いたファイルなので OS のファイルキャッシュには載っている。');
  console.log('         真に冷えた状態（再起動直後など）はこれより遅くなりうる ＝ ここでの cold は下限寄りの値。');
  console.log('  warm = 2 回目以降。JIT もファイルキャッシュも暖まった状態。');

  heading('5. 体感の読み込み時間（warm の開き直し ＋ 整合チェック、いずれも中央値）');
  printTable(
    ['筋書き', '開き直し warm 中央値', '整合チェック 中央値', '体感の合計'],
    scenarios.map((s) => {
      const check = consistencyStats(s);
      return [
        s.label,
        `${dec(warmOpenStats(s).median)} ms`,
        check.n === 0 ? '—' : `${dec(check.median)} ms`,
        `${dec(feltOpenMs(s) / 1000, 2)} 秒`,
      ];
    }),
  );

  heading('6. 保存・開き直しの内訳（各段の中央値、ミリ秒）');
  console.log('（段ごとに中央値を取っているので、足しても合計の中央値とはぴったり一致しない。）');
  console.log('');
  printTable(
    ['筋書き', 'serialize', 'ZIP 化', '書き出し', 'ファイル読み', 'ZIP 展開', 'Zod 検証', 'ドメイン組立', '整合チェック'],
    scenarios.map((s) => {
      const med = (pick: (x: OpenSample) => number): string =>
        dec(stats(s.warmOpenSamples.map(pick)).median);
      const medSave = (pick: (x: SaveSample) => number): string =>
        dec(stats(s.saveSamples.map(pick)).median);
      const check = consistencyStats(s);
      return [
        s.label,
        medSave((x) => x.serializeMs),
        medSave((x) => x.buildTmapMs),
        medSave((x) => x.writeMs),
        med((x) => x.readFileMs),
        med((x) => x.unzipMs),
        med((x) => x.validateMs),
        med((x) => x.rebuildMs),
        check.n === 0 ? '—' : dec(check.median),
      ];
    }),
  );

  heading('7. 整合チェックの費用は「異なる年の数」でどう伸びるか');
  const baseCheckMedian = consistencyStats(base).median;
  printTable(
    ['筋書き', '異なる年', '整合チェック 中央値 ms', '1 年あたり ms（単純割り）', '基準からの限界費用 ms/年'],
    scenarios.map((s) => {
      const check = consistencyStats(s);
      const addedYears = s.shape.distinctAnchorTimes - base.shape.distinctAnchorTimes;
      const marginal =
        check.n === 0 || addedYears <= 0
          ? '—'
          : dec((check.median - baseCheckMedian) / addedYears);
      return [
        s.label,
        num(s.shape.distinctAnchorTimes),
        check.n === 0 ? '—' : dec(check.median),
        check.n === 0 ? '—' : dec(check.median / Math.max(1, s.shape.distinctAnchorTimes)),
        marginal,
      ];
    }),
  );
  console.log('');
  console.log('checkConsistency は「錨が打たれている異なる時刻（start と end の両方）」ごとに世界を 1 枚組み立て直して点検する。');
  console.log('だから費用の見当は「ファイルの大きさ」ではなく「記録した年の数」で立てるのが正しい。');
  console.log('ただし年を 1 つ増やしたときに実際いくら増えるかは consistency.ts の実装しだいである。');
  console.log('断面ごとの点検結果を使い回す実装なら、年を増やしても費用はほとんど伸びない。');
  console.log('判断には右端の「基準からの限界費用（＝年を 1 つ増やすたびに増える実測ミリ秒）」を見ること。');

  heading('8. 錨 1 本あたり（manifest 実測 と .gimoza 実効増分）');
  printTable(
    ['筋書き', '増えた錨', 'manifest 増分', '錨 1 本あたり（manifest）', '.gimoza 増分', '錨 1 本あたり（.gimoza 実効）'],
    [aligned, scattered].map((s) => {
      const added = s.shape.anchorCount - base.shape.anchorCount;
      const dm = s.shape.manifestBytes - base.shape.manifestBytes;
      const dz = s.gimozaBytes - base.gimozaBytes;
      return [
        s.label,
        num(added),
        bytes(dm),
        added === 0 ? '—' : bytes(dm / added),
        bytes(dz),
        added === 0 ? '—' : bytes(dz / added),
      ];
    }),
  );
  console.log('');
  printTable(
    ['参考', '本数', 'manifest', '1 本あたり'],
    [
      [
        '基準ファイル全体の平均',
        num(base.shape.anchorCount),
        bytes(base.shape.manifestBytes),
        bytes(base.shape.manifestBytes / Math.max(1, base.shape.anchorCount)),
      ],
      [
        `${aggregate.attributes.name} の錨 1 本（manifest 実測）`,
        '1',
        bytes(ownerSnapshotBytes),
        bytes(ownerSnapshotBytes),
      ],
    ],
  );
  console.log('');
  console.log('「.gimoza 実効増分」＝ ZIP 圧縮後のファイルが実際に何バイト太ったかを、増えた錨の本数で割った値。');
  console.log('スナップショットは前の錨とほとんど同じ内容なので ZIP がよく効き、manifest 上の大きさよりずっと小さくなる。');

  heading('9. 途中経過');
  console.log('筋書き 1「年が揃う」（10 件 × 同じ 5 年）');
  console.log('');
  printTable(
    ['編集した回数', '錨の本数', '異なる年', 'manifest', '基準からの増分'],
    alignedCheckpoints.map((c) => [
      `${num(c.done)} 回`,
      num(c.anchorCount),
      num(c.distinctTimes),
      bytes(c.manifestBytes),
      `+${bytes(c.manifestBytes - base.shape.manifestBytes)}`,
    ]),
  );
  console.log('');
  console.log('筋書き 2「年がばらける」（10 件 × 別々の 50 年）');
  console.log('');
  printTable(
    ['編集した回数', '錨の本数', '異なる年', 'manifest', '基準からの増分'],
    scatteredCheckpoints.map((c) => [
      `${num(c.done)} 回`,
      num(c.anchorCount),
      num(c.distinctTimes),
      bytes(c.manifestBytes),
      `+${bytes(c.manifestBytes - base.shape.manifestBytes)}`,
    ]),
  );
  console.log('');
  console.log('同じ年への編集は同じ錨に上書きされる（applyPastEdit）。だから 10 件を同じ年に直しても錨は 1 本しか増えない。');

  heading('10. 係数（1 頂点あたり・1 地物あたりのバイト数）');
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
  printTable(['当てはめ', '1 頂点 (byte)', '1 地物 (byte)', '切片 (byte)', '決定係数 R2'], coefRows);
  console.log('');
  console.log(`当てはめに使った標本 = 基準ファイルの錨 ${num(rows.length)} 本（スナップショットの JSON バイト数を、頂点数と地物数で説明する）。`);

  heading('11. 概算は多めに出るか、少なめに出るか');
  const perVertex = Math.round(fitNoIntercept?.coefficients[0] ?? SHIPPED_BYTES_PER_VERTEX);
  const perFeature = Math.round(fitNoIntercept?.coefficients[1] ?? SHIPPED_BYTES_PER_FEATURE);
  console.log('推奨する定数（この実測から）:');
  console.log(`  BYTES_PER_SNAPSHOT_VERTEX  = ${perVertex}`);
  console.log(`  BYTES_PER_SNAPSHOT_FEATURE = ${perFeature}`);
  console.log(`（いま画面に使っている値: ${SHIPPED_BYTES_PER_VERTEX} / ${SHIPPED_BYTES_PER_FEATURE}）`);
  console.log('');
  const biasFitted = biasOf(rows, perVertex, perFeature);
  const biasShipped = biasOf(rows, SHIPPED_BYTES_PER_VERTEX, SHIPPED_BYTES_PER_FEATURE);
  printTable(
    ['係数', '概算 ÷ 実測 の中央値', '同 最小', '同 最大', '概算が実測を上回った錨の割合', '判定'],
    [
      [
        `この実測（${perVertex} / ${perFeature}）`,
        dec(biasFitted.medianRatio, 3),
        dec(biasFitted.minRatio, 3),
        dec(biasFitted.maxRatio, 3),
        `${dec(biasFitted.overShare * 100, 1)} %`,
        biasWord(biasFitted.medianRatio),
      ],
      [
        `画面の現行値（${SHIPPED_BYTES_PER_VERTEX} / ${SHIPPED_BYTES_PER_FEATURE}）`,
        dec(biasShipped.medianRatio, 3),
        dec(biasShipped.minRatio, 3),
        dec(biasShipped.maxRatio, 3),
        `${dec(biasShipped.overShare * 100, 1)} %`,
        biasWord(biasShipped.medianRatio),
      ],
    ],
  );
  console.log('');
  const predictedOwner = perVertex * ownerVertexCount + perFeature * ownerFeatureCount;
  const predictedOwnerShipped =
    SHIPPED_BYTES_PER_VERTEX * ownerVertexCount + SHIPPED_BYTES_PER_FEATURE * ownerFeatureCount;
  printTable(
    ['検算（' + aggregate.attributes.name + ' の錨 1 本）', '概算', '実測（manifest）', '概算 ÷ 実測', '判定'],
    [
      [
        `この実測の係数`,
        bytes(predictedOwner),
        bytes(ownerSnapshotBytes),
        dec(predictedOwner / Math.max(1, ownerSnapshotBytes), 3),
        biasWord(predictedOwner / Math.max(1, ownerSnapshotBytes)),
      ],
      [
        `画面の現行値`,
        bytes(predictedOwnerShipped),
        bytes(ownerSnapshotBytes),
        dec(predictedOwnerShipped / Math.max(1, ownerSnapshotBytes), 3),
        biasWord(predictedOwnerShipped / Math.max(1, ownerSnapshotBytes)),
      ],
    ],
  );
  console.log('');
  console.log('さらに「実際に 50 回編集したときの増分」に対しても同じ概算を当てて確かめる:');
  console.log('');
  printTable(
    ['筋書き', '増えた頂点（延べ）', '増えた地物（延べ）', '概算の増分', '実測の manifest 増分', '概算 ÷ 実測', '判定'],
    [aligned, scattered].map((s) => {
      const dv = s.shape.vertexRefCount - base.shape.vertexRefCount;
      const df = s.shape.featureRefCount - base.shape.featureRefCount;
      const predicted = perVertex * dv + perFeature * df;
      const actual = s.shape.manifestBytes - base.shape.manifestBytes;
      return [
        s.label,
        num(dv),
        num(df),
        bytes(predicted),
        bytes(actual),
        dec(predicted / Math.max(1, actual), 3),
        biasWord(predicted / Math.max(1, actual)),
      ];
    }),
  );
  console.log('');
  console.log('注意: この概算は「非圧縮の manifest」に対する当てはめである。');
  console.log('画面に「約 ○○ KB 増えます」と出す値も同じ土俵（非圧縮）なので、');
  console.log('実際に保存される .gimoza の増分は §8 のとおりこれよりはるかに小さい（ZIP が効くため）。');

  heading('12. 設計書 §N-13 の見積りとの突き合わせ');
  const estimateBytes = 15 * 1024 * 1024;
  const dmAligned = aligned.shape.manifestBytes - base.shape.manifestBytes;
  const dmScattered = scattered.shape.manifestBytes - base.shape.manifestBytes;
  printTable(
    ['項目', '設計書 §N-13 の見積り', '実測'],
    [
      ['10 件 × 5 年（年が揃う）の manifest 増分', '+約 15 MB', `+${bytes(dmAligned)}`],
      ['同（年がばらける ＝ 1 編集 1 錨の上限）の manifest 増分', '+約 15 MB', `+${bytes(dmScattered)}`],
      [
        '同上・実際に保存される .gimoza の増分',
        '（言及なし）',
        `年が揃う: +${bytes(aligned.gimozaBytes - base.gimozaBytes)} ／ 年がばらける: +${bytes(
          scattered.gimozaBytes - base.gimozaBytes,
        )}`,
      ],
      [
        '読み込み（体感 ＝ 開き直し ＋ 整合チェック）',
        '8 秒級',
        `年が揃う: ${dec(feltOpenMs(aligned) / 1000, 2)} 秒 ／ 年がばらける: ${dec(
          feltOpenMs(scattered) / 1000,
          2,
        )} 秒`,
      ],
      [
        'うちファイルを読む部分だけ（warm 中央値）',
        '—',
        `年が揃う: ${dec(warmOpenStats(aligned).median / 1000, 2)} 秒 ／ 年がばらける: ${dec(
          warmOpenStats(scattered).median / 1000,
          2,
        )} 秒`,
      ],
      [
        '見積り ÷ 実測（manifest 増分）',
        '—',
        `年が揃う: ${dec(estimateBytes / Math.max(1, dmAligned), 2)} 倍 ／ 年がばらける: ${dec(
          estimateBytes / Math.max(1, dmScattered),
          2,
        )} 倍`,
      ],
    ],
  );
  console.log('');
  console.log('読み方:');
  console.log('  ・保存ファイルの膨らみは見積りより小さい。年が揃う場合は同じ年への編集が 1 本の錨にまとまるので錨が 5 本しか増えず、');
  console.log('    年がばらける場合は錨が 50 本増えるが、それでも実ファイル（.gimoza）は ZIP が効いて manifest よりずっと小さくとどまる。');
  console.log('  ・読み込みの秒数は上の実測どおり。内訳では整合チェックが最大の一項目だが、それがどこまで伸びるかは');
  console.log('    consistency.ts の実装しだいなので、§7 の「限界費用」を見て判断すること。');
  console.log('  ・保存形式を差分化しても「境界の数 × 世界一周の点検」という仕事量そのものは消えない。');
  console.log('    逆に整合チェックを速くしても manifest の膨らみは残る。両者は二者択一ではなく、別の問題である。');

  heading('13. 計測条件と、この数字の読みかたの限界');
  console.log(`・保存 / 開き直しは捨て打ち 1 回のあと ${repeats} 回、整合チェックは基準で捨て打ち 1 回のあと 各 ${consistencyRepeats} 回。`);
  console.log(
    `  整合チェックだけ回数が少ないのは 1 回が重いため。${
      consistencyRepeats % 2 === 0
        ? `標本が ${String(consistencyRepeats)} つ（偶数）なので「中央値」は真ん中 2 つの平均である。`
        : ''
    }`,
  );
  console.log(`・標本数が ${repeats} 程度なので p95 は事実上「最大値」になる。よって最小 / 中央 / 最大で報告している。`);
  console.log('・各ラウンドで 3 つの筋書きの計測順をシャッフルして、実行順による偏りを消している。実際の順序は次のとおり:');
  for (const o of orders) console.log(`    ${o}`);
  console.log('・同一プロセス内の連続計測なので、GC のタイミングと V8 の最適化状態の影響は残る。');
  console.log('・同じ PC で別の重い作業（テストや型検査）が動いていると、絶対値は簡単に数倍に膨らむ。');
  console.log('  （実際、他の作業と重なった回は同じコードで整合チェックが 5 倍になった。）');
  console.log('  絶対値を単体で引くのではなく、同じ実行の中の「筋書き間の差・比」を見ること。');
  console.log('・整合チェックの秒数は consistency.ts の実装そのものに依存する。実装を直したら測り直すこと。');
  console.log('  cold の読み込みは「OS のファイルキャッシュに載った状態での 1 回目」であり、真に冷えた読み込みではない。');
  console.log('・大きさはすべて 1024 基準（MiB / KiB）。1000 基準の MB / KB とは混ぜていない。');

  heading('14. 書き出したファイル');
  printTable(
    ['ファイル', '.gimoza バイト数'],
    scenarios.map((s) => [s.path, bytes(s.gimozaBytes)]),
  );
  console.log('');
  console.log('（入力の .gimoza は読むだけで、一切書き換えていない。）');
}

main();
