export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length ? token : null;
}

export function verifyBearer(header: string | undefined, expected: string): boolean {
  const token = extractBearerToken(header);
  return Boolean(token && expected && token === expected);
}
