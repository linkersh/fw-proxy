import { Database } from "bun:sqlite";
import {
  ALLOWED_MODELS,
  ALLOWED_MODEL_IDS,
  PROVIDERS,
  getModel,
  getProviderConfig,
  ProviderName,
  ModelDefinition,
} from "./models";

// Validate provider API keys
const API_KEYS: Record<ProviderName, string | undefined> = {
  fireworks: process.env.FIREWORKS_API_KEY,
  minimax: process.env.MINIMAX_API_KEY,
};

const missingKeys = Object.entries(API_KEYS)
  .filter(([, key]) => !key)
  .map(([provider]) => provider);

if (missingKeys.length > 0) {
  console.error(`❌ Missing API keys in .env: ${missingKeys.map((p) => `${p.toUpperCase()}_API_KEY`).join(", ")}`);
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
const HEALTH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (max retention)
const DEFAULT_TIME_RANGE_MS = 30 * 60 * 1000; // 30 minutes default view

// Time range presets: label -> milliseconds
const TIME_RANGES: Record<string, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function parseTimeRange(param: string | null): number {
  if (!param || !TIME_RANGES[param]) return DEFAULT_TIME_RANGE_MS;
  return TIME_RANGES[param];
}

function getChartBuckets(rangeMs: number): number {
  // Scale buckets: fewer for shorter ranges, capped at 168 for 7 days
  if (rangeMs <= 30 * 60 * 1000) return 30;      // 30min -> 30 buckets (1min each)
  if (rangeMs <= 60 * 60 * 1000) return 60;     // 1h -> 60 buckets (1min each)
  if (rangeMs <= 6 * 60 * 60 * 1000) return 72;  // 6h -> 72 buckets (5min each)
  if (rangeMs <= 24 * 60 * 60 * 1000) return 96; // 24h -> 96 buckets (15min each)
  if (rangeMs <= 3 * 24 * 60 * 60 * 1000) return 72; // 3d -> 72 buckets (1h each)
  return 168; // 7d -> 168 buckets (1h each)
}
const HEALTH_MODEL_IDS = new Set([
  "fireworks/glm-5",
  "fireworks/kimi-k2.5",
]);

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
    tps REAL,
    error TEXT,
    checked_at INTEGER NOT NULL
  )
`);
db.exec(`DELETE FROM health_checks WHERE checked_at < (unixepoch('now') * 1000 - ${HEALTH_RETENTION_MS})`);

const stmtInsert = db.prepare(
  "INSERT INTO health_checks (model, status, latency_ms, ttft_ms, tps, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
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
  tps: number | null;
  error: string | null;
}

function getHealthModels() {
  return ALLOWED_MODELS.filter((m) => HEALTH_MODEL_IDS.has(m.id));
}

function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

async function readHealthStreamMetrics(
  body: ReadableStream<Uint8Array>,
  start: number
): Promise<{ ttft_ms: number | null; tps: number | null }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generatedText = "";
  let completionTokens: number | null = null;
  let ttft: number | null = null;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    try {
      const json = JSON.parse(payload);
      if (typeof json?.usage?.completion_tokens === "number") {
        completionTokens = json.usage.completion_tokens;
      }

      const choices = Array.isArray(json?.choices) ? json.choices : [];
      for (const choice of choices) {
        const delta = choice?.delta ?? {};
        const parts = [
          delta.content,
          delta.reasoning_content,
          choice?.text,
        ];

        for (const part of parts) {
          if (typeof part === "string" && part.length > 0) {
            if (ttft === null) ttft = Date.now() - start;
            generatedText += part;
          }
        }
      }
    } catch {
      // Ignore malformed stream lines; status and latency still get recorded.
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }

    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const tokens = completionTokens ?? estimateTokenCount(generatedText);
  const elapsedMs = ttft === null
    ? Date.now() - start
    : Date.now() - start - ttft;
  const tps = tokens > 0 && elapsedMs > 0
    ? Math.round((tokens / (elapsedMs / 1000)) * 10) / 10
    : null;

  return { ttft_ms: ttft, tps };
}

async function runHealthCheck(modelId: string): Promise<HealthResult> {
  const start = Date.now();
  const modelDef = getModel(modelId);
  
  if (!modelDef) {
    return {
      model: modelId,
      status: 0,
      latency_ms: 0,
      ttft_ms: null,
      tps: null,
      error: "Model not found in configuration",
    };
  }
  
  const provider = getProviderConfig(modelDef.provider);
  const apiKey = API_KEYS[modelDef.provider];
  
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelDef.providerModelId,
        messages: [{ role: "user", content: "Write one concise 30-word health check sentence." }],
        stream: true,
        max_tokens: 48,
        temperature: 0,
      }),
    });

    let ttft: number | null = null;
    let tps: number | null = null;

    if (res.ok && res.body) {
      const metrics = await readHealthStreamMetrics(res.body, start);
      ttft = metrics.ttft_ms;
      tps = metrics.tps;
    }

    const latency = Date.now() - start;
    const result: HealthResult = {
      model: modelId,
      status: res.status,
      latency_ms: latency,
      ttft_ms: ttft,
      tps,
      error: res.ok ? null : await res.text().catch(() => "unknown error"),
    };
    return result;
  } catch (err: any) {
    return {
      model: modelId,
      status: 0,
      latency_ms: Date.now() - start,
      ttft_ms: null,
      tps: null,
      error: err.message || "fetch failed",
    };
  }
}

function recordCheck(result: HealthResult) {
  stmtInsert.run(result.model, result.status, result.latency_ms, result.ttft_ms, result.tps, result.error, Date.now());
  // Periodically clean old records
  stmtCleanup.run();
}

async function runAllHealthChecks() {
  const models = getHealthModels();
  for (const model of models) {
    const result = await runHealthCheck(model.id);
    recordCheck(result);
    const icon = result.status === 200 ? "✅" : "❌";
    console.log(`  ${icon} ${model.id} — ${result.status} (${result.latency_ms}ms, ttft: ${result.ttft_ms ?? "n/a"}ms, tps: ${result.tps ?? "n/a"}/s)`);
  }
}

// Start the health check loop
// DISABLED: Health tracking is currently disabled
// setTimeout(() => runAllHealthChecks(), 2000); // initial after 2s
// setInterval(runAllHealthChecks, HEALTH_INTERVAL_MS);

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
): { valid: true; modelDef: ModelDefinition } | { valid: false; error: Response } {
  if (!model) {
    return {
      valid: false,
      error: openaiError(400, "Missing required field: model"),
    };
  }

  const modelDef = getModel(model);
  if (!modelDef) {
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
      // If we can't parse, just let it through to the provider and let them handle it
    }
  }

  return { valid: true, modelDef };
}

/** Rewrite the URL for the appropriate provider */
function rewriteUrl(incoming: string, provider: ProviderName): string {
  const url = new URL(incoming, "http://placeholder");
  const path = url.pathname.replace(/^\/v1/, "");
  const config = getProviderConfig(provider);
  return config.baseUrl + path;
}

// ---------- route handlers ----------

function handleModels(): Response {
  const data = {
    object: "list",
    data: ALLOWED_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.provider,
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

  const modelDef = validation.modelDef;
  const provider = getProviderConfig(modelDef.provider);
  const apiKey = API_KEYS[modelDef.provider];
  
  // Rewrite the model ID in the body to the provider-specific ID if needed
  let rewrittenBody = bodyText;
  if (model !== modelDef.providerModelId) {
    try {
      const json = JSON.parse(bodyText);
      json.model = modelDef.providerModelId;
      rewrittenBody = JSON.stringify(json);
    } catch {
      // If we can't parse, just use the original body
    }
  }
  
  const targetUrl = rewriteUrl(req.url, modelDef.provider);
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Content-Type", "application/json");
  // Only forward Accept from client — nothing else
  if (req.headers.has("Accept")) headers.set("Accept", req.headers.get("Accept")!);

  const isStream = rewrittenBody.includes('"stream":true') || rewrittenBody.includes('"stream": true');

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: rewrittenBody,
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
    // Pipe provider stream directly
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

type HistoryPoint = {
  start: number;
  end: number;
  x: number;
  count: number;
  uptimePct: number | null;
  avgLatency: number | null;
  avgTtft: number | null;
  avgTps: number | null;
};

type HistoryMetric = "avgLatency" | "avgTtft" | "avgTps";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundTo(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values: number[], decimals = 0): number | null {
  if (values.length === 0) return null;
  return roundTo(values.reduce((sum, value) => sum + value, 0) / values.length, decimals);
}

function percentile(values: number[], pct: number, decimals = 0): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * pct));
  return roundTo(sorted[index], decimals);
}

function formatMs(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function formatTps(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}/s` : "n/a";
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function formatAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return "No checks yet";
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
}

function buildHistory(rows: any[], rangeMs: number): HistoryPoint[] {
  const now = Date.now();
  const start = now - rangeMs;
  const numBuckets = getChartBuckets(rangeMs);
  const bucketMs = Math.ceil(rangeMs / numBuckets);
  const buckets = Array.from({ length: numBuckets }, () => ({
    total: 0,
    up: 0,
    latencies: [] as number[],
    ttfts: [] as number[],
    tpsValues: [] as number[],
  }));

  for (const row of rows) {
    const checkedAt = numberOrNull(row.checked_at);
    if (checkedAt === null || checkedAt < start || checkedAt > now) continue;

    const index = Math.min(
      numBuckets - 1,
      Math.max(0, Math.floor((checkedAt - start) / bucketMs))
    );
    const bucket = buckets[index];
    bucket.total += 1;

    if (row.status === 200) {
      bucket.up += 1;
      const latency = numberOrNull(row.latency_ms);
      const ttft = numberOrNull(row.ttft_ms);
      const tps = numberOrNull(row.tps);
      if (latency !== null) bucket.latencies.push(latency);
      if (ttft !== null) bucket.ttfts.push(ttft);
      if (tps !== null) bucket.tpsValues.push(tps);
    }
  }

  return buckets.map((bucket, index) => {
    const bucketStart = start + index * bucketMs;
    return {
      start: bucketStart,
      end: Math.min(now, bucketStart + bucketMs),
      x: numBuckets === 1 ? 0 : roundTo((index / (numBuckets - 1)) * 100, 2),
      count: bucket.total,
      uptimePct: bucket.total > 0 ? roundTo((bucket.up / bucket.total) * 100, 1) : null,
      avgLatency: average(bucket.latencies),
      avgTtft: average(bucket.ttfts),
      avgTps: average(bucket.tpsValues, 1),
    };
  });
}

function getStats(modelId: string, rangeMs: number) {
  const cutoff = Date.now() - rangeMs;
  const rows = db.prepare(
    "SELECT status, latency_ms, ttft_ms, tps, error, checked_at FROM health_checks WHERE model = ? AND checked_at > ? ORDER BY checked_at ASC"
  ).all(modelId, cutoff) as any[];

  if (rows.length === 0) {
    return {
      total: 0,
      up: 0,
      down: 0,
      uptimePct: 0,
      avgLatency: null,
      avgTtft: null,
      avgTps: null,
      p50Latency: null,
      p99Latency: null,
      p50Tps: null,
      p99Tps: null,
      lastCheck: null,
      latestLatency: null,
      latestTtft: null,
      latestTps: null,
      currentStatus: "unknown",
      lastError: null,
      history: buildHistory(rows, rangeMs),
    };
  }

  const successfulRows = rows.filter((r: any) => r.status === 200);
  const up = successfulRows.length;
  const down = rows.length - up;
  const latencies = successfulRows.map((r: any) => numberOrNull(r.latency_ms)).filter((v): v is number => v !== null);
  const ttfts = successfulRows.map((r: any) => numberOrNull(r.ttft_ms)).filter((v): v is number => v !== null);
  const tpsValues = successfulRows.map((r: any) => numberOrNull(r.tps)).filter((v): v is number => v !== null);
  const last = rows[rows.length - 1];
  let lastError: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].error) {
      lastError = String(rows[i].error);
      break;
    }
  }

  return {
    total: rows.length,
    up,
    down,
    uptimePct: roundTo((up / rows.length) * 100, 1),
    avgLatency: average(latencies),
    avgTtft: average(ttfts),
    avgTps: average(tpsValues, 1),
    p50Latency: percentile(latencies, 0.5),
    p99Latency: percentile(latencies, 0.99),
    p50Tps: percentile(tpsValues, 0.5, 1),
    p99Tps: percentile(tpsValues, 0.99, 1),
    lastCheck: last.checked_at,
    latestLatency: numberOrNull(last.latency_ms),
    latestTtft: numberOrNull(last.ttft_ms),
    latestTps: numberOrNull(last.tps),
    currentStatus: last.status === 200 ? "up" : "down",
    lastError,
    history: buildHistory(rows, rangeMs),
  };
}

function historyValues(history: HistoryPoint[], key: HistoryMetric): number[] {
  return history.map((point) => point[key]).filter((value): value is number => value !== null);
}

function chartPath(history: HistoryPoint[], key: HistoryMetric, maxValue: number): string {
  const points = history
    .filter((point) => typeof point[key] === "number")
    .map((point) => {
      const value = point[key] as number;
      const y = roundTo(34 - Math.min(value / maxValue, 1) * 28, 2);
      return `${point.x.toFixed(2)} ${y.toFixed(2)}`;
    });

  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]} L ${points[0]}`;
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point}`).join(" ");
}

function renderUptimeTimeline(history: HistoryPoint[], numBuckets: number): string {
  const gridCols = `repeat(${numBuckets}, minmax(2px, 1fr))`;
  return `
    <div class="status-strip" style="grid-template-columns: ${gridCols}" aria-label="Status history">
      ${history.map((point) => {
        const cls = point.count === 0
          ? "bucket-empty"
          : (point.uptimePct ?? 0) >= 99.9
            ? "bucket-ok"
            : (point.uptimePct ?? 0) > 0
              ? "bucket-mixed"
              : "bucket-down";
        const title = point.count === 0
          ? `${new Date(point.start).toLocaleString()} - no data`
          : `${new Date(point.start).toLocaleString()} - ${formatPercent(point.uptimePct)} uptime, ${point.count} checks`;
        return `<span class="history-bucket ${cls}" title="${escapeHtml(title)}"></span>`;
      }).join("")}
    </div>`;
}

function renderLineChart(
  title: string,
  detail: string,
  history: HistoryPoint[],
  series: { key: HistoryMetric; label: string; className: string }[],
  unit: "ms" | "tps"
): string {
  const values = series.flatMap((item) => historyValues(history, item.key));
  const observedMax = values.length > 0 ? Math.max(...values) : null;
  const maxValue = Math.max(observedMax ?? 0, unit === "ms" ? 100 : 1);
  const maxLabel = unit === "ms" ? formatMs(observedMax) : formatTps(observedMax);
  const hasData = values.length > 0;

  return `
    <section class="chart-block">
      <div class="chart-heading">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(detail)}</p>
        </div>
        <span>${escapeHtml(maxLabel)} peak</span>
      </div>
      ${hasData ? `
        <svg class="chart-canvas" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)} chart">
          <path class="chart-grid" d="M 0 6 H 100 M 0 18 H 100 M 0 30 H 100"></path>
          ${series.map((item) => `<path class="chart-line ${item.className}" d="${chartPath(history, item.key, maxValue)}"></path>`).join("")}
        </svg>
        <div class="legend">
          ${series.map((item) => `<span><i class="${item.className}"></i>${escapeHtml(item.label)}</span>`).join("")}
        </div>` : `
        <div class="chart-empty">Waiting for enough health checks</div>`}
    </section>`;
}

function renderMetric(label: string, value: string, detail: string, tone = ""): string {
  return `
    <div class="metric ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>`;
}

function formatRangeLabel(rangeMs: number): string {
  if (rangeMs <= 30 * 60 * 1000) return "30 minutes";
  if (rangeMs <= 60 * 60 * 1000) return "1 hour";
  if (rangeMs <= 6 * 60 * 60 * 1000) return "6 hours";
  if (rangeMs <= 24 * 60 * 60 * 1000) return "24 hours";
  if (rangeMs <= 3 * 24 * 60 * 60 * 1000) return "3 days";
  return "7 days";
}

function getBucketLabel(rangeMs: number): string {
  if (rangeMs <= 30 * 60 * 1000) return "1-minute buckets";
  if (rangeMs <= 60 * 60 * 1000) return "1-minute buckets";
  if (rangeMs <= 6 * 60 * 60 * 1000) return "5-minute buckets";
  if (rangeMs <= 24 * 60 * 60 * 1000) return "15-minute buckets";
  if (rangeMs <= 3 * 24 * 60 * 60 * 1000) return "1-hour buckets";
  return "1-hour buckets";
}

function renderModelPanel(model: any, rangeMs: number, numBuckets: number): string {
  const s = model.stats;
  const rangeLabel = formatRangeLabel(rangeMs);
  const bucketLabel = getBucketLabel(rangeMs);
  const latencyChart = renderLineChart(
    "Latency & TTFT",
    `Averages over the last ${rangeLabel}.`,
    s.history,
    [
      { key: "avgLatency", label: "Latency", className: "line-latency" },
      { key: "avgTtft", label: "TTFT", className: "line-ttft" },
    ],
    "ms"
  );
  const tpsChart = renderLineChart(
    "Throughput",
    "Tokens per second from health prompts.",
    s.history,
    [{ key: "avgTps", label: "TPS", className: "line-tps" }],
    "tps"
  );
  const statusLabel = s.currentStatus === "up" ? "Up" : s.currentStatus === "down" ? "Down" : "Unknown";
  const statusMeta = s.lastCheck ? `Last check ${formatAgo(s.lastCheck)}` : "Waiting for first check";
  const uptimeTone = s.currentStatus === "up" ? "metric-good" : s.currentStatus === "down" ? "metric-bad" : "";
  const errorText = s.lastError ?? "None in current window";

  return `
    <article class="model-panel status-${s.currentStatus}">
      <div class="model-header">
        <div class="model-heading">
          <span class="status-dot" aria-hidden="true"></span>
          <div>
            <h2>${escapeHtml(model.name)}</h2>
            <p class="model-id">${escapeHtml(model.id)}</p>
            <div class="model-meta">
              <span class="chip">${Math.round(model.contextWindow / 1000)}k context</span>
              <span class="chip">${escapeHtml(model.input.join(" + "))}</span>
              <span class="chip">60s cadence</span>
            </div>
          </div>
        </div>
        <div class="status-summary">
          <span class="badge badge-${s.currentStatus}">${escapeHtml(statusLabel)}</span>
          <small>${escapeHtml(statusMeta)}</small>
        </div>
      </div>

      <div class="metrics">
        ${renderMetric("Uptime", formatPercent(s.uptimePct), `${s.up}/${s.total} checks succeeded`, uptimeTone)}
        ${renderMetric("Avg latency", formatMs(s.avgLatency), `p50 ${formatMs(s.p50Latency)} / p99 ${formatMs(s.p99Latency)}`)}
        ${renderMetric("Avg TTFT", formatMs(s.avgTtft), `latest ${formatMs(s.latestTtft)}`)}
        ${renderMetric("Avg TPS", formatTps(s.avgTps), `p50 ${formatTps(s.p50Tps)} / p99 ${formatTps(s.p99Tps)}`, s.avgTps !== null ? "metric-good" : "")}
        ${renderMetric("Failures", String(s.down), `latest latency ${formatMs(s.latestLatency)}`, s.down > 0 ? "metric-bad" : "")}
      </div>

      <div class="history-row">
        <div class="section-heading">
          <div>
            <h3>Status history</h3>
            <p>${rangeLabel} window with ${bucketLabel}.</p>
          </div>
          <span>${s.history.filter((point: HistoryPoint) => point.count > 0).length}/${numBuckets} buckets</span>
        </div>
        ${renderUptimeTimeline(s.history, numBuckets)}
      </div>

      <div class="charts">
        ${latencyChart}
        ${tpsChart}
      </div>

      <p class="error-note ${s.lastError ? "" : "ok-note"}"><span>Latest error</span>${escapeHtml(errorText)}</p>
    </article>`;
}

function renderHealthPage(rangeParam: string | null): Response {
  const rangeMs = parseTimeRange(rangeParam);
  const numBuckets = getChartBuckets(rangeMs);
  const rangeLabel = formatRangeLabel(rangeMs);
  const models = getHealthModels();
  const stats = models.map((m) => ({ ...m, stats: getStats(m.id, rangeMs) }));
  const totalChecks = stats.reduce((sum: number, model: any) => sum + model.stats.total, 0);
  const successfulChecks = stats.reduce((sum: number, model: any) => sum + model.stats.up, 0);
  const modelsUp = stats.filter((model: any) => model.stats.currentStatus === "up").length;
  const fleetUptime = totalChecks > 0 ? roundTo((successfulChecks / totalChecks) * 100, 1) : 0;
  const fleetTpsValues = stats.map((model: any) => model.stats.avgTps).filter((value): value is number => value !== null);
  const modelPanels = stats.map((m) => renderModelPanel(m, rangeMs, numBuckets)).join("");

  // Build time range selector options
  const rangeOptions = Object.keys(TIME_RANGES).map((key) => {
    const selected = key === (rangeParam || "30m") ? " selected" : "";
    return `<option value="${key}"${selected}>${key}</option>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Multi-Provider Proxy - Status</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0b0a;
    --panel: #151513;
    --panel-soft: #1b1a17;
    --border: #2b2924;
    --border-strong: #3a362f;
    --text: #f4f0e8;
    --muted: #a8a096;
    --faint: #746f66;
    --green: #7bd88f;
    --green-dim: #203226;
    --red: #ff6f61;
    --red-dim: #3a201d;
    --amber: #d6a84f;
    --amber-dim: #342a16;
    --empty: #24231f;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    background:
      radial-gradient(circle at 18% 0%, rgba(123, 216, 143, 0.07), transparent 28rem),
      linear-gradient(180deg, #10100e 0%, var(--bg) 34rem);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .shell { max-width: 1400px; margin: 0 auto; padding: 20px 20px 32px; }
  .topbar { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .eyebrow { color: var(--muted); font-size: 0.78rem; margin-bottom: 8px; }
  h1 { font-size: 2rem; line-height: 1.1; font-weight: 720; letter-spacing: 0; }
  .subtitle { color: var(--muted); margin-top: 10px; max-width: 760px; line-height: 1.5; font-size: 0.96rem; }
  .refresh { color: var(--muted); text-align: right; min-width: 220px; font-size: 0.82rem; line-height: 1.45; }
  .refresh strong { display: block; color: var(--text); margin-top: 6px; font-size: 0.9rem; font-weight: 650; }
  .range-select { background: var(--panel-soft); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 6px; font-size: 0.8rem; margin-left: 8px; cursor: pointer; }
  .range-select:hover { border-color: var(--border-strong); }
  .overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 16px 0; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .overview-item { background: rgba(21, 21, 19, 0.94); padding: 14px 16px; min-width: 0; }
  .overview-item span { display: block; color: var(--muted); font-size: 0.78rem; margin-bottom: 10px; }
  .overview-item strong { display: block; color: var(--text); font-size: 1.55rem; line-height: 1.05; }
  .overview-item small { display: block; color: var(--faint); margin-top: 9px; line-height: 1.35; }
  .model-stack { display: grid; grid-template-columns: repeat(auto-fit, minmax(600px, 1fr)); gap: 16px; }
  @media (min-width: 1400px) { .model-stack { grid-template-columns: repeat(2, 1fr); } }
  .model-panel { background: rgba(21, 21, 19, 0.96); border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; }
  .model-panel.status-up { border-color: rgba(123, 216, 143, 0.34); }
  .model-panel.status-down { border-color: rgba(255, 111, 97, 0.44); }
  .model-header { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .model-heading { display: flex; gap: 12px; min-width: 0; }
  .status-dot { width: 10px; height: 10px; border-radius: 5px; margin-top: 9px; flex: 0 0 auto; background: var(--faint); box-shadow: 0 0 0 4px rgba(116, 111, 102, 0.16); }
  .status-up .status-dot { background: var(--green); box-shadow: 0 0 0 4px rgba(123, 216, 143, 0.13); }
  .status-down .status-dot { background: var(--red); box-shadow: 0 0 0 4px rgba(255, 111, 97, 0.14); }
  h2 { font-size: 1.1rem; line-height: 1.2; letter-spacing: 0; }
  .model-id { color: var(--muted); margin-top: 4px; font-size: 0.75rem; overflow-wrap: anywhere; }
  .model-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { border: 1px solid var(--border); background: var(--panel-soft); color: var(--muted); border-radius: 4px; padding: 2px 6px; font-size: 0.7rem; }
  .status-summary { text-align: right; flex: 0 0 auto; }
  .badge { display: inline-flex; align-items: center; border: 1px solid var(--border-strong); border-radius: 6px; padding: 6px 10px; font-size: 0.8rem; font-weight: 700; background: var(--panel-soft); }
  .badge-up { color: var(--green); border-color: rgba(123, 216, 143, 0.38); background: var(--green-dim); }
  .badge-down { color: var(--red); border-color: rgba(255, 111, 97, 0.42); background: var(--red-dim); }
  .badge-unknown { color: var(--muted); }
  .status-summary small { display: block; color: var(--muted); margin-top: 8px; font-size: 0.78rem; }
  .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  .metric { min-width: 0; padding: 10px 10px 10px 0; border-right: 1px solid var(--border); }
  .metric:last-child { border-right: 0; padding-right: 0; }
  .metric span { display: block; color: var(--muted); font-size: 0.7rem; margin-bottom: 4px; }
  .metric strong { display: block; color: var(--text); font-size: 1.1rem; line-height: 1.08; font-weight: 720; overflow-wrap: anywhere; }
  .metric small { display: block; color: var(--faint); margin-top: 4px; line-height: 1.3; font-size: 0.7rem; }
  .metric-good strong { color: var(--green); }
  .metric-bad strong { color: var(--red); }
  .history-row { padding: 10px 0; border-bottom: 1px solid var(--border); flex: 1; }
  .section-heading, .chart-heading { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
  .section-heading h3, .chart-heading h3 { font-size: 0.85rem; line-height: 1.2; letter-spacing: 0; }
  .section-heading p, .chart-heading p { color: var(--muted); margin-top: 2px; line-height: 1.4; font-size: 0.75rem; }
  .section-heading span, .chart-heading span { color: var(--faint); font-size: 0.78rem; white-space: nowrap; }
  .status-strip { display: grid; gap: 2px; height: 24px; margin-top: 8px; }
  .history-bucket { border-radius: 2px; min-width: 2px; transition: opacity 0.15s ease; }
  .history-bucket:hover { opacity: 0.7; }
  .bucket-empty { background: var(--empty); }
  .bucket-ok { background: var(--green); }
  .bucket-mixed { background: var(--amber); }
  .bucket-down { background: var(--red); }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 12px; }
  .chart-block { min-width: 0; }
  .chart-canvas, .chart-empty { width: 100%; height: 100px; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: linear-gradient(180deg, rgba(244, 240, 232, 0.025), rgba(244, 240, 232, 0.008)); }
  .chart-empty { display: grid; place-items: center; color: var(--muted); font-size: 0.8rem; }
  .chart-grid { stroke: var(--border-strong); stroke-width: 0.35; fill: none; vector-effect: non-scaling-stroke; }
  .chart-line { fill: none; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .line-latency { stroke: var(--text); }
  .line-ttft { stroke: var(--amber); }
  .line-tps { stroke: var(--green); }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); margin-top: 10px; font-size: 0.78rem; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 8px; height: 8px; border-radius: 4px; display: inline-block; }
  .legend .line-latency { background: var(--text); }
  .legend .line-ttft { background: var(--amber); }
  .legend .line-tps { background: var(--green); }
  .error-note { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--red); font-size: 0.8rem; line-height: 1.4; overflow-wrap: anywhere; }
  .error-note span { color: var(--muted); margin-right: 8px; }
  .ok-note { color: var(--muted); }
  .footer { text-align: center; color: var(--faint); font-size: 0.78rem; margin-top: 24px; }
  @media (max-width: 1200px) {
    .model-stack { grid-template-columns: 1fr; }
    .charts { grid-template-columns: 1fr; }
  }
  @media (max-width: 980px) {
    .topbar, .model-header, .section-heading, .chart-heading { flex-direction: column; }
    .refresh, .status-summary { text-align: left; min-width: 0; }
    .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric { border-right: 0; border-bottom: 1px solid var(--border); padding-right: 10px; }
    .metric:nth-child(3n) { border-right: 0; }
    .metric:last-child { border-bottom: 0; }
    .charts { grid-template-columns: 1fr; }
  }
  @media (max-width: 620px) {
    .shell { padding: 24px 14px 34px; }
    h1 { font-size: 1.58rem; }
    .overview { grid-template-columns: 1fr; }
    .metrics { grid-template-columns: 1fr; }
    .status-strip { gap: 1px; }
  }
</style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div>
      <p class="eyebrow">Multi-Provider Proxy</p>
      <h1>Model health</h1>
      <p class="subtitle">Tracking ${stats.length} models from ${Object.keys(PROVIDERS).length} providers every 60 seconds. Showing ${rangeLabel} of metrics with dynamic buckets.</p>
    </div>
    <div class="refresh">Auto-refresh 60s <select id="range" class="range-select">${rangeOptions}</select><strong>${new Date().toLocaleString()}</strong></div>
  </header>

  <section class="overview" aria-label="Fleet overview">
    <div class="overview-item"><span>Models up</span><strong>${modelsUp}/${stats.length}</strong><small>Current status from the latest check per model</small></div>
    <div class="overview-item"><span>Fleet uptime</span><strong>${formatPercent(fleetUptime)}</strong><small>${successfulChecks}/${totalChecks} successful checks</small></div>
    <div class="overview-item"><span>Avg TPS</span><strong>${formatTps(fleetTpsValues.length ? average(fleetTpsValues, 1) : null)}</strong><small>Estimated from streamed health prompts</small></div>
    <div class="overview-item"><span>Window</span><strong>${rangeLabel}</strong><small>${numBuckets} buckets of aggregated data</small></div>
  </section>

  <section class="model-stack" aria-label="Model status">
    ${modelPanels}
  </section>

  <div class="footer">Window starts ${new Date(Date.now() - rangeMs).toLocaleString()} - page refreshed ${new Date().toLocaleString()}</div>
</main>
<script>
const select = document.getElementById('range');
select.addEventListener('change', (e) => {
  const url = new URL(location.href);
  url.searchParams.set('range', e.target.value);
  location.href = url.toString();
});
setTimeout(() => location.reload(), 60000);
</script>
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
      return renderHealthPage(url.searchParams.get("range"));
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
🚀 Multi-provider proxy running on http://localhost:${PORT}

   OpenAI-compatible endpoints:
     POST /v1/chat/completions
     POST /v1/completions
     POST /v1/embeddings
     GET  /v1/models

   Dashboard: http://localhost:${PORT}/health

   Authentication: Bearer <proxy-api-key> (${PROXY_KEYS.size} key(s) configured)

   Providers configured:
${Object.entries(PROVIDERS).map(([name, config]) => `     • ${name} (${config.baseUrl})`).join("\n")}

   Allowed models (format: provider/model-name):
${ALLOWED_MODELS.map((m) => `     • ${m.id} (${m.name}) [${m.input.join(", ")}]`).join("\n")}
`);
