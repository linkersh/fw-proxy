# proxy-fw

OpenAI-compatible proxy server that routes requests to multiple LLM providers with unified model naming, model allowlisting, and API key authentication.

## Providers

The proxy supports multiple providers:

| Provider | Base URL | Env Variable |
|---|---|---|
| Fireworks | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` |
| MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |

## Unified Model Naming

Models use a unified naming format: `{provider}/{model_name}`

| Unified ID | Name | Context | Input | Provider Internal ID |
|---|---|---|---|---|
| `fireworks/glm-5` | GLM 5 | 256K | text | `accounts/fireworks/routers/glm-5-fast` |
| `fireworks/kimi-k2.5` | Kimi K2.5 | 256K | text, image | `accounts/fireworks/routers/kimi-k2p5-turbo` |
| `minimax/MiniMax-M2.7` | MiniMax M2.7 | 64K | text | `MiniMax-M2.7` |

Clients use the unified ID (e.g., `fireworks/glm-5`). The proxy automatically routes to the correct provider and translates to the provider's internal model ID.

## Backwards Compatibility

Older clients can still use Fireworks internal IDs directly. The following legacy IDs are supported:

| Legacy ID (still works) | Maps to Unified ID |
|---|---|
| `accounts/fireworks/routers/glm-5-fast` | `fireworks/glm-5` |
| `accounts/fireworks/routers/kimi-k2p5-turbo` | `fireworks/kimi-k2.5` |

These legacy IDs are automatically translated and routed correctly.

## Setup

```bash
cp .env.example .env
# Edit .env:
#   FIREWORKS_API_KEY  – your Fireworks API key
#   MINIMAX_API_KEY    – your MiniMax API key
#   PROXY_API_KEYS     – comma-separated list of keys to give to proxy users
```

## Run

```bash
bun run dev             # development (watch mode)
bun run start           # production (port 3000)
docker compose up -d    # Docker (port 13312)
```

## Authentication

All endpoints (except `/health`) require a valid proxy API key via the `Authorization: Bearer <key>` header — the same way the OpenAI SDK works. Give each user one of the keys from `PROXY_API_KEYS`.

The proxy validates the key, then swaps it for the real provider key on the upstream call. Users never see the provider keys.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health dashboard |
| `GET` | `/v1/models` | Yes | List allowed models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Yes | Chat completions (proxied) |
| `POST` | `/v1/completions` | Yes | Text completions (proxied) |
| `POST` | `/v1/embeddings` | Yes | Embeddings (proxied) |

All `POST /v1/*` requests are transparently proxied to the appropriate provider after authentication and model validation. Streaming, tools, images, and all other OpenAI features are fully supported since the request body is passed through with the model ID translated.

## Usage

Point any OpenAI-compatible client at the proxy. The user's `apiKey` is one of the `PROXY_API_KEYS` values:

**Docker (port 13312):**
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:13312/v1",
  apiKey: "key-abc123", // one of the proxy keys, NOT the provider keys
});
```

**Local/dev (port 3000):**
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "key-abc123", // one of the proxy keys, NOT the provider keys
});

// Use unified model names
const response = await client.chat.completions.create({
  model: "fireworks/kimi-k2.5",
  messages: [{ role: "user", content: "Hello!" }],
});

// Or use MiniMax
const response2 = await client.chat.completions.create({
  model: "minimax/MiniMax-M2.7",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Error Responses

- **401** — Missing or invalid proxy API key
- **400** — Missing `model` field, or image input sent to a text-only model
- **403** — Model not in the allowed list
- **404** — Unknown route
- **401/5xx** — Proxied from provider (server errors, etc.)
