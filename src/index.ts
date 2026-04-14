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
    return new Response(upstream.body, {
      status: upstream.status,
      headers: cleanHeaders,
    });
  }

  // Non-streaming
  const ct = upstream.headers.get("Content-Type");
  if (ct) cleanHeaders.set("Content-Type", ct);
  const cl = upstream.headers.get("Content-Length");
  if (cl) cleanHeaders.set("Content-Length", cl);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: cleanHeaders,
  });
}

// ---------- server ----------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check (no auth required)
    if (path === "/health") {
      return jsonResponse(200, { status: "ok" });
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

   Authentication: Bearer <proxy-api-key> (${PROXY_KEYS.size} key(s) configured)

   Allowed models:
${ALLOWED_MODELS.map((m) => `     • ${m.id} (${m.name}) [${m.input.join(", ")}]`).join("\n")}
`);
