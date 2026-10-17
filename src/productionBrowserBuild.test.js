import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

describe("production Pages browser assets", () => {
  it("executes serialised workflow and Help functions with Wrangler's name-preserving build", async () => {
    const output = resolve(".wrangler/test-browser-build");
    execFileSync(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "pages", "functions", "build", "--outdir", output], {
      env: { ...process.env, WRANGLER_LOG_PATH: resolve(".wrangler/test-browser-build.log"), WRANGLER_SEND_METRICS: "false" },
      stdio: "pipe",
    });
    const { default: worker } = await import(/* @vite-ignore */ pathToFileURL(resolve(output, "index.js")).href);
    const context = { waitUntil() {}, passThroughOnException() {} };
    const app = await (await worker.fetch(new Request("https://example.test/assets/app.js"), {}, context)).text();
    const help = await (await worker.fetch(new Request("https://example.test/assets/help.js"), {}, context)).text();
    const workflowSource = app.slice(app.indexOf("const deriveWorkflow ="), app.indexOf("const workflowHasBlockingWarning ="));
    // Parsing alone missed the original __name ReferenceError: actually execute the function.
    const states = runInNewContext(workflowSource + '; deriveWorkflow({ fileCount: 0, rowCount: 0, checkState: "idle", draftState: "no_invoices_selected" });');
    expect(states.map(step => step.status)).toEqual(["ready", "not-started", "not-started", "not-started", "not-started"]);
    const searchSource = help.slice(help.indexOf("const searchGuides ="), help.indexOf('const opener ='));
    const matches = runInNewContext(searchSource + '; searchGuides({ categories: [], guides: [] }, "invoice");');
    expect(matches).toEqual([]);
    expect(app).toContain('classList.toggle("connection-gated"');
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(help)).not.toThrow();
  }, 30_000);
});
