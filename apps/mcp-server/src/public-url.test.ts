import { describe, expect, it } from "vitest";
import { parsePublicMcpUrl } from "./public-url.js";

describe("parsePublicMcpUrl", () => {
  it.each([undefined, "", "/sse", "https://mcp.example.com/sse"])(
    "accepts the supported root SSE URL: %s",
    (value) => {
      expect(parsePublicMcpUrl(value, true)).toEqual({ messagesPath: "/messages" });
    },
  );

  it.each([
    "/prefix/sse",
    "/\\evil.example/sse",
    "/sse?",
    "/sse?tenant=x",
    "/sse#",
    "/sse#fragment",
    "https://mcp.example.com/prefix/sse",
    "https://user:pass@mcp.example.com/sse",
    "ftp://mcp.example.com/sse",
  ])("rejects unsupported or ambiguous URLs: %s", (value) => {
    expect(() => parsePublicMcpUrl(value, true)).toThrow(/PUBLIC_MCP_URL/);
  });

  it("rejects plain HTTP in production but permits it in development", () => {
    expect(() => parsePublicMcpUrl("http://localhost:3100/sse", true)).toThrow(/https/);
    expect(parsePublicMcpUrl("http://localhost:3100/sse", false)).toEqual({
      messagesPath: "/messages",
    });
  });
});
