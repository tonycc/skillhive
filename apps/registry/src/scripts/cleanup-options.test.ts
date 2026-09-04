import { describe, expect, it } from "vitest";
import { boundedRetentionDays, parseCleanupOptions } from "./cleanup-options.js";

describe("parseCleanupOptions", () => {
  it("defaults to a dry-run retention cleanup", () => {
    expect(parseCleanupOptions([])).toEqual({
      execute: false,
      approvedBy: null,
      mode: "retention",
      explorationId: null,
      requestRef: null,
    });
  });

  it("accepts an approved targeted deletion request", () => {
    expect(parseCleanupOptions([
      "--exploration-id", "11111111-1111-4111-8111-111111111111",
      "--request-ref", "DATA-2026-0042",
      "--execute", "--approved-by", "privacy-owner@example.com",
    ])).toMatchObject({
      execute: true,
      approvedBy: "privacy-owner@example.com",
      mode: "delete-request",
      requestRef: "DATA-2026-0042",
    });
  });

  it("requires a request reference for targeted cleanup", () => {
    expect(() => parseCleanupOptions([
      "--exploration-id", "11111111-1111-4111-8111-111111111111",
    ])).toThrow("--request-ref");
  });

  it("requires an approver before executing either mode", () => {
    expect(() => parseCleanupOptions(["--execute"])).toThrow("--approved-by");
    expect(() => parseCleanupOptions([
      "--execute", "--execute", "--approved-by", "owner",
    ])).toThrow("只能提供一次");
  });

  it("rejects invalid identifiers and unknown arguments", () => {
    expect(() => parseCleanupOptions([
      "--exploration-id", "not-an-id", "--request-ref", "DATA-1",
    ])).toThrow("合法 UUID");
    expect(() => parseCleanupOptions(["--force"])).toThrow("未知参数");
  });
});

describe("boundedRetentionDays", () => {
  it("uses only whole-day values within the supported range", () => {
    expect(boundedRetentionDays("30", 90)).toBe(30);
    expect(boundedRetentionDays("0", 90)).toBe(90);
    expect(boundedRetentionDays("1.5", 90)).toBe(90);
    expect(boundedRetentionDays("4000", 90)).toBe(90);
  });
});
