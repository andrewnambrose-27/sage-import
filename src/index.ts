interface Env {
  APP_ACCESS_PASSWORD?: string;
}

const SESSION_COOKIE = "sage_import_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/assets/styles.css") {
        return textResponse(stylesCss, "text/css; charset=utf-8");
      }

      if (url.pathname === "/assets/app.js") {
        return textResponse(appJs, "text/javascript; charset=utf-8");
      }

      if (url.pathname === "/login" && request.method === "GET") {
        if (await isAuthenticated(request, env)) {
          return redirect("/");
        }
        return htmlResponse(loginPage());
      }

      if (url.pathname === "/login" && request.method === "POST") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/logout" && request.method === "POST") {
        return redirect("/login", {
          "Set-Cookie": clearSessionCookie(url.protocol === "https:"),
        });
      }

      if (!(await isAuthenticated(request, env))) {
        return redirect("/login");
      }

      if ((url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/upload") && request.method === "GET") {
        return htmlResponse(uploadPage());
      }

      return htmlResponse(notFoundPage(), 404);
    } catch (error) {
      console.error(error);
      return htmlResponse(errorPage(), 500);
    }
  },
};

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const configuredPassword = env.APP_ACCESS_PASSWORD;
  const url = new URL(request.url);

  if (!configuredPassword) {
    return htmlResponse(loginPage("APP_ACCESS_PASSWORD is not configured for this environment."), 500);
  }

  const form = await request.formData();
  const password = String(form.get("password") ?? "");

  if (!constantTimeEqual(password, configuredPassword)) {
    return htmlResponse(loginPage("That password was not recognised."), 401);
  }

  const cookie = await createSessionCookie(configuredPassword, url.protocol === "https:");
  return redirect("/", {
    "Set-Cookie": cookie,
  });
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const configuredPassword = env.APP_ACCESS_PASSWORD;

  if (!configuredPassword) {
    return false;
  }

  const cookie = getCookie(request.headers.get("Cookie") ?? "", SESSION_COOKIE);
  if (!cookie) {
    return false;
  }

  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expectedSignature = await sign(payload, configuredPassword);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const session = JSON.parse(atobUrl(payload)) as { exp?: number };
    return typeof session.exp === "number" && session.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function createSessionCookie(secret: string, secure: boolean): Promise<string> {
  const payload = btoaUrl(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    }),
  );
  const signature = await sign(payload, secret);
  const attributes = [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function clearSessionCookie(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlFromBytes(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function getCookie(header: string, name: string): string | null {
  const cookies = header.split(";").map((part) => part.trim());

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) {
      continue;
    }

    if (cookie.slice(0, separator) === name) {
      return cookie.slice(separator + 1);
    }
  }

  return null;
}

function btoaUrl(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

function atobUrl(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders,
    },
  });
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      ...securityHeaders,
      "Cache-Control": "public, max-age=3600",
    },
  });
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function loginPage(error?: string): string {
  return layout(
    "Login",
    `
      <main class="login-shell">
        <section class="login-card" aria-labelledby="login-title">
          <div class="brand-mark" aria-hidden="true">SI</div>
          <p class="eyebrow">Private import checker</p>
          <h1 id="login-title">Sage Import Checker</h1>
          <p class="lede">Sign in to review Removals Manager exports before preparing them for Sage.</p>
          ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
          <form method="post" action="/login" class="login-form">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
            <button type="submit">Sign in</button>
          </form>
        </section>
      </main>
    `,
  );
}

function uploadPage(): string {
  return layout(
    "Upload files",
    `
      <header class="topbar">
        <div>
          <p class="eyebrow">Removals Manager to Sage</p>
          <h1>Sage Import Checker</h1>
        </div>
        <form method="post" action="/logout">
          <button class="secondary-button" type="submit">Logout</button>
        </form>
      </header>

      <main class="dashboard-shell">
        <section class="hero-panel">
          <div>
            <p class="eyebrow">Upload check</p>
            <h2>Add the export files you have available.</h2>
            <p>This step only checks file names, file types and file sizes. The app does not read invoice contents yet and does not permanently store files.</p>
          </div>
          <div class="status-stack" aria-label="Current safeguards">
            <span>Private login</span>
            <span>Optional files</span>
            <span>No file storage</span>
          </div>
        </section>

        <section class="upload-workflow" aria-labelledby="upload-title">
          <div class="section-heading">
            <div>
              <h2 id="upload-title">File upload</h2>
              <p>Each file is optional for now. Add whichever Removals Manager exports you can get, then check the files before moving on.</p>
            </div>
            <div class="button-row">
              <button id="checkButton" type="button">Check files</button>
              <button id="clearButton" class="secondary-button" type="button" disabled>Clear</button>
            </div>
          </div>

          <form id="uploadForm" class="upload-grid">
            <article class="file-card" data-slot="removalInvoices">
              <div>
                <h3>Removal invoices CSV</h3>
                <p>Use the main removals invoice export from Removals Manager.</p>
              </div>
              <label for="removalInvoices">Choose CSV</label>
              <input id="removalInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="removalDeposits">
              <div>
                <h3>Removal deposits CSV</h3>
                <p>Use this if deposits are exported separately from invoices.</p>
              </div>
              <label for="removalDeposits">Choose CSV</label>
              <input id="removalDeposits" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalDepositsMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="adHocInvoices">
              <div>
                <h3>Ad Hoc invoices CSV</h3>
                <p>Use the ad hoc invoice export if Removals Manager provides one.</p>
              </div>
              <label for="adHocInvoices">Choose CSV</label>
              <input id="adHocInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="adHocInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="creditNotes">
              <div>
                <h3>Credit notes CSV</h3>
                <p>Add credit notes here if Removals Manager can export them.</p>
              </div>
              <label for="creditNotes">Choose CSV</label>
              <input id="creditNotes" type="file" accept=".csv,text/csv">
              <p class="field-message" id="creditNotesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="monthlyReport">
              <div>
                <h3>Monthly invoice report PDF</h3>
                <p>Add the monthly invoice report PDF if it is available for checking later.</p>
              </div>
              <label for="monthlyReport">Choose PDF</label>
              <input id="monthlyReport" type="file" accept=".pdf,application/pdf">
              <p class="field-message" id="monthlyReportMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="invoicePdfs">
              <div>
                <h3>Individual invoice PDFs</h3>
                <p>Add a batch of invoice PDFs if you have them. Multiple files are allowed.</p>
              </div>
              <label for="invoicePdfs">Choose PDFs</label>
              <input id="invoicePdfs" type="file" accept=".pdf,application/pdf" multiple>
              <p class="field-message" id="invoicePdfsMessage">No files selected yet. This is optional.</p>
            </article>
          </form>
        </section>

        <section class="results-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <h2>Upload summary</h2>
              <p id="resultsIntro">Choose any files you have, then select Check files.</p>
            </div>
          </div>
          <div id="summaryNotice" class="notice"></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Upload field</th>
                  <th>File</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="summaryBody">
                <tr><td colspan="5" class="empty-state">No files checked yet.</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <script src="/assets/app.js" defer></script>
    `,
  );
}

function notFoundPage(): string {
  return layout("Not found", `<main class="message-page"><h1>Page not found</h1><a href="/">Return to dashboard</a></main>`);
}

function errorPage(): string {
  return layout("Error", `<main class="message-page"><h1>Something went wrong</h1><p>Please retry the request.</p></main>`);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Sage Import Checker</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const stylesCss = String.raw`
:root {
  color-scheme: light;
  --ink: #1d2528;
  --muted: #647174;
  --line: #d9e0df;
  --panel: #ffffff;
  --canvas: #f4f7f6;
  --sage: #0f6b5b;
  --sage-dark: #0a4a42;
  --sky: #dceff5;
  --warn: #a65319;
  --danger: #9b1c31;
  --shadow: 0 18px 50px rgba(31, 49, 54, 0.12);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(135deg, rgba(15, 107, 91, 0.09), transparent 32rem),
    var(--canvas);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input {
  font: inherit;
}

button {
  border: 0;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  cursor: pointer;
  font-weight: 700;
}

button:hover {
  background: var(--sage-dark);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.login-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.login-card {
  width: min(100%, 430px);
  padding: 34px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow);
}

.brand-mark {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 24px;
  place-items: center;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  font-weight: 800;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--sage);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 10px;
  font-size: clamp(1.85rem, 4vw, 2.55rem);
  line-height: 1.05;
}

h2 {
  margin-bottom: 10px;
  font-size: 1.15rem;
}

.lede,
.hero-panel p,
.upload-workflow p,
.section-heading p {
  color: var(--muted);
  line-height: 1.55;
}

.alert {
  padding: 12px 14px;
  border: 1px solid rgba(155, 28, 49, 0.2);
  border-radius: 8px;
  background: rgba(155, 28, 49, 0.08);
  color: var(--danger);
  font-weight: 700;
}

.login-form {
  display: grid;
  gap: 12px;
  margin-top: 24px;
}

.login-form label {
  color: var(--muted);
  font-size: 0.92rem;
  font-weight: 700;
}

.login-form input {
  width: 100%;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.login-form button {
  min-height: 46px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px clamp(18px, 4vw, 48px);
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(10px);
}

.topbar h1 {
  margin-bottom: 0;
  font-size: 1.35rem;
}

.secondary-button {
  min-height: 40px;
  padding: 0 15px;
  border: 1px solid var(--line);
  background: #ffffff;
  color: var(--ink);
}

.secondary-button:hover {
  background: #eef4f2;
}

.dashboard-shell {
  width: min(1180px, calc(100% - 32px));
  margin: 28px auto 56px;
}

.hero-panel,
.upload-workflow,
.results-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 12px 32px rgba(31, 49, 54, 0.08);
}

.hero-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  padding: clamp(22px, 4vw, 34px);
  background:
    linear-gradient(120deg, rgba(15, 107, 91, 0.12), rgba(220, 239, 245, 0.55)),
    #ffffff;
}

.hero-panel h2 {
  max-width: 760px;
  font-size: clamp(1.55rem, 3vw, 2.35rem);
  line-height: 1.12;
}

.status-stack {
  display: grid;
  gap: 10px;
  min-width: 190px;
}

.status-stack span {
  padding: 10px 12px;
  border: 1px solid rgba(15, 107, 91, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.75);
  color: var(--sage-dark);
  font-size: 0.9rem;
  font-weight: 800;
}

.upload-workflow,
.results-panel {
  margin-top: 18px;
  padding: 22px;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.button-row button {
  min-height: 40px;
  padding: 0 16px;
}

.upload-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.file-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  min-height: 158px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.file-card h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}

.file-card p {
  margin-bottom: 0;
}

.file-card label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  cursor: pointer;
  font-weight: 800;
  white-space: nowrap;
}

.file-card label:hover {
  background: var(--sage-dark);
}

.file-card input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.field-message {
  grid-column: 1 / -1;
  min-height: 22px;
  color: var(--muted);
  font-size: 0.88rem;
  font-weight: 650;
}

.field-message.error {
  color: var(--danger);
}

.field-message.success {
  color: var(--sage-dark);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.notice {
  display: none;
  margin-bottom: 18px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #f8fbfa;
  color: var(--muted);
  font-weight: 700;
}

.notice.show {
  display: block;
}

.notice.error {
  border-color: rgba(155, 28, 49, 0.25);
  background: rgba(155, 28, 49, 0.08);
  color: var(--danger);
}

.notice.success {
  border-color: rgba(15, 107, 91, 0.22);
  background: rgba(15, 107, 91, 0.08);
  color: var(--sage-dark);
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}

table {
  width: 100%;
  min-width: 900px;
  border-collapse: collapse;
  background: #ffffff;
}

th,
td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  font-size: 0.91rem;
}

th {
  background: #f1f6f5;
  color: #405054;
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}

tbody tr:last-child td {
  border-bottom: 0;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 999px;
  background: #e7f4ee;
  color: var(--sage-dark);
  font-size: 0.78rem;
  font-weight: 800;
}

.badge.warning {
  background: rgba(166, 83, 25, 0.12);
  color: var(--warn);
}

.badge.error {
  background: rgba(155, 28, 49, 0.12);
  color: var(--danger);
}

.badge.muted {
  background: #edf2f1;
  color: var(--muted);
}

.empty-state {
  padding: 34px;
  color: var(--muted);
  text-align: center;
}

.message-page {
  display: grid;
  min-height: 100vh;
  place-content: center;
  padding: 24px;
  text-align: center;
}

.message-page a {
  color: var(--sage);
  font-weight: 800;
}

@media (max-width: 820px) {
  .topbar,
  .section-heading,
  .hero-panel {
    grid-template-columns: 1fr;
  }

  .topbar,
  .section-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .upload-grid {
    grid-template-columns: 1fr;
  }

  .status-stack {
    min-width: 0;
  }

  .file-card {
    grid-template-columns: 1fr;
  }

  .file-card label,
  .button-row button {
    width: 100%;
  }
}
`;

const appJs = String.raw`
const uploadForm = document.querySelector("#uploadForm");
const summaryBody = document.querySelector("#summaryBody");
const summaryNotice = document.querySelector("#summaryNotice");
const resultsIntro = document.querySelector("#resultsIntro");
const clearButton = document.querySelector("#clearButton");
const checkButton = document.querySelector("#checkButton");

const maxFileSizeBytes = 20 * 1024 * 1024;
const uploadSlots = [
  {
    id: "removalInvoices",
    label: "Removal invoices CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "removalDeposits",
    label: "Removal deposits CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "adHocInvoices",
    label: "Ad Hoc invoices CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "creditNotes",
    label: "Credit notes CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "monthlyReport",
    label: "Monthly invoice report PDF",
    kind: "PDF",
    multiple: false,
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
  },
  {
    id: "invoicePdfs",
    label: "Individual invoice PDFs",
    kind: "PDF",
    multiple: true,
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
  },
];

for (const slot of uploadSlots) {
  const input = document.querySelector("#" + slot.id);
  input.addEventListener("change", () => updateFieldMessage(slot));
}

checkButton.addEventListener("click", () => {
  const summaries = uploadSlots.flatMap(validateSlot);
  renderSummary(summaries);
  clearButton.disabled = summaries.every((item) => item.missing);
});

clearButton.addEventListener("click", () => {
  uploadForm.reset();
  for (const slot of uploadSlots) {
    setFieldMessage(slot.id, slot.multiple ? "No files selected yet. This is optional." : "No file selected yet. This is optional.", "");
  }
  summaryNotice.className = "notice";
  summaryNotice.textContent = "";
  summaryBody.innerHTML = '<tr><td colspan="5" class="empty-state">No files checked yet.</td></tr>';
  resultsIntro.textContent = "Choose any files you have, then select Check files.";
  clearButton.disabled = true;
});

function updateFieldMessage(slot) {
  const files = getFiles(slot);
  if (files.length === 0) {
    setFieldMessage(slot.id, slot.multiple ? "No files selected yet. This is optional." : "No file selected yet. This is optional.", "");
    return;
  }

  const invalidCount = files.filter((file) => validateFile(file, slot).length > 0).length;
  if (invalidCount > 0) {
    setFieldMessage(slot.id, invalidCount + " selected file" + plural(invalidCount) + " need" + (invalidCount === 1 ? "s" : "") + " attention.", "error");
  } else {
    setFieldMessage(slot.id, files.length + " file" + plural(files.length) + " ready to check.", "success");
  }
}

function validateSlot(slot) {
  const files = getFiles(slot);
  if (files.length === 0) {
    return [{
      slot: slot.label,
      fileName: "Not added",
      type: slot.kind,
      size: "-",
      passed: true,
      missing: true,
      status: "Optional",
      message: "No file selected. You can add this later if available.",
    }];
  }

  return files.map((file) => {
    const errors = validateFile(file, slot);
    return {
      slot: slot.label,
      fileName: file.name,
      type: slot.kind,
      size: formatFileSize(file.size),
      passed: errors.length === 0,
      missing: false,
      status: errors.length === 0 ? "Passed" : "Needs attention",
      message: errors.join(" "),
    };
  });
}

function validateFile(file, slot) {
  const errors = [];
  const lowerName = file.name.toLowerCase();
  const hasAllowedExtension = slot.extensions.some((extension) => lowerName.endsWith(extension));
  const hasAllowedMime = file.type === "" || slot.mimeTypes.includes(file.type);

  if (!hasAllowedExtension || !hasAllowedMime) {
    errors.push(slot.label + " must be a " + slot.kind + " file.");
  }

  if (file.size === 0) {
    errors.push("The file is empty.");
  }

  if (file.size > maxFileSizeBytes) {
    errors.push("The file is too large. The limit is " + formatFileSize(maxFileSizeBytes) + " per file.");
  }

  return errors;
}

function renderSummary(items) {
  const selectedItems = items.filter((item) => !item.missing);
  const failedItems = selectedItems.filter((item) => !item.passed);

  if (selectedItems.length === 0) {
    summaryNotice.className = "notice show error";
    summaryNotice.textContent = "No files selected. Add any exports or PDFs you have, then check again.";
    resultsIntro.textContent = "Nothing has been selected yet.";
  } else if (failedItems.length > 0) {
    summaryNotice.className = "notice show error";
    summaryNotice.textContent = failedItems.length + " selected file" + plural(failedItems.length) + " need" + (failedItems.length === 1 ? "s" : "") + " attention before the next step.";
    resultsIntro.textContent = "Review the messages below. Files are checked only by type and size for now.";
  } else {
    summaryNotice.className = "notice show success";
    summaryNotice.textContent = selectedItems.length + " selected file" + plural(selectedItems.length) + " passed the basic checks.";
    resultsIntro.textContent = "These files are ready for the next MVP step. No contents have been parsed yet.";
  }

  summaryBody.innerHTML = items.map((item) => {
    const badgeClass = item.missing ? " muted" : item.passed ? "" : " error";
    const statusText = item.missing ? item.status : item.status + (item.message ? ": " + item.message : "");
    return "<tr>" +
      tableCell(item.slot) +
      tableCell(item.fileName) +
      tableCell(item.type) +
      tableCell(item.size) +
      '<td><span class="badge' + badgeClass + '">' + escapeHtml(statusText) + "</span></td>" +
      "</tr>";
  }).join("");
}

function getFiles(slot) {
  const input = document.querySelector("#" + slot.id);
  return Array.from(input.files || []);
}

function setFieldMessage(id, message, state) {
  const element = document.querySelector("#" + id + "Message");
  element.textContent = message;
  element.className = "field-message" + (state ? " " + state : "");
}

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }

  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }

  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function tableCell(value) {
  return "<td>" + escapeHtml(String(value ?? "")) + "</td>";
}

function plural(count) {
  return count === 1 ? "" : "s";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
`;
