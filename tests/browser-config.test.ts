import { describe, it, expect } from "vitest";
import { applyOverrides, browserTargets } from "../src/worker/browser.config";

describe("browser selector overrides", () => {
  const base = browserTargets;
  it("replaces only the named field of the named provider", () => {
    const out = applyOverrides(base, '{"duckai":{"answer":"div.reply"}}');
    expect(out.duckai.answer).toBe("div.reply");
    expect(out.duckai.input).toBe(base.duckai.input);
    expect(out.copilot).toEqual(base.copilot);
  });
  it("ignores bad JSON, unknown providers/fields and non-string values", () => {
    expect(applyOverrides(base, "{not json")).toBe(base);
    expect(applyOverrides(base, "null")).toBe(base);
    const out = applyOverrides(
      base,
      '{"nope":{"answer":"x"},"duckai":{"answer":5,"evil":"x","stop":"  "}}',
    );
    expect(out.duckai).toEqual(base.duckai);
  });
  it("every provider keeps an assistant-specific answer selector and a send fallback", () => {
    for (const t of Object.values(base)) {
      expect(t.answer).not.toMatch(/^(?:body|main|article|div|p)$/i);
      expect(t.send).toBeTruthy();
    }
  });
});
