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

      if ((url.pathname === "/" || url.pathname === "/dashboard") && request.method === "GET") {
        return htmlResponse(dashboardPage());
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

function dashboardPage(): string {
  return layout(
    "Dashboard",
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
            <p class="eyebrow">MVP dashboard</p>
            <h2>Upload exports, preview rows, and catch import issues early.</h2>
            <p>CSV files are processed in this browser session only. Storage invoice rows are flagged for exclusion and no Sage connection is made yet.</p>
          </div>
          <div class="status-stack" aria-label="Current safeguards">
            <span>Private login</span>
            <span>No permanent storage</span>
            <span>No Sage API calls</span>
          </div>
        </section>

        <section class="workspace-grid">
          <div class="upload-panel">
            <h2>CSV uploads</h2>
            <p>Add removals, deposits, and ad hoc invoice exports. You can select multiple files.</p>
            <label class="drop-zone" for="csvFiles">
              <span class="drop-icon" aria-hidden="true">CSV</span>
              <span>Choose CSV files</span>
              <small>Files stay in the browser for this MVP</small>
            </label>
            <input id="csvFiles" type="file" accept=".csv,text/csv" multiple>
          </div>

          <div class="summary-panel" aria-live="polite">
            <h2>Run summary</h2>
            <div id="summaryCards" class="summary-cards">
              <article><strong>0</strong><span>Files</span></article>
              <article><strong>0</strong><span>Rows read</span></article>
              <article><strong>0</strong><span>Eligible rows</span></article>
              <article><strong>0</strong><span>Issues</span></article>
            </div>
          </div>
        </section>

        <section class="results-panel">
          <div class="section-heading">
            <div>
              <h2>Preview and issues</h2>
              <p id="resultsIntro">Upload CSV files to begin checking export rows.</p>
            </div>
            <button id="clearButton" class="secondary-button" type="button" disabled>Clear</button>
          </div>
          <div id="issuesList" class="issues-list"></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Row</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Net</th>
                  <th>VAT</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="previewBody">
                <tr><td colspan="9" class="empty-state">No CSV rows loaded yet.</td></tr>
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
.upload-panel p,
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
.upload-panel,
.summary-panel,
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

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.88fr) minmax(0, 1.12fr);
  gap: 18px;
  margin-top: 18px;
}

.upload-panel,
.summary-panel,
.results-panel {
  padding: 22px;
}

.drop-zone {
  display: grid;
  gap: 8px;
  place-items: center;
  min-height: 168px;
  margin-top: 20px;
  padding: 20px;
  border: 1px dashed #8cb8af;
  border-radius: 8px;
  background: #f8fbfa;
  color: var(--sage-dark);
  cursor: pointer;
  text-align: center;
  font-weight: 800;
}

.drop-zone small {
  color: var(--muted);
  font-weight: 600;
}

.drop-icon {
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  border-radius: 8px;
  background: var(--sky);
  color: var(--sage-dark);
  font-weight: 900;
}

#csvFiles {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-cards article {
  min-height: 96px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.summary-cards strong {
  display: block;
  margin-bottom: 8px;
  font-size: 1.7rem;
}

.summary-cards span {
  color: var(--muted);
  font-size: 0.9rem;
  font-weight: 700;
}

.results-panel {
  margin-top: 18px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.issues-list {
  display: grid;
  gap: 10px;
  margin-bottom: 18px;
}

.issue-item {
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #f8fbfa;
  color: var(--muted);
}

.issue-item strong {
  color: var(--ink);
}

.issue-item.warning {
  border-color: rgba(166, 83, 25, 0.25);
  background: rgba(166, 83, 25, 0.08);
}

.issue-item.error {
  border-color: rgba(155, 28, 49, 0.25);
  background: rgba(155, 28, 49, 0.08);
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
  }

  .workspace-grid,
  .summary-cards {
    grid-template-columns: 1fr;
  }

  .status-stack {
    min-width: 0;
  }
}
`;

const appJs = String.raw`
const filesInput = document.querySelector("#csvFiles");
const summaryCards = document.querySelector("#summaryCards");
const previewBody = document.querySelector("#previewBody");
const issuesList = document.querySelector("#issuesList");
const resultsIntro = document.querySelector("#resultsIntro");
const clearButton = document.querySelector("#clearButton");

const columns = {
  type: 0,
  nominal: 2,
  date: 4,
  reference: 5,
  description: 6,
  net: 7,
  taxCode: 8,
  vat: 9,
};

filesInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }

  const results = await Promise.all(files.map(readCsvFile));
  const rows = results.flatMap((result) => result.rows);
  const issues = results.flatMap((result) => result.issues);

  renderSummary(files.length, rows, issues);
  renderIssues(issues);
  renderPreview(rows);

  resultsIntro.textContent = rows.length > 0
    ? "Showing the first 50 parsed rows. Storage rows are excluded from the eligible import count."
    : "No usable rows were found in the selected files.";
  clearButton.disabled = false;
});

clearButton.addEventListener("click", () => {
  filesInput.value = "";
  renderSummary(0, [], []);
  renderIssues([]);
  renderPreview([]);
  resultsIntro.textContent = "Upload CSV files to begin checking export rows.";
  clearButton.disabled = true;
});

async function readCsvFile(file) {
  const text = await file.text();
  const parsedRows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ""));
  const issues = [];

  if (parsedRows.length === 0) {
    issues.push(issue("error", file.name, null, "File is empty or contains no readable rows."));
    return { rows: [], issues };
  }

  const expectedColumns = mode(parsedRows.map((row) => row.length));
  const rows = parsedRows.map((row, index) => analyseRow(file.name, row, index + 1, expectedColumns, issues));
  return { rows, issues };
}

function analyseRow(fileName, raw, rowNumber, expectedColumns, issues) {
  const row = {
    fileName,
    rowNumber,
    raw,
    type: cell(raw, columns.type),
    date: cell(raw, columns.date),
    reference: cell(raw, columns.reference),
    description: cell(raw, columns.description),
    net: cell(raw, columns.net),
    taxCode: cell(raw, columns.taxCode),
    vat: cell(raw, columns.vat),
    excluded: false,
    status: "Ready",
    severity: "ok",
  };

  const rowIssues = [];
  const searchable = [row.reference, row.description].join(" ").toLowerCase();

  if (raw.length !== expectedColumns) {
    rowIssues.push("Column count differs from the rest of the file.");
  }

  if (!["SI", "SC", "SD", "SA"].includes(row.type)) {
    rowIssues.push("Unrecognised Sage transaction type.");
  }

  if (!isValidDate(row.date)) {
    rowIssues.push("Missing or invalid date.");
  }

  if (!row.reference) {
    rowIssues.push("Missing invoice/reference.");
  }

  if (!row.description) {
    rowIssues.push("Missing line description.");
  }

  const net = parseMoney(row.net);
  const vat = parseMoney(row.vat);

  if (!Number.isFinite(net)) {
    rowIssues.push("Net amount is not a valid number.");
  }

  if (!Number.isFinite(vat)) {
    rowIssues.push("VAT amount is not a valid number.");
  }

  if (row.taxCode === "T1" && Number.isFinite(vat) && vat === 0) {
    rowIssues.push("T1 tax code has zero VAT.");
  }

  if (row.taxCode === "T9" && Number.isFinite(vat) && vat !== 0) {
    rowIssues.push("T9 tax code has a VAT amount.");
  }

  if (searchable.includes("storage")) {
    row.excluded = true;
    row.status = "Excluded: storage";
    row.severity = "warning";
    issues.push(issue("warning", fileName, rowNumber, "Storage invoice row should be excluded from Sage import."));
  }

  if (rowIssues.length > 0) {
    row.status = row.excluded ? row.status : "Needs review";
    row.severity = row.excluded ? "warning" : "error";
    for (const message of rowIssues) {
      issues.push(issue(row.excluded ? "warning" : "error", fileName, rowNumber, message));
    }
  }

  return row;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function renderSummary(fileCount, rows, issues) {
  const eligibleRows = rows.filter((row) => !row.excluded && row.severity !== "error").length;
  summaryCards.innerHTML = [
    ["Files", fileCount],
    ["Rows read", rows.length],
    ["Eligible rows", eligibleRows],
    ["Issues", issues.length],
  ].map(([label, value]) => "<article><strong>" + value + "</strong><span>" + label + "</span></article>").join("");
}

function renderIssues(issues) {
  if (issues.length === 0) {
    issuesList.innerHTML = "";
    return;
  }

  const grouped = issues.slice(0, 12).map((item) => {
    const location = item.rowNumber ? item.fileName + ", row " + item.rowNumber : item.fileName;
    return '<div class="issue-item ' + item.severity + '"><strong>' + escapeHtml(location) + '</strong><br>' + escapeHtml(item.message) + "</div>";
  });

  if (issues.length > 12) {
    grouped.push('<div class="issue-item"><strong>' + (issues.length - 12) + " more issues</strong><br>Review the source files before import preparation.</div>");
  }

  issuesList.innerHTML = grouped.join("");
}

function renderPreview(rows) {
  if (rows.length === 0) {
    previewBody.innerHTML = '<tr><td colspan="9" class="empty-state">No CSV rows loaded yet.</td></tr>';
    return;
  }

  previewBody.innerHTML = rows.slice(0, 50).map((row) => {
    const badgeClass = row.severity === "ok" ? "" : " " + row.severity;
    return "<tr>" +
      tableCell(row.fileName) +
      tableCell(row.rowNumber) +
      tableCell(row.type) +
      tableCell(row.date) +
      tableCell(row.reference) +
      tableCell(row.description) +
      tableCell(row.net) +
      tableCell(row.vat) +
      '<td><span class="badge' + badgeClass + '">' + escapeHtml(row.status) + "</span></td>" +
      "</tr>";
  }).join("");
}

function tableCell(value) {
  return "<td>" + escapeHtml(String(value ?? "")) + "</td>";
}

function issue(severity, fileName, rowNumber, message) {
  return { severity, fileName, rowNumber, message };
}

function cell(row, index) {
  return String(row[index] ?? "").trim();
}

function parseMoney(value) {
  const cleaned = String(value).replace(/,/g, "").trim();
  if (cleaned === "") {
    return Number.NaN;
  }
  return Number(cleaned);
}

function isValidDate(value) {
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return !Number.isNaN(Date.parse(trimmed + "T00:00:00Z"));
  }

  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) {
    return false;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function mode(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return values.reduce((best, value) => counts.get(value) > counts.get(best) ? value : best, values[0]);
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
