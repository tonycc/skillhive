import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRequirementExplorationBaseline } from "../built-in-applications.js";
import { adminExplorations } from "./explorations.js";

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  skill: vi.fn(),
  policy: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@skillhive/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@skillhive/db")>(),
  db: {
    query: {
      skillVersions: { findFirst: mocks.version },
      skills: { findFirst: mocks.skill },
      explorationPolicies: { findFirst: mocks.policy },
    },
    select: mocks.select,
    transaction: mocks.transaction,
  },
}));

vi.mock("../auth.js", () => {
  const requireAdmin: MiddlewareHandler = async (c, next) => {
    c.set("user", { id: "11111111-1111-4111-8111-111111111111", role: "admin" });
    await next();
  };
  const requireInternalToken: MiddlewareHandler = async (_c, next) => next();
  return { requireAdmin, requireInternalToken };
});

const skillId = "22222222-2222-4222-8222-222222222222";
const legacyVersionId = "33333333-3333-4333-8333-333333333333";
const newVersionId = "44444444-4444-4444-8444-444444444444";
const legacyProtocolPath = "references/grilling-protocol.json";
let legacyContent: string;
let legacyFiles: Array<{ path: string; contentBase64: string; versionId: string }>;

function updatePolicy(enabled: boolean) {
  return adminExplorations.request("/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId, skillVersionId: legacyVersionId, enabled }),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  const baseline = await loadRequirementExplorationBaseline();
  const legacyProtocol = await readFile(resolve("apps/registry/src/fixtures/grilling-protocol-1.0.json"));
  legacyContent = baseline.content.replace("version: 1.2.0", "version: 1.1.0");
  legacyFiles = baseline.files.map((file) => ({
    ...file,
    versionId: legacyVersionId,
    ...(file.path === legacyProtocolPath ? { contentBase64: legacyProtocol.toString("base64") } : {}),
  }));
  mocks.version.mockResolvedValue({ id: legacyVersionId, skillId, content: legacyContent });
  mocks.skill.mockResolvedValue({ id: skillId, skillType: "application", status: "published" });
  mocks.policy.mockResolvedValue({ skillId, skillVersionId: legacyVersionId, enabled: true });
  mocks.select.mockReturnValue({ from: () => ({ where: async () => legacyFiles }) });
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: () => ({ returning: async () => [values] }),
      }),
    }),
  };
  mocks.transaction.mockImplementation((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));
});

describe("requirement exploration policy compatibility", () => {
  it("keeps published 1.0 protocols in the application version candidates", async () => {
    mocks.select.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: async () => [{ skillId, skillVersionId: legacyVersionId, version: "1.1.0", content: legacyContent }],
          }),
        }),
      }),
    });
    const response = await adminExplorations.request("/policy/options");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ skillId, skillVersionId: legacyVersionId, version: "1.1.0" }],
    });
  });

  it("allows rollback to a published text-question version", async () => {
    mocks.policy.mockResolvedValue({ skillId, skillVersionId: newVersionId, enabled: true });
    const response = await updatePolicy(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { skillVersionId: legacyVersionId, enabled: true } });
  });

  it("can pause the current binding even if its content no longer validates", async () => {
    mocks.version.mockResolvedValue({ id: legacyVersionId, skillId, content: "invalid historical content" });
    const response = await updatePolicy(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { skillVersionId: legacyVersionId, enabled: false } });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("rejects enabling a 1.1 protocol without native question requirements", async () => {
    legacyFiles = legacyFiles.map((file) => file.path === legacyProtocolPath ? {
      ...file,
      contentBase64: Buffer.from(
        Buffer.from(file.contentBase64, "base64").toString("utf8").replace('"version": "1.0"', '"version": "1.1"'),
      ).toString("base64"),
    } : file);
    const response = await updatePolicy(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("访谈协议不完整") });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("still validates a new binding when saving a paused policy", async () => {
    mocks.policy.mockResolvedValue({ skillId, skillVersionId: newVersionId, enabled: true });
    mocks.version.mockResolvedValue({ id: legacyVersionId, skillId, content: "invalid candidate content" });
    const response = await updatePolicy(false);
    expect(response.status).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
