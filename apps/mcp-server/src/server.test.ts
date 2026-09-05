import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import type { CallerIdentity } from "./registry.js";

const employee: CallerIdentity = {
  subjectType: "employee",
  id: "11111111-1111-4111-8111-111111111111",
  phone: "13800138000",
  email: null,
  name: "Employee",
  role: "employee",
  departmentId: null,
  tokenId: "22222222-2222-4222-8222-222222222222",
  scopes: ["skills:read", "explorations:read:self", "explorations:write:self"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("employee MCP tools", () => {
  it("registers the seven exploration tools and forwards trusted identity headers", async () => {
    vi.stubEnv("SKILLHIVE_INTERNAL_TOKEN", "i".repeat(32));
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/skills/internal") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.pathname === "/api/internal/explorations/status") {
        return new Response(JSON.stringify({ data: { explorationsWritable: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server } = await createServer(employee);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "get_connector_status",
        "start_exploration",
        "list_my_explorations",
        "get_exploration",
        "save_exploration",
        "submit_exploration",
        "abandon_exploration",
      ]));
      const result = await client.callTool({ name: "get_connector_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      const statusCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/explorations/status"));
      expect(statusCall?.[1]?.headers).toMatchObject({
        "X-SkillHive-Employee-Id": employee.id,
        "X-SkillHive-Subject-Type": "employee",
        "X-SkillHive-Token-Id": employee.tokenId,
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("preserves Registry error codes, retryability, and next-step guidance", async () => {
    vi.stubEnv("SKILLHIVE_INTERNAL_TOKEN", "i".repeat(32));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/skills/internal") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: "需求探索调用过于频繁，请稍后重试",
        code: "RATE_LIMITED",
        retryable: true,
        nextStep: "等待后使用原幂等键重试",
      }), { status: 429 });
    }));

    const { server } = await createServer(employee);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_connector_status", arguments: {} });
      expect(result.isError).toBe(true);
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const payload = JSON.parse(resultContent[0]?.text ?? "{}") as {
        error?: { code?: string; retryable?: boolean; nextStep?: string };
      };
      expect(payload.error).toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
        nextStep: "等待后使用原幂等键重试",
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("discovers ordinary Skills and applications with explicit routing metadata", async () => {
    vi.stubEnv("SKILLHIVE_INTERNAL_TOKEN", "i".repeat(32));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/skills/internal") {
        return new Response(JSON.stringify({ data: [
          {
            slug: "general-writing",
            name: "通用写作",
            summary: "可以帮我整理周报，也可以处理其他文档",
            category: "办公",
            tags: ["写作"],
            triggerPhrases: [],
            skillType: "ordinary",
          },
          {
            slug: "weekly-report",
            name: "周报助手",
            summary: "整理团队周报",
            category: "办公",
            tags: ["汇报", "周报"],
            triggerPhrases: ["整理周报", "生成团队周报"],
            skillType: "ordinary",
          },
        ] }), { status: 200 });
      }
      if (url.pathname === "/api/internal/applications") {
        return new Response(JSON.stringify({ data: [{
          key: "requirement-exploration",
          name: "需求探索",
          summary: "梳理并提交业务需求",
          category: "产品",
          triggerPhrases: ["需求", "业务改进"],
          entryType: "application",
          applicationKey: "requirement-exploration",
          entryTool: "start_exploration",
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    }));

    const { server } = await createServer(employee);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const searchResult = await client.callTool({
        name: "search_skills",
        arguments: { query: "帮我整理周报" },
      });
      const searchContent = searchResult.content as Array<{ type: string; text?: string }>;
      const matched = JSON.parse(searchContent[0]?.text ?? "[]") as Array<Record<string, unknown>>;
      expect(matched).toHaveLength(2);
      expect(matched[0]).toMatchObject({
        slug: "weekly-report",
        entryType: "skill",
        applicationKey: null,
      });

      const ordinaryApplicationSearch = await client.callTool({
        name: "search_skills",
        arguments: { query: "需求" },
      });
      const ordinaryApplicationContent = ordinaryApplicationSearch.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(ordinaryApplicationContent[0]?.text ?? "[]")).toEqual([]);

      const capabilitySearch = await client.callTool({
        name: "search_capabilities",
        arguments: { query: "需求" },
      });
      const capabilityContent = capabilitySearch.content as Array<{ type: string; text?: string }>;
      const capabilities = JSON.parse(capabilityContent[0]?.text ?? "[]") as Array<Record<string, unknown>>;
      expect(capabilities).toEqual([expect.objectContaining({
        entryType: "application",
        applicationKey: "requirement-exploration",
        entryTool: "start_exploration",
      })]);

      const listResult = await client.callTool({ name: "list_skills", arguments: {} });
      const listContent = listResult.content as Array<{ type: string; text?: string }>;
      const listed = JSON.parse(listContent[0]?.text ?? "[]") as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(2);
      expect(listed.some((item) => item.applicationKey === "requirement-exploration")).toBe(false);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("keeps application Skills out of generic reads while allowing locked application resources", async () => {
    vi.stubEnv("SKILLHIVE_INTERNAL_TOKEN", "i".repeat(32));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/skills/internal") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (
        url.pathname === "/api/skills/internal/requirement-exploration"
        || url.pathname === "/api/skills/internal/requirement-exploration/file"
      ) {
        return new Response(JSON.stringify({ error: "应用 Skill 只能由应用使用" }), { status: 403 });
      }
      if (url.pathname === "/api/internal/explorations/55555555-5555-4555-8555-555555555555/rule-file") {
        expect(url.searchParams.get("slug")).toBe("requirement-exploration");
        expect(url.searchParams.get("version")).toBe("1.0.0");
        expect(url.searchParams.get("path")).toBe("references/policy.md");
        return new Response(JSON.stringify({ data: {
          version: "1.0.0",
          path: "references/policy.md",
          size: 5,
          contentBase64: "aGVsbG8=",
        } }), { status: 200 });
      }
      if (url.pathname.endsWith("/events")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { server } = await createServer(employee);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "get_skill",
        arguments: { slug: "requirement-exploration" },
      });
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const text = resultContent[0]?.text ?? "";
      expect(result.isError).toBe(true);
      expect(text).toContain("应用 Skill 只能由应用使用");

      const unmanagedFileAttempt = await client.callTool({
        name: "get_skill_file",
        arguments: {
          slug: "requirement-exploration",
          version: "1.0.0",
          path: "references/policy.md",
        },
      });
      expect(unmanagedFileAttempt.isError).toBe(true);
      const fileErrorContent = unmanagedFileAttempt.content as Array<{ type: string; text?: string }>;
      expect(fileErrorContent[0]?.text).toContain("应用 Skill 只能由应用使用");

      const boundFile = await client.callTool({
        name: "get_skill_file",
        arguments: {
          slug: "requirement-exploration",
          version: "1.0.0",
          path: "references/policy.md",
          explorationId: "55555555-5555-4555-8555-555555555555",
        },
      });
      expect(boundFile.isError).not.toBe(true);
      const boundContent = boundFile.content as Array<{ type: string; text?: string }>;
      expect(boundContent[0]?.text).toContain("hello");
      expect(fetchMock.mock.calls.filter(([input]) =>
        new URL(String(input)).pathname === "/api/skills/internal/requirement-exploration/file"
      )).toHaveLength(1);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
