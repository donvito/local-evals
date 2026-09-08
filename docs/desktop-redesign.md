# Desktop workspace redesign

The redesign follows the supplied reference's adjacent navigation, record lists, and inspection area. It keeps the existing local evaluation workflows and reorganizes their presentation.

## Structure

**Before:** Runs used a 250px history column alongside a long inspector. The inspector stacked the run header, snapshot disclosure, case browser, selected case, execution log, JSON, and grading/timing. At 1440 × 900, the freshly built baseline with the synthetic three-case document run had a 2,475px document height. The selected case began near the bottom of the first screen.

**After:** Navigation, run history, case selection, and the selected case form one desktop workspace. History and cases scroll independently, while the selected case's toolbar remains adjacent to its content. Secondary information occupies tabs, so opening JSON or execution evidence does not require finding another section down the page.

## Density

**Before:** The application header was 72px high, controls had a 40px minimum height, case rows were 52px, primary page titles were 28px, and panel corners used a 12px radius. The case list had a 336px height cap, exposing about six complete rows.

**After:** The header is 48px, controls are 30px, case rows are 32px, and ordinary page titles are 22px. Data uses compact monospace typography; section labels use small uppercase text. The case list uses the available pane height instead of the previous 336px cap. Redundant introductory headings and explanatory labels have been removed from the inspection path.

## Navigation and lists

**Before:** The expanded 200px navigation sidebar, padded run cards, three-line history entries, and case browser consumed much of the initial screen. Previous/next controls lived below the case list, separated from the selected case.

**After:** A compact icon rail is the default for new preferences, with the existing expand/collapse control retained. Run entries put abbreviated IDs, compact timestamps, and status together. Case selection uses a thin accent bar and tinted row. Filtering and failed-only controls remain beside the cases; previous/next controls sit with the selected case's title. The mobile selection fallback remains available.

## Detail workspace

**Before:** Source and transcription appeared first, followed by execution, expected/actual JSON, and grading/timing. Reaching the last regions meant scrolling away from the case selector and source.

**After:** Source and transcription share a view; JSON, execution, timing/judge, and metadata have dedicated tabs. Document, text-to-JSON, and tool-calling workflows retain their distinct output presentations. Raw provider envelopes, snapshot/attempt data, failures, and judge evidence remain accessible. Image zoom remains an overlay rather than a separate page.

## Actions

**Before:** Run setup appeared in the page header and again beside the run information, while exports and comparison were separated from case navigation.

**After:** Case navigation, exports, setup access, and comparison are grouped in the inspection toolbar. Compare is the dominant action; exports and setup use quieter treatments. The selected run is supplied to comparison so the action carries its context forward.

## Data presentation

**Before:** IDs and timestamps largely followed interface typography, long timestamps expanded history entries, and missing expected data occupied a full output card.

**After:** IDs, times, durations, and machine output use monospace fonts and compact formatting. Missing reference or expected output becomes a short status line. Detailed JSON remains inspectable, while a bottom strip keeps timing and attempt/judge summaries available without opening the full breakdown.

## Visual system

**Before:** Green accents, rounded white cards, nested bordered containers, pills, and generous gaps created a dashboard appearance.

**After:** A steel-blue accent unifies selection, focus, active tabs, and the primary action. Hairline dividers, restrained surfaces, nearly square controls, and compact labels make the regions read as one application. The shared tokens also tighten datasets, provider configuration, setup, overview, and comparison.

## Why it feels like a tool

The user can select a run, move through cases, inspect output, and check evidence while retaining the surrounding context. Space is allocated to records and data instead of large page introductions and repeated containers. The interface is organized around repeated inspection operations, with predictable panes and nearby controls.

## Verification

- Build and TypeScript checks pass.
- All 83 tests across 15 files pass.
- Document smoke and native text/tool smoke pass with expected deliberate regressions.
- Browser interactions pass: previous/next, empty and reset filters, all detail tabs, arrow-key tab navigation, image zoom/Escape, both exports, and comparison.
- At 1440 × 900, the final Runs document is exactly 900px high. The case detail occupies y=48 through y=900; its timing strip occupies y=852 through y=900. The baseline was 2,475px tall on the same viewport.
- The live 56-case receipt run exposes 23 complete 32px case rows, compared with roughly six in the previous capped browser. Run rows are 48px. The desktop run and case panes are 220px and 280px; the default navigation rail is 52px.
- Desktop checks at 1440px and 1100px have no page-level overflow. At 768px and 390px, panes stack with normal vertical scrolling and no horizontal page overflow.
- Reviewed live read-only data at localhost:4182, including the receipt inspector and dataset library. Mutating evaluation/import flows were exercised only through existing offline smoke fixtures, not the user's saved configuration.
- Additional live browser checks pass for the no-case metadata disclosure, dataset creator open/close, dataset filter/reset, and dataset page width at 768px and 390px.
- Independent review findings were resolved: selected-case attempt counts, metadata access on runs without results, and navigation focus restoration.

## Additional dataset tightening

Repeated page descriptions and the separate imported-dataset/workspace introductions were removed. Create, JSONL import, and sample imports now share one 47px-high management toolbar at 1440px desktop width, with wrapping on small screens. Search has one field instead of a label, explanation, and field stack. Case previews show two compact lines; selecting a row still reveals complete data in the adjacent detail region. Pane gutters and nested borders were reduced. All import, provider-generation, raw JSONL, expanded viewer, filter, and image interactions remain available.

## Inspection refinements

The input image or text now lives in a persistent reference pane outside the tab content. It remains mounted when switching among transcription/output, JSON, execution, timing, and metadata; reference and tab content scroll independently. Image zoom remains available from every tab. The non-document first tab is labeled Output because input is always visible beside it.

Run and case error banners have been replaced with clickable status chips in the detail header. Failure details, recovery guidance, and technical output open in a native dialog with Close/Escape dismissal and focus return. A failed run no longer shifts the Cases pane downward.
