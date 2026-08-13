// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser, fetchSkillFile, logout, type AuthUser } from "./api.js";

const USER: AuthUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  name: "测试用户",
  role: "member",
  departmentId: null,
};

describe("logout", () => {
  beforeEach(() => {
    currentUser.value = { ...USER };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    currentUser.value = null;
  });

  it("clears the in-memory user only after the server confirms logout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(currentUser.value).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("keeps the user logged in when the server rejects logout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"error":"服务暂时不可用"}', {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(logout()).rejects.toThrow("服务暂时不可用");
    expect(currentUser.value).toEqual(USER);
  });

  it("keeps the user logged in when the logout request cannot reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(logout()).rejects.toThrow("Failed to fetch");
    expect(currentUser.value).toEqual(USER);
  });
});

describe("fetchSkillFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("binds the resource request to the detail version and exact path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          version: "1.2.3",
          path: "references/a b.md",
          size: 4,
          contentBase64: "dGVzdA==",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSkillFile("demo-skill", "references/a b.md", "1.2.3"))
      .resolves.toMatchObject({ version: "1.2.3", path: "references/a b.md" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/demo-skill/file?version=1.2.3&path=references%2Fa+b.md",
      { credentials: "same-origin" },
    );
  });
});
