/**
 * Protocol Firewall
 *
 * Enforces routing rules based on protocol detection.
 * Claude-specific requests MUST go to Anthropic API, never to local providers.
 */

import { isClaudeProtocol } from "./claudeDetect";

export interface FirewallResult {
  forceProvider: "anthropic" | null;
  reason?: string;
}

export interface FirewallOptions {
  strictMode?: boolean;  // If true, reject Claude requests when API key is missing
  allowedModels?: string[];  // Whitelist of models allowed for Claude protocol
}

/**
 * Get default options from environment variables
 * This is called fresh each time to ensure env var changes are picked up
 */
function getDefaultOptions(): FirewallOptions {
  return {
    strictMode: process.env.STRICT_CLAUDE === "true",
    allowedModels: process.env.CLAUDE_ALLOWED_MODELS
      ?.split(",")
      .map((m) => m.trim())
      .filter(Boolean) || [],
  };
}

/**
 * Check if a model is allowed to use Claude protocol
 */
function isModelAllowed(modelId: string, allowedModels?: string[]): boolean {
  if (!allowedModels || allowedModels.length === 0) {
    return true;  // No restrictions if whitelist is empty
  }
  return allowedModels.includes(modelId);
}

export function protocolFirewall(
  req: {
    url?: string;
    headers?: Record<string, string | undefined>;
    body?: { messages?: Array<{ content?: string | unknown }>; system?: string; model?: string };
  },
  options?: FirewallOptions
): FirewallResult {
  // Merge provided options with defaults from environment
  const mergedOptions: FirewallOptions = {
    ...getDefaultOptions(),
    ...options,
  };
  const isClaude = isClaudeProtocol(req);

  if (isClaude) {
    // Check model whitelist (only if whitelist is configured)
    if (mergedOptions.allowedModels && mergedOptions.allowedModels.length > 0) {
      const modelId = req.body?.model;
      if (!isModelAllowed(modelId || "", mergedOptions.allowedModels)) {
        return {
          forceProvider: null,  // Don't force, let it fail with model not found
          reason: `Model '${modelId}' not in Claude protocol whitelist`,
        };
      }
    }

    // Detect specific reason for logging
    let reason = "Claude protocol detected";

    if (req.url?.includes("/v1/messages")) {
      reason = "Claude Messages API endpoint";
    } else if (req.headers?.["anthropic-version"]) {
      reason = "Anthropic version header present";
    } else {
      reason = "Claude meta instructions detected in content";
    }

    return {
      forceProvider: "anthropic",
      reason,
    };
  }

  return {
    forceProvider: null,
  };
}

/**
 * Get firewall options for a request with Anthropic API validation
 */
export function getFirewallOptionsWithApiKey(
  hasApiKey: boolean,
  customOptions?: Partial<FirewallOptions>
): FirewallOptions {
  const options: FirewallOptions = {
    ...getDefaultOptions(),
    ...customOptions
  };

  // In strict mode, we validate the API key presence externally
  // The caller should check hasApiKey before proceeding
  return options;
}
