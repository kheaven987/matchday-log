# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Matchday Log** is a single-file HTML/CSS/JS web app (no build step, no dependencies, no package.json) for logging and tracking operational issues ("entries") at football matchday events — e.g. big screen / digiBOARD / digiRIBBON faults during a live game. It's built to run as a Claude artifact (using `window.storage`) but also stands alone in a plain browser via a `localStorage` polyfill.

There is no git repo, no test suite, and no build/lint tooling. "Development" is: edit the HTML file, open it in a browser, reload.

## File layout

- `matchday-log (2).html` — **the current/canonical copy.** All three `matchday-log*.html` files are timestamped snapshots of the same evolving artifact (re-downloaded copies), not separate components — `(2)` is newest and has the most complete logic (e.g. `refreshFixturesBtn` fetches up to 2 upcoming fixtures per client per run; older copies fetch only 1). When asked to "fix the app" or make changes, edit `matchday-log (2).html` and check whether the user wants the older duplicates deleted/reconciled — don't silently fork behavior across copies.
- `matchday-log-backup-2026-08-18.json` — a data export (see Data model below), useful as a real-world fixture/entries sample.
- `Claude Setup.exe`, `Git-2.55.0.4-64-bit.exe` — installers, unrelated to the app.

## Running it

Just open the HTML file in a browser (double-click, or drag into a tab). No server, build, or install step. Outside claude.ai it uses `localStorage` in place of the artifact `window.storage` API (see polyfill at the top of the `<script>` block) — data is per-browser-profile only.

## Architecture

Everything lives in one `<script>` IIFE at the bottom of the HTML file. It's a hand-rolled SPA: no framework, no router — five tabs (`review`/Fixtures, `capture`/log-an-entry, `log`, `clients`, `admin`) are plain `<div>`s toggled via `switchTab()`, with in-memory state (`fixtures`, `entries`, `clients`, `selectedFixtureId`, etc.) re-rendered into `innerHTML` on change. Modals (new fixture, edit client, entry detail) are built as detached `.modal-backdrop` divs appended to `document.body`.

**Data model** (persisted as three JSON blobs under `window.storage` keys `md-fixtures`, `md-entries`, `md-clients`):
- `fixtures`: `{ id, label, home, away, venue, kickoff, matchDate, closed, createdAt }`
- `entries`: `{ id, fixtureId, category, service, team, severity, clientFacing, note, resolved, timestamp }` — logged against a fixture
- `clients`: `{ id, name, venue, league, type, services[], apiSportsTeamId? }` — a client is a football club; `apiSportsTeamId` is cached lazily the first time a fixture lookup resolves it, to save an API-Sports call next time.

All writes go through `persist(saveFn, label)`, which retries a save 3x with backoff (400/900/1800ms) before falling back to a dismissible toast with a manual retry — this exists because `window.storage` (the claude.ai artifact backend) is occasionally flaky, not because local data is at risk.

**Two independent external-lookup paths**, both reached only through `lookupFixture` / `lookupUpcomingFixtures` / `lookupLeagueClubs`, which branch on whether API-Sports is usable (`apiSportsAvailable()`) *and* the client's league has an API-Sports league ID configured:
1. **API-Sports (API-Football)** — used when `APISPORTS_LEAGUE_IDS` has an entry for the client's league (Premier League, Championship, League One, League Two, Scottish Premiership) and API-Sports is available. Calls go through `apiSportsFetch()`, which hits `v3.football.api-sports.io` directly (blocked by CORS outside claude.ai — hence the Cloudflare Worker proxy configurable on the Admin tab, `PROXY_URL_STORAGE_KEY`). `DEFAULT_APISPORTS_KEY` is intentionally blank in this file (it's public) — the real key lives only as a Worker secret in `cloudflare-worker.js`'s deployment, so **API-Sports lookups require a Proxy URL to be set**; without one, `apiSportsAvailable()` is false and everything falls through to the AI path below, even for supported leagues. By design there is **no silent fallback** once API-Sports *is* available for a supported league (see comments at `lookupLeagueClubs`/`lookupFixture`) — a failure there should surface as an API-Sports error, not a confusing "Failed to fetch" from the other path.
2. **Claude web-search fallback** (`callClaudeAPI`, only reachable for leagues *not* in `APISPORTS_LEAGUE_IDS`, e.g. "Other") — calls `api.anthropic.com/v1/messages` directly with the `web_search_20250305` tool and expects a JSON-only reply, parsed by `extractJson()`. This only works inside claude.ai, where that fetch is proxied/authorized by the artifact host — it has no API key of its own and will fail outside that environment.

Club list lookups (`getClubsForLeague`) are cached 14 days per-league under `md-league-clubs-<league>`.

## Known gaps worth knowing before touching related code

- [cloudflare-worker.js](cloudflare-worker.js) is the "included Cloudflare Worker script" the Admin tab refers to for the API-Sports CORS proxy — deploy it and paste the resulting `*.workers.dev` URL into the Admin tab's Proxy URL field. The API key is **not** in this file — it's read from `env.API_SPORTS_KEY`, set as a Worker secret (`wrangler secret put API_SPORTS_KEY` or via the dashboard) so a real key never ends up in source control. It's still a wide-open proxy otherwise (no auth check, wildcard CORS) that forwards any path to `v3.football.api-sports.io` — fine for a personal tool, but worth adding a shared-secret header check if this repo/URL ever becomes more widely known.
- `DEFAULT_APISPORTS_KEY` in the HTML is deliberately blank (this repo is public on GitHub) — see the two-paths note above for what that means behaviorally. Don't put a real key back in this constant; if a client-side-only mode (no proxy) is ever needed again, add a proper Admin-tab input for it rather than hardcoding one.
- The delete password (Admin tab) is explicitly *not* real security — it's a same-page, client-stored deterrent against accidental deletes, documented as such in the UI copy.
