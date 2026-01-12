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

export function protocolFirewall(req: {
  url?: string;
  headers?: Record<string, string | undefined>;
  body?: { messages?: Array<{ content?: string | unknown }>; system?: string };
}): FirewallResult {
  if (isClaudeProtocol(req)) {
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
