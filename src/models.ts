// Provider configuration
export const PROVIDERS = {
  fireworks: {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1",
    envKey: "MINIMAX_API_KEY",
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

// Model definition with unified naming: {provider}/{model_name}
export interface ModelDefinition {
  id: string;              // Unified ID: "provider/model_name" (e.g., "fireworks/glm-5")
  provider: ProviderName;  // Provider key
  providerModelId: string; // Actual model ID to send to provider API
  name: string;            // Human-readable name
  contextWindow: number;
  input: ("text" | "image")[];
  legacyIds?: string[];    // Backwards-compatible IDs (e.g., old Fireworks internal IDs)
}

// Allowed models on this proxy
export const ALLOWED_MODELS: ModelDefinition[] = [
  // Fireworks models
  {
    id: "fireworks/glm-5",
    provider: "fireworks",
    providerModelId: "accounts/fireworks/routers/glm-5-fast",
    name: "GLM 5",
    contextWindow: 256000,
    input: ["text"],
    legacyIds: ["accounts/fireworks/routers/glm-5-fast"],
  },
  {
    id: "fireworks/kimi-k2.5",
    provider: "fireworks",
    providerModelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
    name: "Kimi K2.5",
    contextWindow: 256000,
    input: ["text", "image"],
    legacyIds: ["accounts/fireworks/routers/kimi-k2p5-turbo"],
  },
  // MiniMax models
  {
    id: "minimax/MiniMax-M2.7",
    provider: "minimax",
    providerModelId: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    contextWindow: 64000,
    input: ["text"],
  },
];

// Build allowed IDs set including legacy IDs for backwards compatibility
export const ALLOWED_MODEL_IDS = new Set<string>();
for (const model of ALLOWED_MODELS) {
  ALLOWED_MODEL_IDS.add(model.id);
  if (model.legacyIds) {
    for (const legacyId of model.legacyIds) {
      ALLOWED_MODEL_IDS.add(legacyId);
    }
  }
}

// Helper to get model by unified ID or legacy ID
export function getModel(id: string): ModelDefinition | undefined {
  // Check unified ID first
  const model = ALLOWED_MODELS.find((m) => m.id === id);
  if (model) return model;
  
  // Check legacy IDs for backwards compatibility
  return ALLOWED_MODELS.find((m) => m.legacyIds?.includes(id));
}

// Helper to get provider config
export function getProviderConfig(provider: ProviderName) {
  return PROVIDERS[provider];
}
