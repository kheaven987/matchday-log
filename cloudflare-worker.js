// API-Sports CORS proxy for Matchday Log.
// Deploy to Cloudflare Workers and paste the resulting *.workers.dev URL
// into the "API-Sports proxy" field on the Admin tab of index.html.
//
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

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!env.API_SPORTS_KEY) {
      return new Response(
        JSON.stringify({ error: "Worker is missing the API_SPORTS_KEY secret — set it with `wrangler secret put API_SPORTS_KEY` or in the dashboard." }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const url = new URL(request.url);
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
