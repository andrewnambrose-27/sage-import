export interface SageConnectionDisplayState {
  storage_configured?: boolean;
  connected?: boolean;
  reauthorization_required?: boolean;
}

// Display only: authentication and connection management remain in the existing handlers.
export function connectionIndicator(status: SageConnectionDisplayState | null, failed = false) {
  if (failed || (status && !status.storage_configured)) return { state: "error", label: "Connection error" };
  if (!status) return { state: "checking", label: "Checking connection" };
  if (status.connected && !status.reauthorization_required) return { state: "connected", label: "Sage connected" };
  return { state: "disconnected", label: "Sage disconnected" };
}

export const sageConnectionPanelJs = String.raw`
const sageConnectionIndicator = document.querySelector("#sageConnectionIndicator");
const sageConnectionPopover = document.querySelector("#sageConnectionPopover");
function updateConnectionIndicator(status = null, failed = false) {
  const display = connectionIndicator(status, failed);
  sageConnectionIndicator.dataset.state = display.state;
  sageConnectionIndicator.querySelector("[data-sage-connection-label]").textContent = display.label;
  sageConnectionIndicator.setAttribute("aria-label", display.label + ". Open Sage connection details and controls.");
}
function positionSageConnectionPopover(opening = false) {
  if (!opening && !sageConnectionPopover.matches(":popover-open")) return;
  const header = document.querySelector(".topbar").getBoundingClientRect();
  const trigger = sageConnectionIndicator.getBoundingClientRect();
  const top = Math.max(12, header.bottom + 8);
  const width = Math.min(480, document.documentElement.clientWidth - 24);
  sageConnectionPopover.style.top = top + "px";
  sageConnectionPopover.style.left = Math.max(12, Math.min(trigger.right - width, document.documentElement.clientWidth - width - 12)) + "px";
  sageConnectionPopover.style.maxHeight = Math.max(100, window.innerHeight - top - 12) + "px";
}
sageConnectionPopover.addEventListener("beforetoggle", (event) => {
  sageConnectionIndicator.setAttribute("aria-expanded", String(event.newState === "open"));
  if (event.newState === "open") positionSageConnectionPopover(true);
  if (event.newState === "closed" && (sageConnectionPopover.contains(document.activeElement) || document.activeElement === document.body)) {
    sageConnectionIndicator.focus({ preventScroll: true });
  }
});
sageConnectionPopover.addEventListener("toggle", (event) => {
  const open = event.newState === "open";
  sageConnectionIndicator.setAttribute("aria-expanded", String(open));
  if (open) positionSageConnectionPopover();
});
window.addEventListener("resize", () => positionSageConnectionPopover());
// A popover is non-modal: Escape/outside click dismiss it and the rest of the tool stays usable.
`;

export const sageConnectionPanelCss = String.raw`
.sage-connection-indicator {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: #fff; color: var(--muted); font-size: .85rem; font-weight: 700;
}
.sage-connection-indicator:hover { background: #f3f8f5; color: var(--sage-dark); }
.sage-connection-indicator[data-state="connected"] { color: var(--sage-dark); }
.sage-connection-indicator[data-state="disconnected"], .sage-connection-indicator[data-state="error"] { color: #805312; background: #fff6e6; border-color: #dab778; }
.sage-connection-symbol { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: 0 0 16px; border-radius: 50%; background: #e5eae7; color: var(--muted); font-size: .75rem; }
.sage-connection-indicator[data-state="connected"] .sage-connection-symbol { background: var(--sage); color: white; }
.sage-connection-indicator[data-state="connected"] .sage-connection-symbol::after { content: "✓"; }
.sage-connection-indicator[data-state="disconnected"] .sage-connection-symbol, .sage-connection-indicator[data-state="error"] .sage-connection-symbol { background: #a2711d; color: white; }
.sage-connection-indicator[data-state="disconnected"] .sage-connection-symbol::after, .sage-connection-indicator[data-state="error"] .sage-connection-symbol::after { content: "!"; }
.sage-connection-indicator[data-state="checking"] .sage-connection-symbol { background: transparent; border: 2px solid #dce4e1; border-top-color: var(--muted); animation: sage-checking 1s linear infinite; }
@keyframes sage-checking { to { transform: rotate(360deg); } }
.sage-connection-popover {
  position: fixed; inset: auto; margin: 0; width: min(480px, calc(100vw - 24px));
  padding: 20px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink);
  box-shadow: 0 12px 32px rgba(31,49,54,.18); overflow: auto; overscroll-behavior: contain;
}
.sage-popover-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.sage-popover-heading h2 { margin: 0; font-size: 1.15rem; }
.sage-connection-popover p { line-height: 1.55; color: var(--muted); }
.sage-connection-popover .sage-actions { justify-content: flex-start; }
.sage-connection-popover button, .sage-connection-popover .button-link { min-height: 44px; padding: 10px 14px; }
.sage-connection-popover .sage-unlock-panel { grid-template-columns: minmax(0, 1fr); margin-top: 16px; padding: 12px; }
.sage-connection-popover .sage-change-panel { margin-top: 16px; padding: 12px; }
.sage-connection-popover .sage-note { margin: 16px 0 0; }
.sage-connection-popover .sage-popover-close { width: 44px; min-width: 44px; height: 44px; padding: 0; font-size: 1.4rem; }
@media (max-width: 1080px) {
  .topbar { flex-wrap: wrap; }
  .topbar-actions { flex-wrap: wrap; }
}
@media (max-width: 820px) {
  .topbar-actions > .help-guides-button { grid-column: auto; padding-inline: 14px; }
  .sage-connection-indicator { height: 100%; }
  .sage-connection-popover { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) { .sage-connection-symbol { animation: none !important; } }
`;
