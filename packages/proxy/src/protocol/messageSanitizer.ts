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

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlocks = content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter((text) => text.trim().length > 0);

    if (!textBlocks.length) return null;
    return textBlocks.join("\n");
  }

  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }

  return null;
}

function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "object") {
    return Object.keys(content as Record<string, unknown>).length === 0;
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
    const contentText = extractTextContent(msg.content);

    // Skip empty content messages
    if (isEmptyContent(msg.content)) {
      warnings.push(`Message ${i + 1} (${msg.role}): Empty content, skipping`);
      continue;
    }

    // Check for incomplete content in assistant messages
    if (msg.role === "assistant" && contentText && isIncompleteContent(contentText)) {
      warnings.push(
        `Message ${i + 1} (assistant): Incomplete content detected "${contentText.substring(0, 50)}...", skipping`
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
