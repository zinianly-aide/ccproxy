import assert from "node:assert/strict";
import { test } from "node:test";
import { sseDelta, sseDone } from "../packages/proxy/src/openai/format";

test("sseDelta formats OpenAI chunk", () => {
  const out = sseDelta("chatcmpl_test", "ollama:llama3", "hello");
  assert.ok(out.startsWith("data: "));
  assert.ok(out.endsWith("\n\n"));
  const payload = JSON.parse(out.replace(/^data: /, "").trim());
  assert.equal(payload.choices[0].delta.content, "hello");
});

test("sseDone ends with [DONE]", () => {
  const out = sseDone("chatcmpl_test", "ollama:llama3");
  assert.ok(out.includes("data: [DONE]"));
});
