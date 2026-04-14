// Allowed models on this proxy
export const ALLOWED_MODELS = [
  {
    id: "accounts/fireworks/routers/glm-5-fast",
    name: "GLM 5",
    contextWindow: 256000,
    input: ["text"],
  },
  {
    id: "accounts/fireworks/routers/kimi-k2p5-turbo",
    name: "Kimi K2.5",
    contextWindow: 256000,
    input: ["text", "image"],
  },
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const ALLOWED_MODEL_IDS = new Set(ALLOWED_MODELS.map((m) => m.id));
