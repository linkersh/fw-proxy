// Allowed models on this proxy
export const ALLOWED_MODELS = [
  {
    id: "accounts/fireworks/routers/glm-5p1-fast",
    name: "GLM 5 fast",
    contextWindow: 256000,
    input: ["text"],
  },
  {
    id: "accounts/fireworks/routers/kimi-k2p5-turbo",
    name: "Kimi K2.5",
    contextWindow: 256000,
    input: ["text", "image"],
  },
  {
    id: "accounts/fireworks/routers/minimax-m2p7",
    name: "MiniMax M2.7",
    contextWindow: 256000,
    input: ["text"],
  },
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const ALLOWED_MODEL_IDS = new Set(ALLOWED_MODELS.map((m) => m.id));
