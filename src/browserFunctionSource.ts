// Wrangler preserves function names using this helper inside function bodies.
// toString() omits the surrounding bundle scope, so provide it in a private browser closure.
export function browserFunctionSource(fn: { toString(): string }): string {
  const source = fn.toString();
  // Dev and production bundling can suffix the helper when modules are combined.
  const helpers = [...new Set(source.match(/\b__name\d*\b/g) ?? [])];
  const declarations = helpers.length ? "const " + helpers.map(name => name + " = (value) => value").join(", ") + "; " : "";
  return "(() => { " + declarations + "return (" + source + "); })()";
}
