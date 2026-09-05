import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  updateTriggerPhrasesSchema,
  validateTriggerPhrases,
} from "./discovery-config.js";

describe("trigger phrase configuration", () => {
  it("trims phrases and removes case-insensitive duplicates", () => {
    expect(updateTriggerPhrasesSchema.parse({
      triggerPhrases: [" 周报 ", "WEEKLY REPORT", "weekly report"],
    })).toEqual({ triggerPhrases: ["周报", "WEEKLY REPORT"] });
  });

  it("rejects empty and oversized configurations", () => {
    expect(() => updateTriggerPhrasesSchema.parse({ triggerPhrases: ["   "] })).toThrow();
    expect(() => updateTriggerPhrasesSchema.parse({
      triggerPhrases: Array.from({ length: 21 }, (_, index) => `词${index}`),
    })).toThrow();
  });

  it("returns a displayable string for request validation errors", async () => {
    const app = new Hono();
    app.put("/", validateTriggerPhrases, (c) => c.json({ ok: true }));

    const response = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerPhrases: ["x".repeat(65)] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "单个触发词不能超过 64 个字符" });
  });
});
