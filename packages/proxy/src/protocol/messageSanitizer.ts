/**
 * Message Sanitizer
 *
 * Detects and handles incomplete/malformed messages in conversation history.
 * Prevents corrupted streaming responses from polluting the context.
 */

export interface SanitizationResult {
  cleaned: boolean;
  warnings: string[];
}

/**
 * Detect if a message content appears incomplete or corrupted
 */
function isIncompleteContent(content: string): boolean {
  if (!content || content.length < 2) {
    return true;  // Too short to be valid
  }

  // Check for incomplete JSON structures
  const openBraces = (content.match(/{/g) || []).length;
  const closeBraces = (content.match(/}/g) || []).length;
  const openBrackets = (content.match(/\[/g) || []).length;
  const closeBrackets = (content.match(/\]/g) || []).length;

  if (openBraces !== closeBraces || openBrackets !== closeBrackets) {
    return true;  // Unmatched brackets
  }

  // Check for common incomplete patterns
  const incompletePatterns = [
    /^{$/,          // Just an opening brace
    /^\[$/,         // Just an opening bracket
    /"[^"]*$/,      // Unclosed string
    /\.\.\.$/,      // Ends with ellipsis (might be intentional, but flag it)
  ];

  for (const pattern of incompletePatterns) {
    if (pattern.test(content.trim())) {
      return true;
    }
  }

  return false;
}

/**
 * Clean incomplete messages from conversation history
 *
 * This is especially important for fixing corrupted streaming responses
 * where the client might have captured partial responses and sent them
 * back in the conversation history.
 */
export function sanitizeMessages(
  messages: Array<{ role: string; content: string | unknown }>
): { messages: Array<{ role: string; content: string | unknown }>; result: SanitizationResult } {
  const warnings: string[] = [];
  const cleaned: Array<{ role: string; content: string | unknown }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === "string" ? msg.content : "";

    // Skip empty content messages
    if (!content) {
      warnings.push(`Message ${i + 1} (${msg.role}): Empty content, skipping`);
      continue;
    }

    // Check for incomplete content in assistant messages
    if (msg.role === "assistant" && isIncompleteContent(content)) {
      warnings.push(
        `Message ${i + 1} (assistant): Incomplete content detected "${content.substring(0, 50)}...", skipping`
      );
      continue;
    }

    cleaned.push(msg);
  }

  // Ensure we have at least 2 messages (user-assistant pair)
  if (cleaned.length === 0 && messages.length > 0) {
    warnings.push("All messages were filtered as invalid, keeping last user message");
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    if (lastUserMsg) {
      cleaned.push(lastUserMsg);
    }
  }

  return {
    messages: cleaned,
    result: {
      cleaned: cleaned.length !== messages.length,
      warnings
    }
  };
}

/**
 * Validate message content before sending to provider
 */
export function validateMessageContent(content: string | unknown): { valid: boolean; error?: string } {
  if (typeof content !== "string") {
    return { valid: true };  // Non-string content (arrays, objects) are assumed valid
  }

  if (!content || content.trim().length === 0) {
    return { valid: false, error: "Empty content" };
  }

  if (isIncompleteContent(content)) {
    return { valid: false, error: "Incomplete content detected" };
  }

  return { valid: true };
}
