import { describe, expect, it } from "vitest";
import { browserFunctionSource } from "./browserFunctionSource";

describe("browser function serialization", () => {
  it.each(["__name", "__name2", "__name12"])("restores the bundler's %s helper in its private scope", helper => {
    const source = browserFunctionSource({ toString: () => `function workflow() { const nested = ${helper}(() => 42, "nested"); return nested(); }` });
    expect(new Function("return " + source + "()")()).toBe(42);
  });

  it("also supports functions with no bundler helpers", () => {
    expect(new Function("return " + browserFunctionSource(() => "ready") + "()")()).toBe("ready");
  });
});
