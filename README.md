# Mnemotheca

A local-first Markdown "second brain", fed from your AI chats through the Model
Context Protocol (MCP).

Your knowledge lives as plain `.md` files in a `vault/` directory you can open with
Obsidian or any editor. Mnemotheca adds three things on top:

- **capture** — during a Claude conversation, ask it to save what you just worked out;
  it writes a well-formed note (frontmatter + summary + detail) into your vault
- **organize** — periodically restructure the vault (split large categories, merge
  duplicates, file loose notes) with a preview + one-step undo
- **browse** — a small local web UI with a category tree, Markdown viewer, keyword
  search, a usage dashboard, and a settings page

Everything runs on your machine. No account, no API key, no telemetry, no cost.

The CLI command is `mnemo`. "Mnemotheca" (mnemo- *memory* + -theca *repository*) is
the project name.

---

## Requirements

- **Node.js 20 LTS or newer**
- Network access **for the first setup only** (to install the package). After that,
  everything works fully offline.
- macOS, Linux, or Windows

## How it is distributed

Mnemotheca is **not published to the npm registry, and there is no one-shot `npx`
bootstrap** (`npx github:...` alone won't set up a project for you). Instead you
create your own project directory and install `mnemo` into it as a **git
dependency**, pointed at a tag on GitHub:

```sh
npm install github:akilasatolu/mnemotheca#v0.1.2
```

This puts the built tool at `node_modules/mnemo/` inside *your* project — the tool's
own repository (`akilasatolu/mnemotheca`) stays a separate, ordinary OSS checkout that
never becomes anyone's vault.

---

## Quick start

### 1. Create your project and install `mnemo`

```sh
mkdir ~/mnemo && cd ~/mnemo
npm init -y
npm install github:akilasatolu/mnemotheca#v0.1.2
npx mnemo init .
```

The directory's **name and location don't matter** — call it `~/mnemo`,
`~/notes/personal-kb`, or anything else. `npm install` fetches the tagged commit,
builds it (`prepare` runs `tsc` + `vite build`), and drops the result into
`node_modules/mnemo/dist/`.

`mnemo init` itself does **not** create `package.json` and does **not** run
`npm install` for you — it assumes you've already done the two steps above. It will:

1. check Node ≥ 20
2. verify `mnemo` is actually installed (`node_modules/mnemo/dist/cli/index.js` and
   `node_modules/mnemo/dist/mcp/index.js` both present) — if not, it stops and tells
   you to run `npm install` first
3. write/update the managed block in `.gitignore`
4. create the vault (`vault/knowledge/`, `vault/categories/`) and config
   (`.mnemotheca/config.json`)
5. build the initial search index
6. print an **MCP snippet** to paste into your AI client (see next step)

`init` is idempotent — running it again in the same directory tops up anything
missing without touching your notes.

### 2. Connect your AI client

`init` prints a JSON block like this (the paths and server key reflect wherever you
actually created your project — this example assumes `~/mnemo`):

```json
{
  "mcpServers": {
    "mnemotheca-mnemo-a1b2c3": {
      "command": "/absolute/path/to/node",
      "args": ["/home/you/mnemo/node_modules/mnemo/dist/mcp/index.js"],
      "env": { "MNEMO_PROJECT": "/home/you/mnemo" }
    }
  }
}
```

Add it to your client's MCP config, keeping any existing servers:

- **Claude Desktop** — merge into `claude_desktop_config.json`
  (`Settings → Developer → Edit Config`), then restart Claude Desktop
- **Claude Code** — merge into the project's `.mcp.json`, or run
  `claude mcp add-json mnemotheca-mnemo '<the block above>'`

The `command` is the **absolute path to `node`** on purpose — Claude Desktop does not
inherit your shell's `PATH`. If you switch Node versions later, re-run `mnemo init .`
(from inside the project) to regenerate the snippet, or run `mnemo doctor` to see the
current one.

You can re-display the snippet any time from the web UI's **Settings → MCP** panel.

### 3. Use it from a conversation

In Claude, once the MCP server is connected, just ask in natural language:

> "Save what we figured out about the deployment pipeline."

Claude calls the `mnemo_store` tool, shows you a **dry-run plan** (which files it
would create, in which category), and waits for your OK before writing anything.
Reply "go ahead" and it writes the note(s) and refreshes the index.

To open the browser UI:

> "Open my notes."

Claude calls `mnemo_show`, which starts the local server (if not already running)
and opens `http://127.0.0.1:7777` in your browser.

To tidy the vault:

> "Reorganize my knowledge base."

Claude runs `mnemo_organize_scan` → `mnemo_organize_preview` (shows the exact file
moves) → `mnemo_organize_apply` (only after you confirm). Every apply takes a
snapshot; `mnemo_organize_undo` restores the previous state.

#### MCP tools

| tool | what it does |
|---|---|
| `mnemo_store` | capture notes from the conversation (dry-run → apply) |
| `mnemo_organize_scan` / `_preview` / `_apply` / `_undo` | restructure the vault, with preview and undo |
| `mnemo_show` | start the local server and open the web UI |
| `mnemo_list_categories` | list categories and note counts (used before `store`) |
| `mnemo_get_vault_info` | project paths, note/category counts, server status |

Destructive steps (`_apply`, `_undo`) always require explicit confirmation in the
conversation — Mnemotheca never edits files without showing you the plan first.

---

## Web UI

Start it yourself with `mnemo start` (or let Claude do it via `mnemo_show`):

- **Categories** — folder tree on the left, note list on the right, sortable, with
  URL-synced filters
- **Note view** — sanitized Markdown with a table of contents, search-term
  highlighting, "copy path" and "open in Obsidian" actions
- **Search** — keyword search (IME-aware, debounced). This is literal keyword
  matching over an n-gram index, **not** semantic/embedding search
- **Dashboard** — save activity over time, by category, by mode
- **Settings** — project info, the MCP snippet, a re-index button, and diagnostics

The server binds to `127.0.0.1` only and authenticates with a per-session token.

---

## CLI reference

Run from anywhere inside your project directory (it finds the project by walking up
to `.mnemotheca/config.json`), or pass `--project <path>`.

| command | description |
|---|---|
| `mnemo init [dir]` | scaffold / repair a project directory |
| `mnemo start [--port N] [--no-open]` | run the web server in the foreground |
| `mnemo stop` | stop a running server |
| `mnemo status [--json]` | server state, project paths, index freshness |
| `mnemo open` | open the running server's URL in a browser |
| `mnemo reindex [--full] [--no-categories]` | rebuild the search index (incremental by default) |
| `mnemo doctor [--fix] [--json]` | diagnose the project; `--fix` repairs safe issues |
| `mnemo mcp` | run the stdio MCP server (this is what your AI client launches) |

Global flags: `--project <path>`, `--json`, `--quiet`.

---

## Configuration

There's no separate settings file to hand-edit for day-to-day use — `mnemo`
resolves everything from the project directory it finds itself in, plus these
optional environment variables:

| variable | effect |
|---|---|
| `MNEMO_PROJECT=/path/to/project` | pin the project explicitly instead of auto-detecting it by walking up from the current directory to find `.mnemotheca/config.json`. This is what the MCP snippet sets, since an AI client's working directory isn't your project directory. |
| `MNEMO_RUNTIME_DIR=/path` | where the run lock / server state file lives (default: your OS temp dir, or `XDG_RUNTIME_DIR` on Linux if set). Only needed if that default location isn't writable. |
| `NO_COLOR=1` / `FORCE_COLOR=1` | disable / force colored CLI output (standard convention, auto-detected otherwise from your terminal). |

Everything else — port, project paths, index freshness — is either a CLI flag
(`--port`, `--project`, `--json`, `--quiet`; see [CLI reference](#cli-reference))
or shown/managed from the web UI's **Settings** page:

- **Project info** — projectRoot, vault path, whether `mnemo` itself is
  installed (`node_modules/mnemo`)
- **MCP snippet** — re-display the JSON block from step 2 of Quick start, e.g.
  after switching Node versions
- **Re-index** — manually rebuild the search index
- **Diagnostics** — the same issues `mnemo doctor` reports (parse errors,
  duplicate notes, stale index, missing install), surfaced live

`.mnemotheca/config.json` itself holds only a schema version and
creation/update timestamps — it's not meant to be hand-edited, and contains no
absolute paths (see below).

---

## Where your data lives

Everything is inside the one project directory you created — it is self-contained and
movable, and it can be named or located however you like.

```
~/mnemo/                     (or wherever you created it)
├── package.json             your project's own package.json (dependencies.mnemo)
├── node_modules/
│   └── mnemo/                the installed tool  (gitignored)
│       └── dist/             built: dist/cli/, dist/mcp/, dist/web/
├── .mnemotheca/
│   ├── config.json          tracked in git
│   ├── index/               search index        (gitignored)
│   └── snapshots/            organize undo history (gitignored)
└── vault/
    ├── knowledge/           your notes, as <category>/<slug>.md
    ├── categories/          category display names (regenerated)
    └── .mnemotheca-vault.json
```

Volatile files (`run.json`, lock files) live outside the project, under your OS temp
directory at `<tmp>/mnemotheca/<projectHash>/`.

`config.json` contains **no absolute paths**, so you can move or copy the whole
directory and it keeps working. If you need to rebuild after moving machines, run:

```sh
npm install && npx mnemo reindex
```

The generated `.gitignore` keeps `node_modules/`, `.mnemotheca/index/`, and
`.mnemotheca/snapshots/` out of version control while tracking `config.json` and your
whole `vault/`.

---

## Updating

Bump the `#<ref>` in your project's `package.json` (`dependencies.mnemo`) to the new
tag, then reinstall:

```json
{
  "dependencies": {
    "mnemo": "github:akilasatolu/mnemotheca#v0.2.0"
  }
}
```

```sh
npm install
```

Your `vault/` and `.mnemotheca/config.json` are untouched by this — only
`node_modules/mnemo/` changes.

---

## Privacy & offline

- No network calls during normal use — only the initial `npm install` reaches GitHub.
- Nothing leaves your machine. The web server is `127.0.0.1`-only.
- `mnemo_store` runs a PII scan and refuses to write notes that contain obvious
  secrets (API keys, private keys, access tokens).

---

## Troubleshooting

```sh
mnemo doctor          # list problems
mnemo doctor --fix    # repair the safe ones (markers, stale locks, dir structure, ...)
mnemo doctor --json   # machine-readable
```

`doctor` never touches your AI client's config, never runs `npm install`, and never
auto-recovers an interrupted `organize` — it reports those and tells you the command
to run.

---

## Contributing

Want to work on Mnemotheca itself rather than just use it? See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the developer setup, source layout, and
how to manually test the CLI while developing.

## License

MIT — see [LICENSE](./LICENSE). Free software, no warranty.
