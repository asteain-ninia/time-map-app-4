// Exhaustiveness helper for discriminated unions.
//
// Calling `assertNever` in the default branch of a `switch` over a
// discriminated union forces the compiler to prove that every variant has
// been handled: if a variant is left unhandled, the residual type is not
// `never` and the call becomes a compile error. At runtime it also throws,
// so an unexpected value (e.g. from untrusted plain data) fails loudly
// rather than being silently ignored.
export function assertNever(value: never, message?: string): never {
  throw new Error(
    message ?? `Unhandled discriminated-union variant: ${JSON.stringify(value)}`,
  );
}
