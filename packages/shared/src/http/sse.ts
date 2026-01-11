import { ServerResponse } from "node:http";

export function writeSse(res: ServerResponse, data: string | object): void {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

export function writeSseComment(res: ServerResponse, comment: string): void {
  res.write(`: ${comment}\n\n`);
}
