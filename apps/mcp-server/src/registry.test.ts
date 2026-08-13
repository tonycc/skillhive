import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVisibleSkillFile, type CallerIdentity } from "./registry.js";

const identity: CallerIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "member@example.com",
  name: "Member",
  role: "member",
  departmentId: null,
  tokenId: "22222222-2222-4222-8222-222222222222",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchVisibleSkillFile", () => {
  it("fetches one encoded path with all internal identity headers", async () => {
    vi.stubEnv("SKILLHIVE_INTERNAL_TOKEN", "i".repeat(32));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            version: "1.2.3",
            path: "references/policy zh.md",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await fetchVisibleSkillFile(
      "weekly-report",
      "references/policy zh.md",
      "1.2.3",
      identity,
    );

    expect(file.contentBase64).toBe("aGVsbG8=");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/api/skills/internal/weekly-report/file");
    expect(url.searchParams.get("path")).toBe("references/policy zh.md");
    expect(url.searchParams.get("version")).toBe("1.2.3");
    expect(init.headers).toMatchObject({
      "X-SkillHive-Internal-Token": "i".repeat(32),
      "X-SkillHive-User-Id": identity.id,
      "X-SkillHive-Token-Id": identity.tokenId,
    });
  });
});
