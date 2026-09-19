<p align="center">
  <img src="build/icons/512x512.png" width="150px" height="150px" alt="DB Diagram Generator">
</p>

<h1 align="center">DB Diagram Generator</h1>

Native desktop tool that connects to a database, picks a table, and renders its columns + foreign-key neighbors as an ER diagram. Read-only, with one-click PNG export. Inspired by [dbdiagram.io](https://dbdiagram.io/) and [chartdb](https://github.com/chartdb/chartdb), but without the visual editor — just point it at a live schema and look.

Built with Electron, React, TypeScript, and [React Flow](https://reactflow.dev/). Cross-platform (macOS, Windows, Linux).

## Features

- Connect to a live database, pick a table, see it diagrammed with its FK neighbors.
- Column metadata on each node: data type, length, precision, nullable, primary-key and foreign-key badges.
- Auto-layout with [dagre](https://github.com/dagrejs/dagre) (left-to-right). Drag nodes; viewport stays put.
- Snap-to-grid toggle (icon button in the bottom-left controls).
- Auto-fit node width based on widest column row (with min/max bounds).
- Export the current diagram to PNG with a single click.
- SQL editor for SELECT queries, with real result rows and automatic diagram filtering to referenced tables.
- Animated query walkthrough with pause, step, speed, and replay controls; filter returned rows without rerunning SQL.
- Save and recall connections — passwords encrypted via the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux).
- No telemetry, no SaaS, no account.

## Status

PostgreSQL, MySQL, and SQL Server support schema diagrams and SELECT queries. SQLite file connections remain a stub.

| Dialect | Driver | Status |
|---|---|---|
| PostgreSQL | `pg` | ✅ Implemented |
| MySQL / MariaDB | `mysql2` | ✅ Implemented |
| MS SQL Server | `mssql` | ✅ Implemented |
| SQLite | `node:sqlite` (planned) | ⏳ Stub |

The built-in **Demo** dialect ships a small schema and sample rows (`users`, `orders`, `sessions`) so you can try diagrams and SQL queries without connecting to a database. Demo queries use an isolated in-memory SQLite database.

## Quick start

Requires **Node.js 22.22+ or 24+** (the Demo query tests use built-in `node:sqlite` with array-row support).

```bash
npm install
npm run dev
```

The Electron window opens with a connection form. Pick **Demo**, click **Connect**, click any table — done. To use a real database, pick the dialect, fill in credentials, and connect.

The sidebar contains the **Schema** and **SQL editor** views, table search and filters, and PNG export. Use **Sidebar** in the top bar to hide or show it; your query, results, and table selection stay in place.

## Build

```bash
npm run typecheck      # full TS check (main + preload + renderer)
npm test               # SQL analysis and query execution regression tests
npm run build          # bundle main / preload / renderer
```

## SQL editor

The editor suggests tables, schemas, columns, and SQL keywords from the loaded schema as you type. Use a table alias such as `u.` to see its columns. Press **Ctrl+Space** or click **Suggestions** to open the list, **↑/↓** to choose, **Enter** or **Tab** to accept, and **Esc** to dismiss. Suggestions run locally; incomplete SQL does not trigger validation errors while you type.

Without a suggestion selected, **Tab** indents the current line or selected lines and **Shift+Tab** outdents them. Press **Esc**, then **Tab** to move keyboard focus out of the editor.

Connect, then open **SQL editor**. Demo starts with a join between users and orders:

```sql
SELECT u.name, o.id AS order_id, o.total, o.status
FROM public.users AS u
JOIN public.orders AS o ON o.user_id = u.id
WHERE o.total >= 50
ORDER BY o.total DESC;
```

Click **Run SELECT** or press **⌘/Ctrl + Enter**. The diagram updates after a 1.5-second pause in typing; incomplete SQL keeps the last valid diagram, and validation errors appear only when you run the query. **Only tables in query** hides unrelated tables. Schema-qualified table names resolve ambiguity when multiple schemas contain the same name. Views and other sources absent from the schema diagram are reported after running the query.

The walkthrough highlights source tables and illustrates the query's logical clauses, then animates the returned rows. Use **Pause**, **Step**, **Replay**, or the speed selector to explore it. This is a logical explanation, not an execution plan: intermediate row counts are not measured, and diagram lines remain schema foreign keys. Nested queries and set operations receive an overview. Reduced-motion preferences disable automatic playback and visual motion.

Each step emphasizes its referenced tables and columns: for example, `WHERE o.total >= 50` highlights only `orders.total`. A step banner lists the targets, while bold outlines, column sweeps, and animated join lines make playback easier to follow. Pausing keeps the highlights visible. Result operations emphasize the result grid; ambiguous or unresolved references are identified without guessing which table to highlight.

Results preserve duplicate column names and NULL values. **Filter returned rows** searches the displayed data locally. At most 500 rows are returned, with a truncation notice when more exist; query execution has a 15-second timeout.

Only one SELECT statement (including read-only CTEs) can run at a time. Writes, SELECT INTO, locking clauses, executable MySQL comments, and parameter placeholders are rejected. Queries must use syntax supported by the SQL parser for the connected dialect. PostgreSQL and MySQL queries use separate read-only transactions; use a database account with read-only permissions as the final permissions boundary, including for database functions. Demo runs in a separate process with SQLite's query-only mode. SQL and results stay in memory for the connection session.

## Package as a native app

`electron-builder` is wired for all three platforms:

```bash
npm run package        # current OS / current arch
npm run package:mac    # macOS  (.dmg + .zip)
npm run package:win    # Windows (.exe NSIS installer + .zip)
npm run package:linux  # Linux  (.AppImage + .deb)
npm run package:all    # all three
```

Output lands in `release/`.

> **macOS code signing** is not configured. The app runs fine locally on the build machine, but Gatekeeper will block it on other Macs. For distribution outside your own machine, you need an Apple Developer cert and notarization.

## Architecture

Three-layer split, enforced by where files live:

```
src/
├── main/         Electron main process. Owns DB connections + credentials.
│   ├── db/       Per-dialect adapters: postgres, mysql, sqlite, mssql, demo.
│   └── connections.ts   Saved-connection persistence via safeStorage.
├── preload/      contextBridge — exposes a typed, narrow API to the renderer.
├── renderer/     React app. Pure UI. Talks to main only via window.db.
└── shared/       IPC channel names + DB schema types used by both sides.
```

DB drivers live exclusively in the main process. The renderer never imports a driver — node-native modules don't load in the renderer sandbox, and credentials never enter the UI bundle. All introspection results cross IPC as a normalized `TableSchema` shape (defined in `src/shared/schema.ts`), so per-dialect quirks stay in main.

For diagram rendering, the renderer runs dagre in-browser to lay out the React Flow graph and uses [`html-to-image`](https://github.com/bubkoo/html-to-image) (pinned to **exactly 1.11.11** — newer versions silently drop edges from the export) for PNG snapshots.

## Saved connections

Saved connection metadata lives in `connections.json` under your OS userData directory (`~/Library/Application Support/DB Diagram Generator/` on macOS). Passwords are encrypted with [Electron's `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage). On Linux, if neither gnome-libsecret nor kwallet is available, the app refuses to save — it will not silently downgrade to weak obfuscation.

## License

See [LICENSE](LICENSE).
