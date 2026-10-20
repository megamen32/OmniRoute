import type { RegistryEntry } from "../../shared.ts";

/**
 * Models exposed by the local MiniMax Code CLI. The ids are the runtime's own
 * model ids: the run requests them as `minimax/<model id>`.
 */
export const MINIMAX_CODE_MODELS = [
  {
    id: "MiniMax-M3.1-Flash",
    name: "MiniMax M3.1 Flash",
    contextLength: 1048576,
    supportsVision: true,
  },
  { id: "MiniMax-M3", name: "MiniMax M3", contextLength: 512000, supportsVision: true },
];

/**
 * Local MiniMax Code backend. Authentication remains in the user's local
 * MiniMax Code profile; OmniRoute does not receive or persist the credential.
 */
export const minimaxCodeProvider: RegistryEntry = {
  id: "minimax-code",
  alias: "mmcode",
  format: "openai",
  executor: "minimax-code",
  baseUrl: "minimax-code://cli/exec",
  authType: "none",
  authHeader: "none",
  models: MINIMAX_CODE_MODELS,
};
