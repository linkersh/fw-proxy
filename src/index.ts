import { Database } from "bun:sqlite";
import { ALLOWED_MODELS, ALLOWED_MODEL_IDS } from "./models";

const FIREWORKS_BASE = "https://api.fireworks.ai/inference/v1";
const API_KEY = process.env.FIREWORKS_API_KEY;

if (!API_KEY) {
  console.error("❌ FIREWORKS_API_KEY not set in .env");
  process.exit(1);
}

// Proxy API keys – comma-separated list in .env
// Clients must send one of these as Authorization: Bearer <proxy-key>
const PROXY_KEYS = new Set(
  (process.env.PROXY_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
);

if (PROXY_KEYS.size === 0) {
  console.error("❌ PROXY_API_KEYS not set in .env (comma-separated list of client keys)");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");
const HEALTH_INTERVAL_MS = 60_000; // 1 minute
const HEALTH_RETENTION_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------- database ----------

const db = new Database("health.db", { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    ttft_ms INTEGER,
    error TEXT,
    checked_at INTEGER NOT NULL
  )
`);
db.exec(`DELETE FROM health_checks WHERE checked_at < (unixepoch('now') * 1000 - ${HEALTH_RETENTION_MS})`);

const stmtInsert = db.prepare(
  "INSERT INTO health_checks (model, status, latency_ms, ttft_ms, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)"
);
const stmtCleanup = db.prepare(
  `DELETE FROM health_checks WHERE checked_at < (unixepoch('now') * 1000 - ${HEALTH_RETENTION_MS})`
);

// ---------- health checker ----------

interface HealthResult {
  model: string;
  status: number;
  latency_ms: number;
  ttft_ms: number | null;
  error: string | null;
}

async function runHealthCheck(model: string): Promise<HealthResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${FIREWORKS_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "say hello" }],
        stream: true,
        max_tokens: 5,
      }),
    });

    let ttft: number | null = null;

    if (res.ok && res.body) {
      // Read first chunk to measure time to first token
      const reader = res.body.getReader();
      const { value } = await reader.read();
      if (value) ttft = Date.now() - start;
      // Drain the rest
      try { await reader.cancel(); } catch {}
    }

    const latency = Date.now() - start;
    const result: HealthResult = {
      model,
      status: res.status,
      latency_ms: latency,
      ttft_ms: ttft,
      error: res.ok ? null : await res.text().catch(() => "unknown error"),
    };
    return result;
  } catch (err: any) {
    return {
      model,
      status: 0,
      latency_ms: Date.now() - start,
      ttft_ms: null,
      error: err.message || "fetch failed",
    };
  }
}

function recordCheck(result: HealthResult) {
  stmtInsert.run(result.model, result.status, result.latency_ms, result.ttft_ms, result.error, Date.now());
  // Periodically clean old records
  stmtCleanup.run();
}

async function runAllHealthChecks() {
  const models = ALLOWED_MODELS.filter((m) => m.id !== "accounts/fireworks/routers/glm-5-fast");
  for (const model of models) {
    const result = await runHealthCheck(model.id);
    recordCheck(result);
    const icon = result.status === 200 ? "✅" : "❌";
    console.log(`  ${icon} ${model.id} — ${result.status} (${result.latency_ms}ms, ttft: ${result.ttft_ms ?? "n/a"}ms)`);
  }
}

// Start the health check loop
setTimeout(() => runAllHealthChecks(), 2000); // initial after 2s
setInterval(runAllHealthChecks, HEALTH_INTERVAL_MS);

// ---------- auth ----------

/** Extract Bearer token from Authorization header */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Validate the proxy API key; returns an error response or null */
function authenticateProxy(req: Request): Response | null {
  const token = extractBearerToken(req);
  if (!token) {
    return openaiError(401, "Missing Authorization header. Provide Bearer <proxy-api-key>.", "authentication_error");
  }
  if (!PROXY_KEYS.has(token)) {
    return openaiError(401, "Invalid API key.", "authentication_error");
  }
  return null; // valid
}

// ---------- helpers ----------

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openaiError(
  status: number,
  message: string,
  type = "invalid_request_error"
): Response {
  return jsonResponse(status, {
    error: { message, type, code: null },
  });
}

/** Extract the `model` field from a JSON body without fully parsing */
function extractModel(body: string): string | null {
  try {
    const json = JSON.parse(body);
    return json?.model ?? null;
  } catch {
    return null;
  }
}

/** Validate model & image support for the request */
function validateModel(
  model: string | null,
  body: string
): { valid: true } | { valid: false; error: Response } {
  if (!model) {
    return {
      valid: false,
      error: openaiError(400, "Missing required field: model"),
    };
  }

  if (!ALLOWED_MODEL_IDS.has(model)) {
    return {
      valid: false,
      error: openaiError(
        403,
        `Model '${model}' is not allowed. Allowed models: ${[...ALLOWED_MODEL_IDS].join(", ")}`
      ),
    };
  }

  // Check image support: if the model doesn't support images but the request
  // contains image_url content parts, reject it
  const modelDef = ALLOWED_MODELS.find((m) => m.id === model)!;
  if (!modelDef.input.includes("image")) {
    try {
      const json = JSON.parse(body);
      const messages: any[] = json.messages ?? [];
      for (const msg of messages) {
        const content =
          typeof msg.content === "string" ? [msg.content] : msg.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === "image_url") {
              return {
                valid: false,
                error: openaiError(
                  400,
                  `Model '${model}' does not support image inputs. Use a model that supports images.`
                ),
              };
            }
          }
        }
      }
    } catch {
      // If we can't parse, just let it through to Fireworks and let them handle it
    }
  }

  return { valid: true };
}

/** Rewrite the URL: strip /v1 prefix and all query params */
function rewriteUrl(incoming: string): string {
  const url = new URL(incoming, "http://placeholder");
  const path = url.pathname.replace(/^\/v1/, "");
  return FIREWORKS_BASE + path;
}

// ---------- route handlers ----------

function handleModels(): Response {
  const data = {
    object: "list",
    data: ALLOWED_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "fireworks",
      permission: [],
      root: m.id,
      parent: null,
    })),
  };
  return jsonResponse(200, data);
}

/** Proxy a request that carries a JSON body (chat completions, embeddings, etc.) */
async function proxyWithBody(req: Request): Promise<Response> {
  const bodyText = await req.text();
  const model = extractModel(bodyText);
  const validation = validateModel(model, bodyText);

  if (!validation.valid) return validation.error;

  const targetUrl = rewriteUrl(req.url);
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${API_KEY}`);
  headers.set("Content-Type", "application/json");
  // Only forward Accept from client — nothing else
  if (req.headers.has("Accept")) headers.set("Accept", req.headers.get("Accept")!);

  const isStream = bodyText.includes('"stream":true') || bodyText.includes('"stream": true');

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: bodyText,
  });

  if (!upstream.ok && !isStream) {
    // Surface the upstream error with clean headers
    const errBody = await upstream.text();
    return new Response(errBody, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "x-request-id": crypto.randomUUID(),
      },
    });
  }

  // Build clean response headers — only what OpenAI clients expect
  const cleanHeaders = new Headers();
  cleanHeaders.set("x-request-id", crypto.randomUUID());

  if (isStream && upstream.body) {
    cleanHeaders.set("Content-Type", "text/event-stream");
    cleanHeaders.set("Cache-Control", "no-cache");
    // Pipe Fireworks stream directly — they already put reasoning_content in delta
    return new Response(upstream.body, {
      status: upstream.status,
      headers: cleanHeaders,
    });
  }

  // Non-streaming: move reasoning fields into the message object for consistency
  const ct = upstream.headers.get("Content-Type");
  if (ct) cleanHeaders.set("Content-Type", ct);
  const cl = upstream.headers.get("Content-Length");
  if (cl) cleanHeaders.set("Content-Length", cl);

  const responseBody = await upstream.text();
  try {
    const json = JSON.parse(responseBody);
    const choices = json.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const msg = choice.message;
        if (msg && msg.reasoning_content == null) {
          // Some models put reasoning at choice-level — move it into message
          for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
            if (choice[field] != null) {
              msg[field] = choice[field];
              delete choice[field];
            }
          }
        }
      }
    }
    cleanHeaders.delete("Content-Length"); // body size changed
    return new Response(JSON.stringify(json), { status: upstream.status, headers: cleanHeaders });
  } catch {
    return new Response(responseBody, { status: upstream.status, headers: cleanHeaders });
  }
}

// ---------- health dashboard ----------

function getStats(modelId: string) {
  const cutoff = Date.now() - HEALTH_RETENTION_MS;
  const rows = db.prepare(
    "SELECT status, latency_ms, ttft_ms, error, checked_at FROM health_checks WHERE model = ? AND checked_at > ? ORDER BY checked_at ASC"
  ).all(modelId, cutoff) as any[];

  if (rows.length === 0) {
    return { total: 0, up: 0, down: 0, uptimePct: 0, avgLatency: 0, avgTtft: 0, p50Latency: 0, p99Latency: 0, lastCheck: null, currentStatus: "unknown", checks: [] };
  }

  const up = rows.filter((r: any) => r.status === 200).length;
  const down = rows.length - up;
  const latencies = rows.filter((r: any) => r.status === 200).map((r: any) => r.latency_ms);
  const ttfts = rows.filter((r: any) => r.ttft_ms != null).map((r: any) => r.ttft_ms);

  const sorted = [...latencies].sort((a: number, b: number) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;

  return {
    total: rows.length,
    up,
    down,
    uptimePct: Math.round((up / rows.length) * 1000) / 10,
    avgLatency: latencies.length ? Math.round(latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length) : 0,
    avgTtft: ttfts.length ? Math.round(ttfts.reduce((a: number, b: number) => a + b, 0) / ttfts.length) : 0,
    p50Latency: p50,
    p99Latency: p99,
    lastCheck: rows[rows.length - 1].checked_at,
    currentStatus: rows[rows.length - 1].status === 200 ? "up" : "down",
    checks: rows.map((r: any) => ({
      status: r.status,
      latency_ms: r.latency_ms,
      ttft_ms: r.ttft_ms,
      error: r.error,
      checked_at: r.checked_at,
    })),
  };
}

function renderHealthPage(): Response {
  const models = ALLOWED_MODELS.filter((m) => m.id !== "accounts/fireworks/routers/glm-5-fast");
  const stats = models.map((m) => ({ ...m, stats: getStats(m.id) }));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fireworks Proxy — Status</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --green: #3fb950; --red: #f85149; --yellow: #d29922; --blue: #58a6ff; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 24px; min-height: 100vh; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .model-name { font-weight: 600; font-size: 1rem; }
  .badge { padding: 3px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge-up { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-down { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-unknown { background: rgba(139,148,158,0.15); color: var(--muted); }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
  .stat { text-align: center; }
  .stat-value { font-size: 1.3rem; font-weight: 700; }
  .stat-label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-green { color: var(--green); }
  .stat-red { color: var(--red); }
  .stat-blue { color: var(--blue); }
  .timeline { display: flex; gap: 2px; height: 32px; align-items: flex-end; border-radius: 4px; overflow: hidden; }
  .tick { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; transition: opacity 0.15s; }
  .tick:hover { opacity: 0.7; }
  .tick-ok { background: var(--green); }
  .tick-err { background: var(--red); }
  .tick-title { font-size: 0.65rem; color: var(--muted); text-align: center; margin-top: 4px; }
  .uptime-bar { height: 6px; background: var(--border); border-radius: 3px; margin-bottom: 16px; overflow: hidden; }
  .uptime-fill { height: 100%; border-radius: 3px; background: var(--green); transition: width 0.3s; }
  .footer { text-align: center; color: var(--muted); font-size: 0.75rem; margin-top: 32px; }
</style>
</head>
<body>
<h1>🔥 Fireworks Proxy</h1>
<p class="subtitle">Model health monitor — checking every 60s, 6h history</p>
<div class="grid">
${stats.map((m: any) => {
  const s = m.stats;
  const barWidth = s.total > 0 ? s.uptimePct : 0;
  const maxLat = Math.max(...s.checks.map((c: any) => c.latency_ms), 1);
  return `
  <div class="card">
    <div class="card-header">
      <span class="model-name">${m.name}</span>
      <span class="badge badge-${s.currentStatus}">${s.currentStatus === "up" ? "● UP" : s.currentStatus === "down" ? "● DOWN" : "○ UNKNOWN"}</span>
    </div>
    <div class="uptime-bar"><div class="uptime-fill" style="width:${barWidth}%"></div></div>
    <div class="stats">
      <div class="stat"><div class="stat-value stat-green">${s.uptimePct}%</div><div class="stat-label">Uptime</div></div>
      <div class="stat"><div class="stat-value stat-blue">${s.avgLatency}ms</div><div class="stat-label">Avg Latency</div></div>
      <div class="stat"><div class="stat-value stat-blue">${s.avgTtft}ms</div><div class="stat-label">Avg TTFT</div></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${s.p50Latency}ms</div><div class="stat-label">p50 Latency</div></div>
      <div class="stat"><div class="stat-value">${s.p99Latency}ms</div><div class="stat-label">p99 Latency</div></div>
      <div class="stat"><div class="stat-value">${s.up}/${s.total}</div><div class="stat-label">Checks OK</div></div>
    </div>
    <div class="timeline">
      ${s.checks.map((c: any) => {
        const h = Math.max(4, Math.round((c.latency_ms / maxLat) * 32));
        const cls = c.status === 200 ? "tick-ok" : "tick-err";
        const time = new Date(c.checked_at).toLocaleTimeString();
        return `<div class="tick ${cls}" style="height:${h}px" title="${time} — ${c.status} (${c.latency_ms}ms, ttft: ${c.ttft_ms ?? 'n/a'}ms)"></div>`;
      }).join("")}
    </div>
    <div class="tick-title">last 6h (${s.checks.length} checks)</div>
  </div>`;
}).join("")}
</div>
<div class="footer">Last refresh: ${new Date().toLocaleString()} · Auto-refreshes every 60s</div>
<script>setTimeout(() => location.reload(), 60000);</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------- server ----------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health dashboard (no auth required)
    if (path === "/health") {
      return renderHealthPage();
    }

    // Everything else requires a valid proxy API key
    const authError = authenticateProxy(req);
    if (authError) return authError;

    // Only allow specific endpoints
    const ALLOWED_ENDPOINTS: Record<string, string> = {
      "/v1/models": "GET",
      "/v1/chat/completions": "POST",
      "/v1/completions": "POST",
      "/v1/embeddings": "POST",
    };

    const allowedMethod = ALLOWED_ENDPOINTS[path];
    if (!allowedMethod) {
      return openaiError(404, `Unknown route: ${path}`);
    }
    if (req.method !== allowedMethod) {
      return openaiError(405, `Method ${req.method} not allowed for ${path}. Use ${allowedMethod}.`);
    }

    // Models list – return only allowed models
    if (path === "/v1/models") {
      return handleModels();
    }

    // POST endpoints: proxy with body validation
    const clone = req.clone();
    clone.json().then((b) => console.log(`← ${req.method} ${path} model=${b.model ?? "?"}`)).catch(() => console.log(`← ${req.method} ${path}`));
    return proxyWithBody(req);
  },
});

console.log(`
🚀 Fireworks proxy running on http://localhost:${PORT}

   OpenAI-compatible endpoints:
     POST /v1/chat/completions
     POST /v1/completions
     POST /v1/embeddings
     GET  /v1/models

   Dashboard: http://localhost:${PORT}/health

   Authentication: Bearer <proxy-api-key> (${PROXY_KEYS.size} key(s) configured)

   Allowed models:
${ALLOWED_MODELS.map((m) => `     • ${m.id} (${m.name}) [${m.input.join(", ")}]`).join("\n")}
`);
