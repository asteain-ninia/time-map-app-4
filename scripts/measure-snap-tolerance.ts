// 「作図中の頂点吸着は、どれだけ近ければ効くべきか」の実測スクリプト。
//
// なぜこれを測るのか（設計書 §N-6 / 実装計画 増分 3 の中身 4）:
//   要件 FR-31（should）は吸着の効く距離を **50px** と定めている。ところが現状分析
//   §7.1 は「実データの頂点は隣まで中央値 3.46px しか離れていない」と報告しており、
//   50px のままだと 1 回のクリックの許容円に何十個も頂点が入る。どれに吸い付いたのか
//   利用者には分からず、**狙っていない頂点へ勝手に動く**。
//   （この 3.46px は倍率が書かれていない数字である。本スクリプトの実測では、世界全体表示で
//    0.40〜0.44px、×4 で 1.6〜1.75px、×16 で 6.4〜7.0px。3.46px は **×8 前後（＝地物へ寄せた
//    カメラ）で測った値だと推定される**（実測はしていない）。以後は必ず倍率とセットで
//    書くこと＝設計書 §N-6 の追記。）
//   §N-6 は 3 案（**12px 固定 / 画面倍率に連動 / 50px 維持**）を実データで比べてから
//   決めよと書いている。このスクリプトはその比較を作る。
//
// 「画面倍率に連動」の読み方（この実装で決めたこと。報告に理由を書く）:
//   このリポジトリで「画面倍率」は OS/ブラウザの表示倍率（devicePixelRatio）を指す
//   （増分 1 の申し送り「表示倍率 1.25 での列の丸め」）。したがって案 B は
//   **許容 = 12 CSS px × devicePixelRatio** として測る。dPR 1.0 / 1.25 / 1.5 / 2.0。
//   **この掛け算は「画面上の物理的な大きさを保つ」ものではない。逆である。**
//   CSS px は既に表示倍率で正規化された単位なので、**物理的な大きさが変わらないのは
//   12 CSS px のまま置く案 A のほう**で、dPR を掛けると**高精細な画面ほど吸着が広くなる**
//   （見た目で dPR 倍の円になる）。技術方針 §6.10 も「`devicePixelRatio` は掛けない」と
//   定めており、`render/camera.ts` / `vtransform.ts` の描画変換も掛けていない。
//   案 B はその規律と逆を向く案として測り、比較の結果として捨てるためにここに置いてある。
//   （もう 1 つの読み——「地図の拡大率に連動して許容 px を変える」——も併せて測る。
//    許容を世界座標の一定量（度）で決め、px へ直す形。表の「案 B'」がそれ。）
//
// 測る指標（1 回のクリックにつき）:
//   * **候補数** — 許容円の中に入る既存頂点の数。1 なら迷いが無い。多いほど
//     「どれに付いたのか分からない」。
//   * **狙った頂点が最近傍か** — 頂点 v を狙って 0〜3px ずれてクリックしたとき、
//     いちばん近い候補が v である割合。低いほど「別の頂点へ勝手に飛ぶ」。
//   * **引っ張られる距離** — クリック位置から吸着先までの px。大きいほど
//     「押した場所と違うところに点が置かれる」。
//   * **空振りの誤吸着** — 頂点から十分離れた場所（＝新しい形を描きたい場所）を
//     押したのに吸着してしまう割合。
//
// 実行方法（リポジトリ直下で。<出力先> は書き込んでよい作業用ディレクトリ）:
//   npx esbuild scripts/measure-snap-tolerance.ts --bundle --platform=node --format=esm --outfile="<出力先>/snap.mjs"
//   node "<出力先>/snap.mjs" "<出力先>/derle-world-full.gimoza"
//
// 引数:
//   第 1 引数（必須）: 計測対象の .gimoza。**実データそのものではなくコピーを渡すこと**
//                      （開発ガイド §5.48）。このスクリプトは読み取りしかしないが、
//                      作法として同じ規則に従う。
//   --seed=N           乱数の種（既定 20260904）。同じ種なら同じ結果になる。
//   --samples=N        1 つの地物あたりのクリック標本数（既定 400）。

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { FEATURE_KIND, referencedVertexIds, type Feature } from '../src/domain/feature';
import type { FeatureId, VertexId } from '../src/domain/ids';
import {
  isParsed,
  manifestToProject,
  parseManifest,
  type DomainProject,
} from '../src/domain/persistence/index';
import { timePointYear, type TimePoint } from '../src/domain/time/time-point';
import { getVertex, type VertexStore } from '../src/domain/vertex';
import { featuresAt, verticesAt } from '../src/ui/live-lookup';
import { readTmap } from '../src/shell/io/tmap';

// --- 設定値 -----------------------------------------------------------------

/**
 * 地図セルの実寸（CSS px）。増分 1 のあとの 1280×800 起動でのおおよその値。
 * 世界全体（経度 360 度）がこの幅に収まるときの倍率が「既定ズーム」である。
 */
const MAP_CELL = { widthCss: 940, heightCss: 497 } as const;

/** 比べる相手（現状分析 §7.1 / 設計書 §N-6 が名指ししている 2 件）。 */
const TARGET_NAMES: readonly string[] = ['バアカ', 'アルラーク国'];

/** クリックのぶれ（px）。人が狙って押しても中心からこれくらいはずれる。 */
const JITTER_MAX_PX = 3;

/** 「空振りの誤吸着」を測るとき、頂点からこれ以上離れた場所を「空き地」とみなす（px）。 */
const EMPTY_MARGIN_PX = 60;

// --- 小道具 -----------------------------------------------------------------

function dec(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

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
  return align === 'l' ? text + fill : fill + text;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const aligns: ('l' | 'r')[] = header.map((_, i) => (i === 0 ? 'l' : 'r'));
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((c, i) => pad(c, widths[i] ?? 0, aligns[i] ?? 'l')).join(' | ')} |`;
  const sep = `| ${widths.map((w, i) => (aligns[i] === 'r' ? `${'-'.repeat(Math.max(1, w - 1))}:` : '-'.repeat(Math.max(1, w)))).join(' | ')} |`;
  return [line(header), sep, ...rows.map(line)].join('\n');
}

/** 決定的な乱数（mulberry32）。種を出力に書けば同じ結果を再現できる。 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

// --- 空間格子（許容円に入る頂点を数えるための broad phase） -------------------

interface ScreenVertex {
  readonly x: number;
  readonly y: number;
  readonly vertexId: VertexId;
  readonly featureId: FeatureId;
}

/** 一定の升目に頂点を配る。半径 r の問い合わせは周囲 (2k+1)^2 升だけを見る。 */
class Grid {
  private readonly cell: number;
  private readonly buckets = new Map<string, ScreenVertex[]>();

  constructor(cell: number, points: readonly ScreenVertex[]) {
    this.cell = cell;
    for (const p of points) {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const bucket = this.buckets.get(key);
      if (bucket === undefined) this.buckets.set(key, [p]);
      else bucket.push(p);
    }
  }

  within(x: number, y: number, radius: number): ScreenVertex[] {
    const k = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const r2 = radius * radius;
    const out: ScreenVertex[] = [];
    for (let gx = cx - k; gx <= cx + k; gx += 1) {
      for (let gy = cy - k; gy <= cy + k; gy += 1) {
        const bucket = this.buckets.get(`${gx},${gy}`);
        if (bucket === undefined) continue;
        for (const p of bucket) {
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy <= r2) out.push(p);
        }
      }
    }
    return out;
  }

  /** 最近傍までの距離（半径 `probe` の中に無ければ Infinity）。 */
  nearestDistance(x: number, y: number, probe: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (const p of this.within(x, y, probe)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best) best = d;
    }
    return best;
  }
}

// --- 計測本体 ---------------------------------------------------------------

interface Sample {
  /** 許容内に入った頂点の数。 */
  readonly candidates: number;
  /** いちばん近い候補が「狙った頂点」だったか。 */
  readonly nearestIsTarget: boolean;
  /** クリック位置から吸着先までの px（吸着しなければ NaN）。 */
  readonly pullPx: number;
}

interface CaseResult {
  readonly label: string;
  readonly tolerancePx: number;
  readonly samples: readonly Sample[];
  /** 空き地を押したのに吸着した割合（0〜1）。 */
  readonly falseSnapRate: number;
}

function summarize(result: CaseResult): readonly string[] {
  const counts = result.samples.map((s) => s.candidates).sort((a, b) => a - b);
  const total = Math.max(1, result.samples.length);
  const correct = result.samples.filter((s) => s.nearestIsTarget).length;
  const lone = result.samples.filter((s) => s.candidates === 1).length;
  const missed = result.samples.filter((s) => s.candidates === 0).length;
  return [
    result.label,
    dec(result.tolerancePx, 1),
    dec(quantile(counts, 0.5), 1),
    dec(quantile(counts, 0.9), 1),
    String(counts[counts.length - 1] ?? 0),
    `${dec((lone / total) * 100, 1)}%`,
    `${dec((missed / total) * 100, 1)}%`,
    `${dec((correct / total) * 100, 1)}%`,
    `${dec(result.falseSnapRate * 100, 1)}%`,
  ];
}

const SUMMARY_HEADER = [
  '案',
  '許容px',
  '候補数 中央',
  '候補数 p90',
  '候補数 最大',
  '候補が 1 個',
  '吸着しない',
  '狙いが最近傍',
  '空き地で誤吸着',
] as const;

function collectScreenVertices(
  features: readonly Feature[],
  store: VertexStore,
  zoom: number,
  centerLon: number,
  centerLat: number,
): ScreenVertex[] {
  const out: ScreenVertex[] = [];
  const cx = MAP_CELL.widthCss / 2;
  const cy = MAP_CELL.heightCss / 2;
  for (const feature of features) {
    if (feature.kind === FEATURE_KIND.Aggregate) continue;
    for (const vid of referencedVertexIds(feature)) {
      const v = getVertex(store, vid);
      if (v === undefined) continue;
      out.push({
        x: cx + (v.coordinate.lon - centerLon) * zoom,
        y: cy - (v.coordinate.lat - centerLat) * zoom,
        vertexId: vid,
        featureId: feature.id,
      });
    }
  }
  return out;
}

function measureCase(
  label: string,
  tolerancePx: number,
  targets: readonly ScreenVertex[],
  grid: Grid,
  emptyPoints: readonly { readonly x: number; readonly y: number }[],
  random: () => number,
): CaseResult {
  const samples: Sample[] = [];
  for (const target of targets) {
    const angle = random() * Math.PI * 2;
    const radius = random() * JITTER_MAX_PX;
    const x = target.x + Math.cos(angle) * radius;
    const y = target.y + Math.sin(angle) * radius;
    const within = grid.within(x, y, tolerancePx);
    let nearest: ScreenVertex | null = null;
    let nearestD = Number.POSITIVE_INFINITY;
    for (const p of within) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < nearestD) {
        nearestD = d;
        nearest = p;
      }
    }
    samples.push({
      candidates: within.length,
      nearestIsTarget: nearest !== null && nearest.vertexId === target.vertexId,
      pullPx: nearest === null ? Number.NaN : nearestD,
    });
  }
  let falseSnaps = 0;
  for (const p of emptyPoints) {
    if (grid.within(p.x, p.y, tolerancePx).length > 0) falseSnaps += 1;
  }
  return {
    label,
    tolerancePx,
    samples,
    falseSnapRate: emptyPoints.length === 0 ? 0 : falseSnaps / emptyPoints.length,
  };
}

/**
 * 「地図のうち、吸着に覆われている割合」。地図セルの中を無作為に押したとき、
 * 許容 tol の内側に既存頂点がある（＝押した場所に点が置けず、既存の頂点へ持って
 * いかれる）割合を出す。**3 案の実質的な差はここにしか出ない** ―― 候補が何個
 * あっても選ばれるのは最近傍 1 個なので「どれに付くか」は許容値では変わらない。
 * 変わるのは「付くか付かないか」＝ どこまでの空白を吸着が食うか である。
 */
function measureSnapCoverage(
  grid: Grid,
  tolerances: readonly number[],
  random: () => number,
  probes = 20000,
): readonly number[] {
  const maxTol = Math.max(...tolerances);
  const hits = tolerances.map(() => 0);
  for (let i = 0; i < probes; i += 1) {
    const x = random() * MAP_CELL.widthCss;
    const y = random() * MAP_CELL.heightCss;
    const d = grid.nearestDistance(x, y, maxTol);
    for (let t = 0; t < tolerances.length; t += 1) {
      if (d <= (tolerances[t] ?? 0)) hits[t] = (hits[t] ?? 0) + 1;
    }
  }
  return hits.map((h) => (h / probes) * 100);
}

// --- 入口 -------------------------------------------------------------------

function parseArgs(): { input: string; seed: number; samples: number } {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const input = positional[0];
  if (input === undefined) {
    throw new Error('第 1 引数に .gimoza のコピーのパスを渡してください。');
  }
  const flag = (name: string, fallback: number): number => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    if (found === undefined) return fallback;
    const value = Number(found.slice(name.length + 3));
    return Number.isFinite(value) ? value : fallback;
  };
  return { input: resolve(input), seed: flag('seed', 20260904), samples: flag('samples', 400) };
}

function loadProject(path: string): DomainProject {
  const bytes = readFileSync(path);
  const extracted = readTmap(new Uint8Array(bytes));
  if (!extracted.ok) throw new Error(`readTmap に失敗: ${extracted.message}`);
  const parsed = parseManifest(extracted.contents.manifest);
  if (!isParsed(parsed)) throw new Error(`parseManifest に失敗: ${JSON.stringify(parsed)}`);
  return manifestToProject(parsed.manifest);
}

function displayNameOf(feature: Feature): string {
  return feature.attributes.name;
}

function main(): void {
  const { input, seed, samples } = parseArgs();
  if (input.split(sep).includes('derle-import')) {
    throw new Error('derle-import の下のファイルを直接渡さないでください（開発ガイド §5.48）。');
  }
  const project = loadProject(input);
  const time: TimePoint = timePointYear(0);
  const features = featuresAt(project, time);
  const store = verticesAt(project, time);

  console.log('# 吸着の許容値 3 案の比較（実データ）');
  console.log('');
  console.log(`入力: ${input}`);
  console.log(`乱数の種: ${seed} ／ 1 地物あたりの標本数: ${samples}`);
  console.log(`地図セル: ${MAP_CELL.widthCss}×${MAP_CELL.heightCss} CSS px`);
  console.log(`時刻: 0 年 ／ その時刻に居る地物 ${features.length} 件`);
  console.log('');

  const fitZoom = Math.min(
    MAP_CELL.widthCss / 360,
    MAP_CELL.heightCss / 180,
  );
  console.log(
    `既定ズーム（世界全体が収まる倍率）= ${dec(fitZoom, 3)} CSS px/度。以降 ×1 / ×4 / ×16 で測る。`,
  );
  console.log('');

  for (const targetName of TARGET_NAMES) {
    const target = features.find((f) => displayNameOf(f) === targetName);
    if (target === undefined) {
      console.log(`（${targetName} は 0 年に居ないので飛ばす）`);
      continue;
    }
    const targetVertexIds = referencedVertexIds(target);
    console.log(`## ${targetName}（頂点 ${targetVertexIds.length} 個）`);
    console.log('');

    // 地物の中心をカメラ中心にする（狙う頂点が画面に居る形にする）。
    let sumLon = 0;
    let sumLat = 0;
    let n = 0;
    for (const vid of targetVertexIds) {
      const v = getVertex(store, vid);
      if (v === undefined) continue;
      sumLon += v.coordinate.lon;
      sumLat += v.coordinate.lat;
      n += 1;
    }
    const centerLon = n === 0 ? 0 : sumLon / n;
    const centerLat = n === 0 ? 0 : sumLat / n;

    for (const zoomMultiple of [1, 4, 16]) {
      const zoom = fitZoom * zoomMultiple;
      const all = collectScreenVertices(features, store, zoom, centerLon, centerLat);
      const grid = new Grid(24, all);

      // 隣どうしの距離（この地物の頂点列の隣接ペア）。現状分析の 3.46px の再確認。
      const ownScreen = all.filter((p) => p.featureId === target.id);
      const neighbourDistances: number[] = [];
      for (let i = 1; i < ownScreen.length; i += 1) {
        const a = ownScreen[i - 1]!;
        const b = ownScreen[i]!;
        neighbourDistances.push(Math.hypot(a.x - b.x, a.y - b.y));
      }
      neighbourDistances.sort((x, y) => x - y);

      // 狙う頂点の標本（画面内に居るものから等間隔に選ぶ）。
      const inView = ownScreen.filter(
        (p) => p.x >= 0 && p.x <= MAP_CELL.widthCss && p.y >= 0 && p.y <= MAP_CELL.heightCss,
      );
      const step = Math.max(1, Math.floor(inView.length / samples));
      const targets: ScreenVertex[] = [];
      for (let i = 0; i < inView.length && targets.length < samples; i += step) {
        targets.push(inView[i]!);
      }

      // 「空き地」の標本: 画面内で、どの頂点からも EMPTY_MARGIN_PX 以上離れた点。
      const emptyRandom = makeRandom(seed + zoomMultiple);
      const emptyPoints: { x: number; y: number }[] = [];
      for (let tries = 0; tries < 20000 && emptyPoints.length < 200; tries += 1) {
        const x = emptyRandom() * MAP_CELL.widthCss;
        const y = emptyRandom() * MAP_CELL.heightCss;
        if (grid.nearestDistance(x, y, EMPTY_MARGIN_PX) === Number.POSITIVE_INFINITY) {
          emptyPoints.push({ x, y });
        }
      }

      console.log(
        `### ズーム ×${zoomMultiple}（${dec(zoom, 2)} px/度）` +
          ` — 画面内の頂点 ${inView.length} 個 ／ 全地物の頂点 ${all.length} 個`,
      );
      console.log('');
      console.log(
        `隣り合う頂点の距離: 中央値 ${dec(quantile(neighbourDistances, 0.5), 2)}px ／ ` +
          `p10 ${dec(quantile(neighbourDistances, 0.1), 2)}px ／ ` +
          `p90 ${dec(quantile(neighbourDistances, 0.9), 2)}px`,
      );
      console.log('');

      const cases: CaseResult[] = [];
      const random = makeRandom(seed);
      cases.push(measureCase('案A 12px 固定', 12, targets, grid, emptyPoints, random));
      for (const dpr of [1.0, 1.25, 1.5, 2.0]) {
        cases.push(
          measureCase(
            `案B 画面倍率連動 ×${dec(dpr, 2)}`,
            12 * dpr,
            targets,
            grid,
            emptyPoints,
            makeRandom(seed),
          ),
        );
      }
      // 案 B'（もう 1 つの読み）: 許容を世界座標の一定量で決め、px に直す。
      // 既定ズームで 12px 相当の度数（12 / fitZoom 度）を固定し、拡大すると px は増える。
      const worldTolDeg = 12 / fitZoom;
      cases.push(
        measureCase(
          `案B' 地図倍率連動（${dec(worldTolDeg, 2)}度固定）`,
          worldTolDeg * zoom,
          targets,
          grid,
          emptyPoints,
          makeRandom(seed),
        ),
      );
      cases.push(measureCase('案C 50px 維持', 50, targets, grid, emptyPoints, makeRandom(seed)));

      console.log(table(SUMMARY_HEADER, cases.map(summarize)));
      console.log('');

      // 「地図のうち吸着に覆われている割合」— 3 案の実質的な差はここにしか出ない。
      const coverageCases = cases.filter(
        (c) => !c.label.includes('×1.00') && !c.label.includes('×1.50'),
      );
      const coverage = measureSnapCoverage(
        grid,
        coverageCases.map((c) => c.tolerancePx),
        makeRandom(seed + 99 + zoomMultiple),
      );
      console.log(
        table(
          ['指標', ...coverageCases.map((c) => `${c.label} (${dec(c.tolerancePx, 0)}px)`)],
          [['吸着に覆われる面積', ...coverage.map((v) => `${dec(v, 1)}%`)]],
        ),
      );
      console.log('（地図セルの中を無作為に押したとき、その場所に点を置けず既存の頂点へ持っていかれる割合。低いほど自由に描ける。）');
      console.log('');
    }
  }

  console.log('読み方:');
  console.log('- 「候補数」は許容円に入る既存頂点の数。多いほど、琥珀の輪や候補一覧が意味を失う。');
  console.log('- 「候補が 1 個」は迷いが無いクリックの割合。');
  console.log('- 「狙いが最近傍」は、頂点 v を狙って 0〜3px ずれて押したとき最近傍が v だった割合。');
  console.log('  **この列は許容値では変わらない**（最近傍は許容値を広げても同じ 1 個）。変わるのはズームだけ。');
  console.log(`- 「空き地で誤吸着」は、どの頂点からも ${EMPTY_MARGIN_PX}px 以上離れた場所を押したのに吸着した割合。`);
  console.log('- 2 つ目の表が 3 案の実質的な差である。許容値が決めるのは「どれに付くか」ではなく');
  console.log('  「付くか付かないか」＝ どこまでの空白を吸着が食うか である。');
}

main();
