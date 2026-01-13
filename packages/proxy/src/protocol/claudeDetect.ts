/**
 * Claude Protocol Detection Layer
 *
 * Detects requests containing Claude-specific system/meta instructions
 * that MUST be routed to Anthropic API, never to local models.
 */

export function isClaudeProtocol(req: {
  url?: string;
  headers?: Record<string, string | undefined>;
  body?: { messages?: Array<{ content?: string | unknown }>; system?: string };
}): boolean {
  // Rule 1: Check URL path
  if (req.url?.includes("/v1/messages")) {
    return true;
  }

  // Rule 2: Check Anthropic-specific headers
  const headers = req.headers || {};
  if (headers["anthropic-version"]) {
    return true;
  }

  // Rule 3: Check system prompt
  const system = req.body?.system;
  if (system && typeof system === "string" && containsClaudeMeta(system)) {
    return true;
  }

  // Rule 4: Check message content for Claude meta patterns
  const messages = req.body?.messages || [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      if (containsClaudeMeta(content)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if text contains Claude-specific meta instructions
 * These patterns indicate the request comes from Claude Code or similar Claude clients
 */
export function containsClaudeMeta(text: string): boolean {
  const CLAUDE_META_PATTERNS = [
    "<system-reminder>",
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "Plan mode is active",
  ];

  for (const pattern of CLAUDE_META_PATTERNS) {
    if (text.includes(pattern)) {
      return true;
    }
  }

  return false;
}
