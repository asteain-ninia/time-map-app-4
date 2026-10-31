// 回数の多い性質テストのための `expect`。判定は vitest の `expect` と同じで、**通るときだけ速い**。
//
// なぜ要るか: vitest 2.1 の `expect()` は 1 回呼ぶたびに内部の状態を
// `Object.defineProperties` で作り直し、chai の Proxy を組み立てる。`src/domain/__bughunt__` の
// 検査は 1 実行の中で不変条件を何十万回も確かめるので、CPU プロファイルで全体の 75% がここだった
// （hole-enclave-ring-alternation-6: 40 秒のうち setState だけで 18 秒）。
//
// 守っていること:
//   - 速い道は「本物でも必ず通る」と言い切れる場合だけ通る。それ以外（失敗するときも含む）は
//     本物の `expect` をそのまま呼ぶので、失敗の判定と文面は本物と同じになる。
//   - 下の表にない照合はすべて本物へ流す。
//   - `expect.assertions()` の数には速い道の分が入らない。これを使う検査では使わない。
// 表が本物と食い違わないことは `fast-expect.test.ts` が突き合わせる。
import { expect as realExpect, type Assertion } from 'vitest';

type Real = Assertion<unknown>;

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

class FastAssertion {
  constructor(
    private readonly actual: unknown,
    private readonly message: string | undefined,
    private readonly negated: boolean,
  ) {}

  /** 本物の照合（`.not` を保つ）。失敗の文面はここから出る。 */
  real(): Real {
    const assertion = realExpect(this.actual, this.message);
    return (this.negated ? assertion.not : assertion) as Real;
  }

  get not(): unknown {
    return wrap(this.actual, this.message, !this.negated);
  }

  /** 判定が `pass` で、向きが合っていれば本物を呼ばずに済む。 */
  private skip(pass: boolean): boolean {
    return pass !== this.negated;
  }

  toBe(expected: unknown): void {
    if (!this.skip(Object.is(this.actual, expected))) this.real().toBe(expected);
  }

  toEqual(expected: unknown): void {
    // 同じ値は必ず等しい。違う値の判定は本物に任せる（肯定でも否定でも速い道を通らない）。
    if (this.negated || !Object.is(this.actual, expected)) this.real().toEqual(expected);
  }

  toBeDefined(): void {
    if (!this.skip(this.actual !== undefined)) this.real().toBeDefined();
  }

  toBeUndefined(): void {
    if (!this.skip(this.actual === undefined)) this.real().toBeUndefined();
  }

  toBeNull(): void {
    if (!this.skip(this.actual === null)) this.real().toBeNull();
  }

  toBeGreaterThan(expected: unknown): void {
    if (this.negated || !isNumber(this.actual) || !isNumber(expected) || !(this.actual > expected)) {
      this.real().toBeGreaterThan(expected as number);
    }
  }

  toBeGreaterThanOrEqual(expected: unknown): void {
    if (this.negated || !isNumber(this.actual) || !isNumber(expected) || !(this.actual >= expected)) {
      this.real().toBeGreaterThanOrEqual(expected as number);
    }
  }

  toBeLessThan(expected: unknown): void {
    if (this.negated || !isNumber(this.actual) || !isNumber(expected) || !(this.actual < expected)) {
      this.real().toBeLessThan(expected as number);
    }
  }

  toBeLessThanOrEqual(expected: unknown): void {
    if (this.negated || !isNumber(this.actual) || !isNumber(expected) || !(this.actual <= expected)) {
      this.real().toBeLessThanOrEqual(expected as number);
    }
  }
}

/** 表にない照合は本物へ流す。 */
const handler: ProxyHandler<FastAssertion> = {
  get(target, prop, receiver) {
    if (prop in target) return Reflect.get(target, prop, receiver);
    const real = target.real() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    if (typeof value !== 'function') return value;
    // chai の照合は「呼ばれた形」を見るので、bind せず本物の上で呼び直す。
    return (...args: unknown[]) => (real[prop] as (...a: unknown[]) => unknown)(...args);
  },
};

function wrap(actual: unknown, message: string | undefined, negated: boolean): unknown {
  return new Proxy(new FastAssertion(actual, message, negated), handler);
}

/** `vitest` の `expect` と同じ形。`expect.soft` などの付属は本物のものが見える。 */
export const expect: typeof realExpect = new Proxy(realExpect, {
  apply(_target, _thisArg, args: unknown[]) {
    return wrap(args[0], args[1] as string | undefined, false);
  },
});
