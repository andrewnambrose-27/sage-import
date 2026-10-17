import { helpContent, type HelpContent, type HelpGuide } from "./helpContent";
import { helpInfoCss } from "./contextualHelp";
import { browserFunctionSource } from "./browserFunctionSource";

// Kept self-contained so the same tested search function can run in the browser.
export function searchHelpGuides(content: HelpContent, query: string): HelpGuide[] {
  const fold = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = fold(query).split(/[^a-z0-9]+/).filter(Boolean);
  return content.guides.filter((guide) => {
    const category = content.categories.find((item) => item.id === guide.categoryId);
    const text = fold([
      guide.title, guide.summary, guide.introduction ?? "", guide.answer ?? "", guide.closingNote ?? "", guide.reviewNote ?? "",
      guide.exampleFilename ?? "", ...guide.keywords, category?.title ?? "", category?.description ?? "",
      ...guide.steps.flatMap((step) => [step.title, step.body, ...(step.details ?? []), step.reviewNote ?? "", step.callout?.title ?? "", step.callout?.body ?? ""]),
      ...(guide.fileRequirements ?? []).flatMap((file) => [file.title, file.status, file.description, file.note]),
      ...(guide.callouts ?? []).flatMap((callout) => [callout.title, callout.body]),
    ].join(" "));
    const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
    return words.every((word) => tokens.some((token) => /^[0-9]+$/.test(word) ? token === word : token.startsWith(word)));
  });
}

export function renderHelpCentre(content: HelpContent = helpContent): string {
  const data = JSON.stringify(content).replace(/</g, "\\u003c");
  return `
      <dialog id="help-guides" class="help-dialog" aria-labelledby="help-title">
        <div class="help-dialog-header">
          <div><p class="eyebrow">Help / Guides</p><h2 id="help-title">Help Centre</h2></div>
          <button id="helpCloseButton" class="secondary-button" type="button" autofocus>Close help</button>
        </div>
        <div class="help-dialog-body">
          <nav id="helpBreadcrumbs" class="help-breadcrumbs" aria-label="Help Centre breadcrumb"></nav>
          <form id="helpSearchForm" class="help-search" role="search" aria-label="Search help guides">
            <label for="helpSearchInput">Search the Help Centre</label>
            <div class="help-search-controls">
              <input id="helpSearchInput" type="search" placeholder="Search files, customers, drafts…" autocomplete="off" aria-controls="helpView" aria-describedby="helpSearchStatus">
              <button id="helpClearSearch" class="secondary-button" type="button" hidden>Clear search</button>
            </div>
          </form>
          <p id="helpSearchStatus" class="help-search-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <div id="helpView"><p>Loading guides…</p></div>
        </div>
        <script id="helpContentData" type="application/json">${data}</script>
      </dialog>`;
}

export const helpCentreJs = "(() => {\nconst searchGuides = " + browserFunctionSource(searchHelpGuides) + ";\n" + String.raw`
  const opener = document.querySelector("#helpGuidesButton");
  const dialog = document.querySelector("#help-guides");
  if (!opener || !dialog) return;
  const content = JSON.parse(document.querySelector("#helpContentData").textContent);
  const body = dialog.querySelector(".help-dialog-body");
  const view = dialog.querySelector("#helpView");
  const breadcrumbs = dialog.querySelector("#helpBreadcrumbs");
  const input = dialog.querySelector("#helpSearchInput");
  const clearButton = dialog.querySelector("#helpClearSearch");
  const status = dialog.querySelector("#helpSearchStatus");
  const state = { categoryId: null, guideId: null, query: "" };
  let activeOpener = opener;
  let returnPosition = { x: 0, y: 0 };
  let restoreToolPosition = true;
  let activeTooltip = null;
  let tooltipHideTimer = 0;
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const categoryFor = (id) => content.categories.find((category) => category.id === id);
  const guidesFor = (id) => content.guides.filter((guide) => guide.categoryId === id);
  const homeButton = '<button type="button" data-help-home>Help Centre</button>';
  const iconPaths = {
    "getting-started": '<path d="m5 12 4 4L19 6"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9"/>',
    "removals-manager-exports": '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    "using-conversion-tool": '<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-8 0v6"/>',
    "sage-setup-invoices": '<path d="M7 3h10v18l-2-2-3 2-3-2-2 2V3Zm3 5h4m-4 4h4"/>',
    "troubleshooting-faqs": '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-1 .7-1.6 1-1.6 2.6M12 17h.01"/>',
  };
  function icon(id) {
    return '<span class="help-category-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (iconPaths[id] || iconPaths["getting-started"]) + '</svg></span>';
  }
  function breadcrumb(items) {
    breadcrumbs.innerHTML = '<ol>' + items.map((item) => '<li>' + item + '</li>').join("") + '</ol>';
  }
  function heading(title, description) {
    return '<h3 id="helpViewTitle" tabindex="-1">' + escape(title) + '</h3><p class="help-view-description">' + escape(description) + '</p>';
  }
  function articleList(guides, showCategory) {
    return '<ul class="help-article-list">' + guides.map((guide) => '<li><button type="button" class="help-article-button" data-help-guide="' + escape(guide.id) + '">' +
      (showCategory ? '<span class="help-article-category">' + escape(categoryFor(guide.categoryId).title) + '</span>' : '') +
      '<strong>' + escape(guide.title) + '</strong>' + (guide.contentStatus === "draft" ? '<small class="help-status-badge help-status-draft">Draft guide</small>' : '') + '<span>' + escape(guide.summary) + '</span><span class="help-card-arrow" aria-hidden="true">&rarr;</span></button></li>').join("") + '</ul>';
  }
  function callout(item) {
    const kind = ["note", "tip", "important"].includes(item.type) ? item.type : "note";
    return '<aside class="help-callout help-callout-' + kind + '" aria-label="' + escape(kind) + '"><strong>' + escape(item.title) + '</strong><p>' + escape(item.body) + '</p></aside>';
  }
  function screenshot(item) {
    if (!item || !item.alt || !(item.src.startsWith("/") && !item.src.startsWith("//") || item.src.startsWith("https://"))) return "";
    return '<figure class="help-screenshot"><img src="' + escape(item.src) + '" alt="' + escape(item.alt) + '" loading="lazy">' +
      (item.caption ? '<figcaption>' + escape(item.caption) + '</figcaption>' : '') + '</figure>';
  }
  function fileRequirements(items) {
    const labels = { required: "Required for invoice processing", recommended: "Recommended", optional: "Optional", unsupported: "Not supported by this tool" };
    return '<section class="help-file-requirements" aria-label="File requirements"><ul>' + items.map((file) =>
      '<li><h4>' + escape(file.title) + '</h4><span class="help-status-badge help-status-' + escape(file.status) + '">' + escape(labels[file.status]) + '</span><p>' + escape(file.description) + '</p><p>' + escape(file.note) + '</p></li>').join("") + '</ul></section>';
  }
  function guideSteps(steps) {
    if (!steps.length) return "";
    return '<ol class="help-guide-steps" role="list">' + steps.map((step, stepIndex) =>
      '<li id="help-step-' + escape(step.id) + '"><span class="help-guide-step-number" aria-hidden="true">' + (stepIndex + 1) + '</span><div><h4>' + escape(step.title) + '</h4>' +
      (step.status === "to-be-confirmed" ? '<span class="help-status-badge help-status-draft">To be confirmed</span>' : '') +
      (step.reviewNote ? '<p class="help-step-review">' + escape(step.reviewNote) + '</p>' : '') +
      '<p>' + escape(step.body) + '</p>' + (step.details || []).map((paragraph) => '<p>' + escape(paragraph) + '</p>').join("") +
      screenshot(step.screenshot) + (step.callout ? callout(step.callout) : '') + '</div></li>').join("") + '</ol>';
  }
  function relatedGuides(ids) {
    const guides = ids.map((id) => content.guides.find((guide) => guide.id === id)).filter(Boolean);
    if (!guides.length) return "";
    return '<nav class="help-related-links" aria-label="Related guides"><h4>Related guides</h4><ul>' + guides.map((guide) =>
      '<li><button type="button" class="help-text-button" data-help-related="' + escape(guide.id) + '">' + escape(guide.title) + '</button>' +
      (guide.contentStatus === "draft" ? ' <span class="help-status-badge help-status-draft">Draft</span>' : '') + '</li>').join("") + '</ul></nav>';
  }
  function guideView(guide) {
    const category = categoryFor(guide.categoryId);
    const siblings = guidesFor(category.id);
    const index = siblings.findIndex((item) => item.id === guide.id);
    const crumbs = [homeButton];
    if (state.query) crumbs.push('<button type="button" data-help-results>Search results</button>');
    crumbs.push('<button type="button" data-help-category="' + escape(category.id) + '">' + escape(category.title) + '</button>');
    crumbs.push('<span aria-current="page">' + escape(guide.title) + '</span>');
    breadcrumb(crumbs);
    const previousNext = (item, label) => item ? '<button type="button" class="help-related-guide" data-help-related="' + escape(item.id) + '"><span>' + label + '</span><strong>' + escape(item.title) + '</strong></button>' : '<span></span>';
    return '<article class="help-guide">' +
      '<p class="help-article-category">' + escape(category.title) + '</p>' + heading(guide.title, guide.summary) +
      (guide.contentStatus === "draft" ? '<aside class="help-draft-note"><strong>Draft guide — for review</strong><p>' + escape(guide.reviewNote) + '</p></aside>' : '') +
      (guide.introduction ? '<p class="help-introduction">' + escape(guide.introduction) + '</p>' : '') +
      (guide.contentStatus === "placeholder" ? '<aside class="help-draft-note"><strong>Guide in preparation</strong><p>These are temporary starter notes. Detailed instructions and screenshots will be added next.</p></aside>' : '') +
      (guide.answer ? '<div class="help-faq-answer"><p>' + escape(guide.answer) + '</p></div>' : '') +
      (guide.callouts || []).map(callout).join("") +
      (guide.fileRequirements ? fileRequirements(guide.fileRequirements) : '') + guideSteps(guide.steps) +
      (guide.exampleFilename ? '<div class="help-example"><strong>Example filename</strong><code>' + escape(guide.exampleFilename) + '</code></div>' : '') +
      (guide.closingNote ? '<p class="help-closing-note">' + escape(guide.closingNote) + '</p>' : '') +
      (guide.toolTarget ? '<div class="help-tool-action"><a class="button-link" data-help-tool href="#' + escape(guide.toolTarget) + '">' + escape(guide.toolLabel || "Go to this step in the tool") + ' &rarr;</a><p>Closes Help and returns to your current conversion.</p></div>' : '') +
      relatedGuides(guide.relatedGuideIds || []) +
      '<nav class="help-guide-pagination" aria-label="More guides in ' + escape(category.title) + '">' + previousNext(siblings[index - 1], "Previous guide") + previousNext(siblings[index + 1], "Next guide") + '</nav>' +
      '<button type="button" class="help-text-button" data-help-category="' + escape(category.id) + '">View all ' + escape(category.title) + ' guides</button></article>';
  }
  function render(moveFocus = true) {
    clearButton.hidden = !state.query;
    status.textContent = "";
    const guide = content.guides.find((item) => item.id === state.guideId);
    const category = categoryFor(state.categoryId);
    if (guide) {
      view.innerHTML = guideView(guide);
    } else if (state.query) {
      const results = searchGuides(content, state.query);
      breadcrumb([homeButton, '<span aria-current="page">Search results</span>']);
      status.textContent = results.length + (results.length === 1 ? " guide found." : " guides found.");
      view.innerHTML = heading("Search results", 'Results for “' + state.query + '”') +
        (results.length ? articleList(results, true) : '<div class="help-empty"><h4>No matching guides yet</h4><p>Try a shorter phrase such as files, customers or drafts, or browse the categories.</p><button type="button" class="secondary-button" data-help-home>Browse all categories</button></div>');
    } else if (category) {
      breadcrumb([homeButton, '<span aria-current="page">' + escape(category.title) + '</span>']);
      view.innerHTML = heading(category.title, category.description) + articleList(guidesFor(category.id), false);
    } else {
      breadcrumb(['<span aria-current="page">Help Centre</span>']);
      view.innerHTML = heading("How can we help?", "Browse a category or search for the part of the conversion you need help with.") +
        '<div class="help-category-grid">' + content.categories.map((item) => '<button type="button" class="help-category-card" data-help-category="' + escape(item.id) + '">' + icon(item.id) + '<strong>' + escape(item.title) + '</strong><span>' + escape(item.description) + '</span><small>' + guidesFor(item.id).length + ' guides <span aria-hidden="true">&rarr;</span></small></button>').join("") + '</div>';
    }
    if (moveFocus) {
      body.scrollTop = 0;
      view.querySelector("#helpViewTitle").focus({ preventScroll: true });
    }
  }
  function resetSearch() {
    state.query = "";
    input.value = "";
  }
  function hideHelpTooltip() {
    window.clearTimeout(tooltipHideTimer);
    if (activeTooltip) activeTooltip.hidden = true;
    activeTooltip = null;
  }
  function showHelpTooltip(button) {
    const tooltip = document.getElementById(button.getAttribute("aria-describedby"));
    if (!tooltip) return;
    window.clearTimeout(tooltipHideTimer);
    if (activeTooltip === tooltip && !tooltip.hidden) return;
    hideHelpTooltip();
    tooltip.hidden = false;
    const bounds = button.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const left = Math.max(12, Math.min(bounds.left + bounds.width / 2 - size.width / 2, viewportWidth - size.width - 12));
    const top = bounds.bottom + size.height + 12 <= window.innerHeight ? bounds.bottom + 8 : Math.max(12, bounds.top - size.height - 8);
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
    activeTooltip = tooltip;
  }
  function openHelp(guideId, trigger = opener) {
    hideHelpTooltip();
    if (guideId !== undefined) {
      const guide = content.guides.find((item) => item.id === guideId);
      state.guideId = guide?.id ?? null;
      state.categoryId = guide?.categoryId ?? null;
      resetSearch();
      render(false);
      if (guideId && !guide) status.textContent = "This guide is unavailable. Browse the Help Centre to find guidance.";
    }
    activeOpener = trigger;
    returnPosition = { x: window.scrollX, y: window.scrollY };
    restoreToolPosition = true;
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("help-open");
    opener.setAttribute("aria-expanded", "true");
    activeOpener.setAttribute("aria-expanded", "true");
    body.scrollTop = 0;
    if (!state.categoryId && !state.guideId && !state.query) input.focus({ preventScroll: true });
    else view.querySelector("#helpViewTitle").focus({ preventScroll: true });
  }
  opener.addEventListener("click", () => openHelp());
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-help-open]") : null;
    if (button && !button.disabled) openHelp(button.dataset.helpOpen, button);
  });
  document.addEventListener("pointerover", (event) => {
    const host = event.target instanceof Element ? event.target.closest(".help-info") : null;
    if (host) {
      const button = host.querySelector(".help-info-button");
      if (button) showHelpTooltip(button);
    }
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".help-info-button") : null;
    if (button) window.requestAnimationFrame(() => {
      if (document.activeElement === button && !dialog.open) showHelpTooltip(button);
    });
  });
  for (const eventName of ["pointerout", "focusout"]) {
    document.addEventListener(eventName, (event) => {
      const host = event.target instanceof Element ? event.target.closest(".help-info") : null;
      if (host && !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) {
        tooltipHideTimer = window.setTimeout(hideHelpTooltip, 120);
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeTooltip && !dialog.open) {
      hideHelpTooltip();
      event.preventDefault();
    }
  });
  window.addEventListener("scroll", hideHelpTooltip, true);
  window.addEventListener("resize", hideHelpTooltip);
  dialog.querySelector("#helpCloseButton").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    document.body.classList.remove("help-open");
    opener.setAttribute("aria-expanded", "false");
    activeOpener.setAttribute("aria-expanded", "false");
    if (restoreToolPosition) {
      if (activeOpener.isConnected) activeOpener.focus({ preventScroll: true });
      window.scrollTo(returnPosition.x, returnPosition.y);
    }
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  input.addEventListener("input", () => {
    state.query = input.value.trim();
    state.guideId = null;
    state.categoryId = null;
    render(false);
  });
  dialog.querySelector("#helpSearchForm").addEventListener("submit", (event) => { event.preventDefault(); render(); });
  clearButton.addEventListener("click", () => { resetSearch(); state.guideId = null; state.categoryId = null; render(false); input.focus(); });
  dialog.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const categoryButton = target.closest("[data-help-category]");
    const guideButton = target.closest("[data-help-guide], [data-help-related]");
    if (target.closest("[data-help-home]")) {
      state.categoryId = null; state.guideId = null; resetSearch(); render();
    } else if (target.closest("[data-help-results]")) {
      state.categoryId = null; state.guideId = null; render();
    } else if (categoryButton) {
      state.categoryId = categoryButton.dataset.helpCategory; state.guideId = null; resetSearch(); render();
    } else if (guideButton) {
      state.guideId = guideButton.dataset.helpGuide || guideButton.dataset.helpRelated;
      state.categoryId = content.guides.find((guide) => guide.id === state.guideId).categoryId;
      if (guideButton.hasAttribute("data-help-related")) resetSearch();
      render();
    } else if (target.closest("a[data-help-tool]")) {
      restoreToolPosition = false;
      const link = target.closest("a[data-help-tool]");
      if (document.querySelector(".workflow-card")) {
        event.preventDefault();
        dialog.close();
        document.dispatchEvent(new CustomEvent("workflow:reveal", { detail: { id: link.hash.slice(1) } }));
        return;
      }
      dialog.close();
    } else if (target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    }
  });
  render(false);
})();
`;

export const helpCentreCss = String.raw`
.dashboard-page.help-open { overflow: hidden; }
.help-dialog {
  width: min(960px, calc(100% - 32px));
  height: min(820px, calc(100dvh - 48px));
  max-height: calc(100dvh - 48px);
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.help-dialog[open] { display: flex; flex-direction: column; }
.help-dialog::backdrop { background: rgba(10, 74, 66, 0.38); backdrop-filter: blur(3px); }
.help-dialog-header {
  display: flex; flex-shrink: 0; align-items: center; justify-content: space-between;
  gap: 16px; padding: 22px 28px; border-bottom: 1px solid var(--line);
}
.help-dialog-header h2 { margin: 0; font-size: 1.4rem; }
.help-dialog-header button { flex-shrink: 0; }
.help-dialog-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 24px 28px 32px; }
.help-dialog a { color: var(--sage-dark); font-weight: 750; text-underline-offset: 3px; }
.help-dialog a.button-link { color: #fff; }
.help-breadcrumbs { margin-bottom: 22px; font-size: 0.83rem; line-height: 1.65; }
.help-breadcrumbs ol { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.help-breadcrumbs li { display: inline; overflow-wrap: anywhere; }
.help-breadcrumbs li + li::before { content: "/"; margin-right: 6px; color: var(--muted); }
.help-breadcrumbs button, .help-text-button {
  padding: 0; border: 0; border-radius: 2px; background: transparent; color: var(--sage-dark);
  font: inherit; font-weight: 750; text-decoration: underline; text-underline-offset: 3px;
}
.help-breadcrumbs button:hover, .help-text-button:hover { background: transparent; color: var(--sage); }
.help-breadcrumbs [aria-current] { color: var(--muted); }
.help-search { margin-bottom: 0; }
.help-search label { display: block; margin-bottom: 8px; font-size: 0.88rem; font-weight: 750; }
.help-search-controls { display: flex; gap: 10px; }
.help-search input {
  flex: 1; min-width: 0; width: 100%; min-height: 48px; padding: 12px 14px;
  border: 1px solid #9cafaa; border-radius: 8px; background: #fff; color: var(--ink); font: inherit;
}
.help-search input::placeholder { color: var(--muted); opacity: 1; }
.help-search-status { margin: 8px 0 20px; min-height: 20px; color: var(--muted); font-size: 0.83rem; }
#helpViewTitle { margin: 0 0 8px; font-size: clamp(1.35rem, 3vw, 1.7rem); line-height: 1.25; }
.help-view-description { margin: 0 0 24px; color: var(--muted); line-height: 1.55; max-width: 75ch; }
.help-category-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.help-category-card {
  display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 6px 14px; align-content: start;
  min-height: 150px; padding: 20px; border: 1px solid var(--line); border-radius: 8px;
  background: #fff; color: var(--ink); text-align: left; font-weight: 400;
}
.help-category-card:last-child:nth-child(odd) { grid-column: 1 / -1; }
.help-category-card:hover, .help-article-button:hover, .help-related-guide:hover { background: #f4f9f7; border-color: var(--sage); }
.help-category-icon { grid-row: 1 / 4; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 9px; background: #e3f0eb; color: var(--sage); }
.help-category-icon svg { width: 25px; height: 25px; }
.help-category-card strong { font-size: 1.06rem; line-height: 1.4; }
.help-category-card > span:not(.help-category-icon) { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
.help-category-card small { margin-top: 8px; color: var(--sage-dark); font-weight: 750; }
.help-article-list { display: grid; gap: 12px; list-style: none; padding: 0; margin: 0; }
.help-article-button {
  position: relative; display: grid; gap: 7px; width: 100%; padding: 20px 52px 20px 20px;
  border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); text-align: left;
}
.help-article-button strong { font-size: 1rem; line-height: 1.4; }
.help-article-button > span:not(.help-article-category):not(.help-card-arrow) { color: var(--muted); line-height: 1.55; font-weight: 400; }
.help-card-arrow { position: absolute; right: 22px; top: 50%; transform: translateY(-50%); color: var(--sage); font-size: 1.3rem; }
.help-article-category { color: var(--sage-dark); font-size: 0.78rem; font-weight: 750; margin: 0 0 10px; }
.help-article-button .help-article-category { margin: 0; }
.help-draft-note { padding: 14px 16px; margin: 0 0 24px; background: #f4f7f6; border: 1px dashed #9cafaa; border-radius: 8px; font-size: 0.88rem; }
.help-draft-note p { margin: 5px 0 0; line-height: 1.55; color: var(--muted); }
.help-introduction, .help-faq-answer, .help-closing-note { line-height: 1.7; }
.help-introduction { margin-bottom: 24px; }
.help-status-badge { display: inline-block; width: fit-content; padding: 4px 8px; border: 1px solid #abcfc2; border-radius: 6px; color: var(--sage-dark); background: #edf6f2; font-size: 0.75rem; font-weight: 750; line-height: 1.5; }
.help-status-draft, .help-status-unsupported { border-color: #e1bc72; background: #fffaf0; color: #764312; }
.help-status-optional { border-color: var(--line); background: #f4f7f6; color: var(--muted); }
.help-file-requirements ul { display: grid; gap: 16px; padding: 0; list-style: none; margin: 24px 0; }
.help-file-requirements li { border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
.help-file-requirements h4 { margin: 0 0 10px; font-size: 1.05rem; }
.help-file-requirements p { margin: 12px 0 0; line-height: 1.65; }
.help-guide-steps .help-step-review { margin-top: 12px; padding: 12px; background: #fffaf0; border-left: 3px solid #a65319; }
.help-guide-steps .help-status-badge { margin-bottom: 12px; }
.help-example { display: grid; gap: 8px; margin: 24px 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
.help-example code { overflow-wrap: anywhere; line-height: 1.6; font-size: 0.88rem; }
.help-related-links { margin: 24px 0; line-height: 1.7; }
.help-related-links h4 { margin: 0 0 12px; font-size: 1rem; }
.help-related-links ul { display: grid; gap: 12px; margin: 0; padding-left: 20px; }
.help-related-links button { text-align: left; }
.help-callout { padding: 16px 18px; margin: 18px 0; border: 1px solid #abcfc2; border-left: 4px solid var(--sage); border-radius: 8px; background: #f4f9f7; }
.help-callout-important { border-color: #e1bc72; border-left-color: #a65319; background: #fffaf0; }
.help-callout p { margin: 6px 0 0; line-height: 1.6; }
.help-guide-steps { list-style: none; margin: 28px 0; padding: 0; }
.help-guide-steps > li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 14px; margin-bottom: 26px; }
.help-guide-step-number { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--sage); color: #fff; font-weight: 800; }
.help-guide-steps h4 { margin: 5px 0 10px; font-size: 1.05rem; line-height: 1.4; }
.help-guide-steps p { margin: 0 0 12px; line-height: 1.7; }
.help-guide-steps .help-callout p { margin-bottom: 0; }
.help-screenshot { margin: 18px 0; }
.help-screenshot img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
.help-screenshot figcaption { margin-top: 8px; color: var(--muted); font-size: 0.85rem; line-height: 1.5; }
.help-tool-action { margin: 26px 0; }
.help-tool-action .button-link { white-space: normal; line-height: 1.5; }
.help-tool-action p { margin: 10px 0 0; color: var(--muted); font-size: 0.85rem; }
.help-guide-pagination { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 28px 0 20px; padding-top: 22px; border-top: 1px solid var(--line); }
.help-related-guide { display: grid; gap: 8px; padding: 16px; border: 1px solid var(--line); background: #fff; color: var(--ink); text-align: left; line-height: 1.45; }
.help-related-guide > span { color: var(--muted); font-size: 0.8rem; font-weight: 400; }
.help-empty { padding: 26px; border: 1px dashed var(--line); border-radius: 8px; line-height: 1.6; }
.help-empty h4 { margin: 0 0 8px; font-size: 1rem; }
.help-empty p { color: var(--muted); }
@media (max-width: 620px) {
  .help-dialog { width: calc(100% - 20px); height: calc(100dvh - 24px); max-height: calc(100dvh - 24px); }
  .help-dialog-header { padding: 16px; gap: 12px; }
  .help-dialog-header h2 { font-size: 1.2rem; }
  .help-dialog-header .eyebrow { font-size: 0.65rem; }
  .help-dialog-header button { padding: 0 12px; }
  .help-dialog-body { padding: 20px 16px 28px; }
  .help-category-grid, .help-guide-pagination { grid-template-columns: 1fr; }
  .help-category-card:last-child:nth-child(odd) { grid-column: auto; }
  .help-category-card { min-height: 0; padding: 18px 16px; }
  .help-search-controls { flex-wrap: wrap; }
  .help-search input { flex-basis: 100%; }
  .help-search-controls button { min-height: 40px; }
  .help-guide-steps > li { gap: 10px; }
  .help-guide-pagination > span:empty { display: none; }
}
` + helpInfoCss;
