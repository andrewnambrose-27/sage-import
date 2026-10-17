# Guided conversion workflow

The five existing sections now share accordion headers and a five-segment progress indicator. Only presentation changes when a card is collapsed: file inputs, tables, listeners and conversion data remain mounted. No additional storage is used. Step 1 opens on a new page; users can open any other card from its header or progress segment.

`src/conversionWorkflow.ts` owns the reusable headers, progress display, accordion controller, styles and pure status function. The browser application's `workflowSnapshot()` supplies existing validation outcomes, review decisions, saved source IDs, mappings, readiness responses and draft operation results. It uses the same blocking-warning predicate as Sage readiness; informational classification reasons do not count as blocking warnings.

## Completion rules

1. **Add files:** the current selection finishes the existing checks successfully. Individually optional uploads remain optional. PDF-only basic checks can complete this step without claiming CSV rows were imported. Empty CSVs, parsing failures and invalid file types/sizes do not complete it.
2. **Check the import:** CSV rows exist, no rows remain marked Review needed, included rows have no existing Sage-blocking warnings, and there are no unmatched reconciliation issues without a corresponding review row. Explicitly excluded rows do not prevent completion. A missing optional PDF is not a new requirement.
3. **Review transactions:** all reviewed rows receive saved source IDs from a successful save, review decisions still match that save, no outstanding review/blocking items remain, and the server has not requested a saved-batch refresh.
4. **Set up Sage conversion:** the reviewed batch is saved, Sage reports a connected account without requiring reconnection, current readiness has been confirmed, and included rows have confirmed customer, VAT and nominal mappings with available Sage reference options. Included rows must be ready for Sage or already imported. Excluded rows do not add mapping requirements. With no included invoices this step does not claim that drafts are ready.
5. **Create Sage draft invoices:** the selected creation operation finishes with a positive expected count and every result confirms success. A preview, a failed request, an uncertain result or partial success cannot complete this step. The summary explicitly says “selected drafts”; if more invoices are ready it shows that number too. Existing-invoice results keep the application's duplicate protection.

These statuses describe the existing workflow. They do not change processing permissions, required uploads, invoice values or API validation. Changing file selection removes downstream ticks until that selection is checked again; previous results remain available to inspect. The upload snapshot iterates the existing slot registry so a future supported slot can be counted without adding a requirement here.

## Progression and Help

Successful file checking opens Step 2 only when no unresolved import issues remain. Otherwise Step 1 stays open and offers View file check results. Step 2 has a Continue to review transactions button; it allows users to inspect and resolve warnings in the existing review interface. A successful, resolved batch save opens Sage setup, provided earlier steps have no unresolved issues. Sage setup retains its existing Continue to draft invoices action so users can inspect the saved settings first.

Automatic progression does not steal focus when the user has opened another card or Help. Existing Help links reveal their target card, including the nested Reconciliation section. Closing Help normally restores the previous position and focus. Accordion buttons expose expanded state, collapsed content is inert, touch targets and existing Help icons are retained, and reduced-motion preferences disable transitions and smooth scrolling.

## Verification

- TypeScript check and all 114 Vitest tests passed, including nine workflow status/accessibility-markup tests.
- Headless Chrome tested the complete five-step path with simulated save, Sage connection, readiness, preview and creation responses. No live Sage requests or invoices were created.
- Browser checks covered initial expansion, keyboard toggles, previous-step reopening, persistent file/table DOM nodes, uploaded files, filters, currency, Help article/search/back links, real CSV parsing, changed-file invalidation, important warnings, failed saves, saved-batch refresh requirements and partial draft failures.
- Desktop and 390-pixel mobile layouts were visually checked. Mobile overflow, Help touch targets, keyboard Help navigation, reduced motion and browser errors were checked.

Live Sage connection and draft creation were not exercised against a real account. Their existing backend tests remain unchanged and passing.

## Connection availability

The workflow is greyed out and inert until the existing Sage status endpoint confirms a configured, connected account without a reconnection requirement. Checking, disconnected and error states pause all five steps. Connection controls, Help, currency and Logout remain available. A Check connection action retries status checks; requests time out after eight seconds, and superseded responses cannot unlock the tool.

Pausing only changes presentation and interaction. It preserves uploaded File inputs, parsed records, review decisions, mappings and the open step. Keyboard actions and file drops are blocked while paused. Reconnection restores access without a page reload.

The October 17 production startup failure came from Wrangler's name-preserving helper being referenced by serialised browser functions without its surrounding bundle scope. Shared browser function serialisation now supplies that helper privately for the workflow and Help search. A regression test builds the actual Pages Worker with Wrangler and executes its emitted browser functions. All 118 tests pass; browser checks against that production bundle also cover the timeout, retry, error states, input blocking, retained progress and the complete five-step flow with simulated Sage responses.
