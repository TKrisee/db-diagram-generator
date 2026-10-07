## Headless app PNG export

The CLI mounts the existing `src/renderer/components/Diagram.tsx` with a trusted
schema module, loads the application's stylesheet, and clicks its existing
**Full diagram** export button in Chromium. It does not implement a renderer.
Table nodes, crow's-foot edges, layout, routing, colors and PNG export come
directly from the application.

```sh
node --import tsx src/cli/exportPng.ts \
  --input /absolute/path/schema.ts --output /absolute/path/diagram.png \
  --browser /path/to/chromium --playwright /path/to/playwright
```

Playwright must be available either as `playwright` or through the optional
`--playwright` module path. `--browser` optionally selects an existing Chromium
executable; otherwise Playwright uses its installed browser. Vite and the React
plugin are existing app dependencies. A temporary local Vite server and isolated
headless browser are closed after export. No database connection is used.

Input is a **trusted executable TS/JS module**, exporting default `DiagramPayload`
or named `payload`. JSON input is not accepted. The output directory must exist.
The app's original crow's-foot marks denote FK direction and do not dynamically
encode nullable or unique cardinalities. Schema constraints remain in the table
attributes. This driver deliberately preserves that existing behavior.

The previous custom SVG renderer has been removed.

Use `--separate-edges` to spread coincident vertical relationship trunks with
the application's existing edge drag handles before exporting. This changes
only the current diagram layout through the normal app interaction handlers.
