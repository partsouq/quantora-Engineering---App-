import { isModelRefusal } from "./models.ts";
function assertEquals(a: unknown, b: unknown) { if (a !== b) throw new Error(`expected ${b}, got ${a}`); }

Deno.test("a missing model is a refusal", () => {
  assertEquals(isModelRefusal(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}'), true);
  assertEquals(isModelRefusal(400, '{"error":{"message":"Invalid model name"}}'), true);
});
Deno.test("other errors are not refusals", () => {
  assertEquals(isModelRefusal(429, "rate limited model"), false);
  assertEquals(isModelRefusal(400, '{"error":{"message":"max_tokens: too large"}}'), false);
  assertEquals(isModelRefusal(529, "overloaded"), false);
});
