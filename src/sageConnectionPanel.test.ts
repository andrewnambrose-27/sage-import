import { describe, expect, it, vi } from "vitest";
import { connectionIndicator } from "./sageConnectionPanel";
import { onRequest } from "../functions/[[path]]";

describe("header Sage connection status", () => {
  it("distinguishes checking, connected, disconnected and error states", () => {
    expect(connectionIndicator(null)).toEqual({ state: "checking", label: "Checking connection" });
    expect(connectionIndicator({ storage_configured: true, connected: true })).toEqual({ state: "connected", label: "Sage connected" });
    expect(connectionIndicator({ storage_configured: true, connected: false })).toEqual({ state: "disconnected", label: "Sage disconnected" });
    expect(connectionIndicator({ storage_configured: true, connected: true, reauthorization_required: true }).state).toBe("disconnected");
    expect(connectionIndicator({ storage_configured: false, connected: false }).state).toBe("error");
    expect(connectionIndicator(null, true)).toEqual({ state: "error", label: "Connection error" });
  });

  it("starts main content at the workflow and retains the protected controls inside the header", async () => {
    const env = { APP_ACCESS_PASSWORD: "test-page-layout-only" };
    const login = await onRequest({ request: new Request("https://example.test/login", { method: "POST", body: new URLSearchParams({ password: env.APP_ACCESS_PASSWORD }) }), env } as Parameters<typeof onRequest>[0]);
    const response = await onRequest({ request: new Request("https://example.test/upload", { headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] } }), env } as Parameters<typeof onRequest>[0]);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('class="hero-panel"');
    expect(html).not.toContain('class="sage-card"');
    expect(html).not.toContain("Add the export files you have available.");
    expect(html).toMatch(/<main class="dashboard-shell">\s*<nav class="workflow-progress"/);
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));
    expect(header).toContain('id="sageConnectionPopover"');
    expect(header).toContain('popover="auto" role="dialog"');
    expect(header).toContain('id="sageConnectionPassword" type="password"');
    expect(header).toContain('id="sageConnectLink" class="button-link" href="/api/sage/connect" hidden');
    expect(header).toContain('id="sageDisconnectButton" class="secondary-button" type="button" disabled hidden');
    expect(header).toContain('method="post" action="/logout"');
    expect((html.match(/class="file-card"/g) || []).length).toBe(6);
    expect((html.match(/data-workflow-toggle=/g) || []).length).toBe(5);
  });

  it("retains server-side password protection and the five-minute unlock cookie", async () => {
    // Supply Cloudflare's SubtleCrypto extension in the Node test runtime only.
    const originalCrypto = crypto;
    const subtle = new Proxy(originalCrypto.subtle, { get(target, key) {
      if (key === "timingSafeEqual") return (left: ArrayBuffer, right: ArrayBuffer) => {
        const a = new Uint8Array(left), b = new Uint8Array(right);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
        return difference === 0;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    vi.stubGlobal("crypto", new Proxy(originalCrypto, { get(target, key) {
      if (key === "subtle") return subtle;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }));
    try {
      const env = { APP_ACCESS_PASSWORD: "test-login-only", SAGE_CONNECTION_ACCESS_PASSWORD: "test-connection-only" };
      const call = (path: string, cookie = "", body?: unknown) => onRequest({ env, request: new Request("https://example.test" + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) } as Parameters<typeof onRequest>[0]);
      const login = await onRequest({ env, request: new Request("https://example.test/login", { method: "POST", body: new URLSearchParams({ password: env.APP_ACCESS_PASSWORD }) }) } as Parameters<typeof onRequest>[0]);
      const session = login.headers.get("set-cookie")!.split(";")[0];
      expect((await call("/api/sage/disconnect", session, {})).status).toBe(403);
      expect((await call("/api/sage/connect", session)).headers.get("location")).toContain("connection_locked");
      const wrong = await call("/api/sage/connection-access/unlock", session, { password: "wrong-test-value" });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("set-cookie")).toBeNull();
      const unlocked = await call("/api/sage/connection-access/unlock", session, { password: env.SAGE_CONNECTION_ACCESS_PASSWORD });
      expect(await unlocked.json()).toMatchObject({ connection_unlocked: true, expires_in_seconds: 300 });
      const accessCookie = unlocked.headers.get("set-cookie")!;
      expect(accessCookie).toContain("HttpOnly");
      expect(accessCookie).toContain("Secure");
      expect(accessCookie).toContain("Max-Age=300");
      const cookie = session + "; " + accessCookie.split(";")[0];
      expect(await (await call("/api/sage/status", cookie)).json()).toMatchObject({ connection_unlocked: true });
      const locked = await call("/api/sage/connection-access/lock", cookie, {});
      expect(locked.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
