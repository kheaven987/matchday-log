// Cloudflare Worker for Matchday Log. Handles two unrelated things behind one
// deployment, split by path:
//   - anything else            -> API-Sports (API-Football) CORS proxy
//   - /sync (GET/PUT)          -> cross-device data sync, backed by Workers KV
// Deploy and paste the resulting *.workers.dev URL into the relevant Admin tab
// field in index.html ("API-Sports proxy" for the proxy, "Sync URL" for sync).
//
// ---------- API-SPORTS PROXY ----------
// The API key is NOT hardcoded here on purpose — this file is meant to live in a
// public repo. Set it as a Worker secret instead, so it never appears in source:
//   wrangler secret put API_SPORTS_KEY
// or via the Cloudflare dashboard: Worker -> Settings -> Variables and Secrets ->
// add "API_SPORTS_KEY" as an encrypted secret.
//
// Retry-with-backoff on rate-limit responses: Cloudflare Workers share a large
// outbound IP pool across every Workers customer, and API-Sports appears to rate
// -limit by source IP as well as by key — so this proxy can get caught up in
// unrelated traffic from other people's Workers even on a Pro-plan key with quota
// to spare. A few retries with increasing delay gives transient contention a
// chance to clear. If API-Sports is genuinely, persistently blocking Cloudflare's
// IP ranges rather than momentarily contended, retrying won't fix it — the real
// fix at that point is running this proxy somewhere with a dedicated IP instead.
const UPSTREAM = "https://v3.football.api-sports.io";
const RETRY_DELAYS_MS = [600, 1500, 3000]; // up to 4 attempts total

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksRateLimited(status, bodyText) {
  if (status === 429) return true;
  try {
    const data = JSON.parse(bodyText);
    const errors = data && data.errors;
    if (!errors) return false;
    const text = Array.isArray(errors) ? errors.join(" ") : JSON.stringify(errors);
    return /rate ?limit/i.test(text);
  } catch (e) {
    return false;
  }
}

async function fetchWithRetry(url, headers) {
  let status, bodyText;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    const response = await fetch(url, { headers });
    status = response.status;
    bodyText = await response.text();
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
    if (!looksRateLimited(status, bodyText) || isLastAttempt) {
      return { status, bodyText };
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { status, bodyText };
}

// ---------- SYNC ----------
// Single-user, single-blob store: the whole {fixtures, entries, clients} export
// shape gets written under one KV key and read back whole. That's deliberately
// simple — fine for one person syncing their own devices, not designed for two
// people editing at the same moment (the later PUT just wins, no merging).
// Protected by a shared secret (SYNC_TOKEN, set via `wrangler secret put
// SYNC_TOKEN`) sent as the x-sync-token header — without it, anyone who found
// this Worker's URL could read or overwrite the data.
// Note: Workers KV is eventually consistent (usually fast, but not instant)
// across Cloudflare's edge, so a write on one device may take a few seconds to
// show up when another device reads it right after — acceptable for "latest
// data when I open this on another device", not meant for real-time sync.
const SYNC_KEY = "data";

async function handleSync(request, env, corsHeaders) {
  if (!env.SYNC_TOKEN) {
    return new Response(
      JSON.stringify({ error: "Worker is missing the SYNC_TOKEN secret — set it with `wrangler secret put SYNC_TOKEN` or in the dashboard." }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  if (!env.MATCHDAY_SYNC) {
    return new Response(
      JSON.stringify({ error: "Worker is missing the MATCHDAY_SYNC KV binding — add it in wrangler.toml and redeploy." }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  if (request.headers.get("x-sync-token") !== env.SYNC_TOKEN) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing sync token." }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  if (request.method === "GET") {
    const stored = await env.MATCHDAY_SYNC.get(SYNC_KEY);
    return new Response(
      stored || JSON.stringify({ fixtures: [], entries: [], clients: [], updatedAt: null }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  if (request.method === "PUT") {
    const bodyText = await request.text();
    try {
      JSON.parse(bodyText);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Body must be valid JSON." }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }
    await env.MATCHDAY_SYNC.put(SYNC_KEY, bodyText);
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  return new Response(
    JSON.stringify({ error: "Method not allowed on /sync." }),
    { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } }
  );
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-sync-token",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/sync") {
      return handleSync(request, env, corsHeaders);
    }

    if (!env.API_SPORTS_KEY) {
      return new Response(
        JSON.stringify({ error: "Worker is missing the API_SPORTS_KEY secret — set it with `wrangler secret put API_SPORTS_KEY` or in the dashboard." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    let status, bodyText;
    try {
      ({ status, bodyText } = await fetchWithRetry(upstreamUrl, { "x-apisports-key": env.API_SPORTS_KEY }));
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy could not reach API-Sports: " + err.message }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    return new Response(bodyText, {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
};
