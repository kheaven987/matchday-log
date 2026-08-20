// API-Sports CORS proxy for Matchday Log.
// Deploy to Cloudflare Workers and paste the resulting *.workers.dev URL
// into the "API-Sports proxy" field on the Admin tab of matchday-log (2).html.
//
// The API key is NOT hardcoded here on purpose — this file is meant to live in a
// public repo. Set it as a Worker secret instead, so it never appears in source:
//   wrangler secret put API_SPORTS_KEY
// or via the Cloudflare dashboard: Worker -> Settings -> Variables and Secrets ->
// add "API_SPORTS_KEY" as an encrypted secret.
const UPSTREAM = "https://v3.football.api-sports.io";

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

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: { "x-apisports-key": env.API_SPORTS_KEY },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy could not reach API-Sports: " + err.message }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const body = await upstreamResponse.text();
    return new Response(body, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
};
