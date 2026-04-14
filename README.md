# proxy-fw

OpenAI-compatible proxy server that routes requests to [Fireworks AI](https://fireworks.ai), with model allowlisting and API key authentication.

Only the following models are permitted:

| Model ID | Name | Context | Input |
|---|---|---|---|
| `accounts/fireworks/routers/glm-5p1-fast` | GLM 5 fast | 256K | text |
| `accounts/fireworks/routers/kimi-k2p5-turbo` | Kimi K2.5 | 256K | text, image |
| `accounts/fireworks/routers/minimax-m2p7` | MiniMax M2.7 | 256K | text |

## Setup

```bash
cp .env.example .env
# Edit .env:
#   FIREWORKS_API_KEY  – your real Fireworks key (kept secret from users)
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

The proxy validates the key, then swaps it for the real Fireworks key on the upstream call. Users never see the Fireworks key.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | No | Health check |
| `GET` | `/v1/models` | Yes | List allowed models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Yes | Chat completions (proxied) |
| `POST` | `/v1/completions` | Yes | Text completions (proxied) |
| `POST` | `/v1/embeddings` | Yes | Embeddings (proxied) |

All `POST /v1/*` requests are transparently proxied to Fireworks after authentication and model validation. Streaming, tools, images, and all other OpenAI features are fully supported since the request body is passed through unmodified.

## Usage

Point any OpenAI-compatible client at the proxy. The user's `apiKey` is one of the `PROXY_API_KEYS` values:

**Docker (port 13312):**
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:13312/v1",
  apiKey: "key-abc123", // one of the proxy keys, NOT the Fireworks key
});
```

**Local/dev (port 3000):**
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "key-abc123", // one of the proxy keys, NOT the Fireworks key
});

const response = await client.chat.completions.create({
  model: "accounts/fireworks/routers/kimi-k2p5-turbo",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Error Responses

- **401** — Missing or invalid proxy API key
- **400** — Missing `model` field, or image input sent to a text-only model
- **403** — Model not in the allowed list
- **404** — Unknown route
- **401/5xx** — Proxied from Fireworks (server errors, etc.)
