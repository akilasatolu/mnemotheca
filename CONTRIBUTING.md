# Contributing to Mnemotheca

This is the developer-facing guide. If you're looking for how to *use* Mnemotheca,
see [README.md](./README.md) instead — this document is about working on the tool
itself.

`akilasatolu/mnemotheca` is an ordinary OSS repository. It is never anyone's
project or vault — end users never clone it; they `npm install` it as a
dependency into their own separate project (see README's "How it is
distributed"). Keep that separation in mind throughout: nothing in this repo
should assume it is running inside a user's project directory.

---

## Setup

```sh
git clone https://github.com/akilasatolu/mnemotheca.git
cd mnemotheca
npm install
git checkout -b my-change
```

```sh
npm run typecheck   # tsc --noEmit across app / web / test tsconfigs
npm test            # vitest
npm run build       # alias for `prepare`: tsc + vite build -> dist/
```

All four must be clean before you open a PR:

```sh
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.test.json --noEmit
npx vitest run
npx vite build
```

`npm test`/`vitest` never touches real fs paths outside temp dirs and never
spawns real `npm install` or network calls — every command layer (`InitDeps`,
`DoctorDeps`, etc.) takes injected fakes for exactly this reason. If you add a
feature that shells out or hits the network, make sure it's behind the same
kind of injection point so tests stay hermetic.

## Source layout

```
src/core/     shared pure logic (fs / path only, no network)
src/mcp/      MCP stdio server + tools
src/server/   Hono HTTP server, SPA hosting, file watcher
src/cli/      commander CLI
src/web/      Vite + React SPA (bundled into dist/web)
test/         vitest unit, component, and integration tests
```

`src/core/` has no knowledge of MCP, HTTP, or the CLI — it's imported by all
three. If you're adding logic that doesn't need to know which surface called
it, it belongs there.

## Manually running the CLI while developing

**Never run `mnemo init` (or any other command) directly inside this
checkout.** It's designed to fail harmlessly if you try — `mnemo init` checks
for `node_modules/mnemo/dist/{cli,mcp}/index.js`, which never exists in this
repo's own `node_modules` (this repo is mnemo, not a project that depends on
mnemo), so it stops with `NOT_INITIALIZED` before writing anything.

But that safety net only holds if you don't force the precondition to be
true. If you ever `npm link` mnemo into itself, or manually drop a built
`dist/` under `node_modules/mnemo/` inside this checkout, `mnemo init` **will**
proceed and create `vault/`, `.mnemotheca/`, and rewrite `.gitignore` — and
because this repo's own `.gitignore` no longer has a blanket rule against
`vault/`/`.mnemotheca/` (that guard belonged to an old, since-abandoned
distribution model), those files would show up as ordinary untracked files
that `git add -A` would happily stage. Don't do this. Always test against a
separate directory instead:

### Fast local iteration — `npm install file:...`

```sh
npm run build                     # build this checkout once (or after each change)

mkdir /tmp/mnemo-manual-test && cd /tmp/mnemo-manual-test
npm init -y
npm install file:/absolute/path/to/your/mnemotheca/checkout
npx mnemo init .
npx mnemo start
```

`npm link` works the same way if you prefer that flow. This is entirely local
and fast — good for the normal edit/rebuild/retest loop. Rebuild
(`npm run build`) after each change and reinstall/relink to pick it up.

### Web UI with hot reload

Editing `src/web` through the loop above means a full `npm run build` for
every change. For fast iteration on the SPA itself, run the real API server
(through the `mnemo` you installed with `file:...` above — not
`node dist/server/boot.js` directly, see note below) against the throwaway
test project in one terminal, then Vite's dev server in another:

```sh
cd /tmp/mnemo-manual-test
npx mnemo start   # terminal 1 — opens/prints http://127.0.0.1:<port>/?t=<token>

cd /path/to/your/mnemotheca/checkout
MNEMO_PROJECT=/tmp/mnemo-manual-test npm run dev   # terminal 2 — HMR at http://127.0.0.1:5173
```

`npm run dev` proxies `/api/*` to `http://127.0.0.1:7777` (`vite.config.ts`'s
default; set `MNEMO_DEV_API_PORT` if `mnemo start` picked a different port
because 7777 was taken). With `MNEMO_PROJECT` set, `vite.config.ts` reads the
running server's token straight out of its `run.json` (same rule as
`runtimeBase()`/`runtimePaths()` in `src/core/paths.ts`) and stamps every
proxied request with `Authorization: Bearer <token>` — just open
`http://127.0.0.1:5173` with no `?t=` needed. Editing anything under
`src/web` hot-reloads against the same live vault data.

If `MNEMO_PROJECT` is unset, or `run.json` can't be found (server not
started yet, or a different `MNEMO_RUNTIME_DIR`), `npm run dev` logs a
warning and falls back to no auth — in that case append the `?t=<token>`
`mnemo start` printed to the Vite URL by hand. Note that this fallback needs
a token that was actually printed somewhere, which is why the example above
uses `mnemo start` rather than running `node dist/server/boot.js` directly —
the latter writes the same `run.json` (so the auto-injection above works
with it too) but its own console output never shows the token, so it's
useless once you're stuck without `MNEMO_PROJECT`.

### Final check before tagging a release — install from GitHub

Before cutting a release tag, also verify the *actual* install path end users
will go through, since it's a different code path (real fetch + build from a
tarball rather than a local file: link):

```sh
git push origin my-change:my-change   # push the branch/tag you want to test

mkdir /tmp/mnemo-release-check && cd /tmp/mnemo-release-check
npm init -y
npm install github:akilasatolu/mnemotheca#my-change
npx mnemo init .
```

This is slower (round-trips through GitHub, reruns `prepare` from a clean
tree) so it's not for every iteration — use it as a final check that fresh
installs of a given ref actually work before you tag it.

## The `.gitignore` managed block

`mnemo init` writes a marker-delimited block into a project's `.gitignore`
(`GITIGNORE_BEGIN`/`GITIGNORE_END` in
[`src/cli/commands/init.ts`](./src/cli/commands/init.ts)) so re-running `init`
converges it without clobbering anything a user added outside the markers.
This repo's own `.gitignore` is unrelated and independent — it is never
touched by `mnemo init` (see previous section for why).

## Pull requests

- Keep changes scoped; don't mix an unrelated refactor into a feature/fix PR.
- Update or add tests for any behavior change. A comment-only or dead-code
  removal change should leave the test count unchanged — that's a useful
  signal during review that no logic moved.
- Match the existing comment style: Japanese, terse, explaining *why*
  (a non-obvious constraint, invariant, or design-doc reference like `§8-A`)
  rather than restating what the code does.
- `VERSION_BEHIND` (comparing the installed `dependencies.mnemo` ref against
  the latest GitHub tag) was deliberately removed and not reintroduced. It's
  meaningful again under the current npm-dependency distribution model, but
  is intentionally out of scope unless a PR is specifically about adding it
  back — don't reintroduce it as a side effect of unrelated work.

## License

MIT — see [LICENSE](./LICENSE).
