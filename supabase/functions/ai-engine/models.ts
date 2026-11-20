// Model switch helpers (2026-11-20). Kept apart from index.ts so they can be tested offline.
// True when the API answered that the requested model name does not exist or is not available to this key.
export function isModelRefusal(status: number, text: string): boolean {
  return (status === 404 || status === 400) && /model/i.test(text) && /not.?found|does not exist|invalid|not available|unknown/i.test(text);
}
