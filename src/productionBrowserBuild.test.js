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
    const clipboardSource = app.slice(0, app.indexOf("const connectionIndicator ="));
    const clipboardText = runInNewContext(clipboardSource + '; monthlyReportTableText([["4974", "", "Example\\nCustomer"]]);');
    expect(clipboardText).toBe("4974\t\tExample Customer");
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

    const env = { APP_ACCESS_PASSWORD: "customer-quote-regression" };
    const login = await worker.fetch(new Request("https://example.test/login", {
      method: "POST", body: new URLSearchParams({ password: env.APP_ACCESS_PASSWORD }),
    }), env, context);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const form = new FormData();
    form.set("customerList", new File([
      'JobID,Customer,Tel,Mobile,Email,Address\n1300,Example Customer,,,,"Example House\' Test Road\n1301,Next Customer,,,,Other Road',
    ], "customers.csv", { type: "text/csv" }));
    const response = await worker.fetch(new Request("https://example.test/api/parse-csv", {
      method: "POST", headers: { Cookie: cookie }, body: form,
    }), env, context);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.customer_list.file_name).toBe("customers.csv");
    expect(data.customer_list.customers.map(customer => customer.job_id)).toEqual(["1300", "1301"]);
    expect(data.customer_list.literal_address_quotes).toBe(1);
  }, 30_000);
});
