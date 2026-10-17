// Wrangler preserves function names using this helper inside function bodies.
// toString() omits the surrounding bundle scope, so provide it in a private browser closure.
export function browserFunctionSource(fn: { toString(): string }): string {
  return "(() => { const __name = (value) => value; return (" + fn.toString() + "); })()";
}
