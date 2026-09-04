import { describe, expect, it } from "vitest";
import { optionalEnterpriseHttpsUrl, workBuddyConnectorReadiness } from "./workbuddy-connector.js";

describe("optionalEnterpriseHttpsUrl", () => {
  it("accepts a credential-free enterprise HTTPS MCP address", () => {
    expect(optionalEnterpriseHttpsUrl("https://mcp.skillhive.corp.cn/mcp", "/mcp")).toEqual({
      value: "https://mcp.skillhive.corp.cn/mcp",
      valid: true,
    });
  });

  it.each([
    "http://mcp.skillhive.corp.cn/mcp",
    "https://user:password@mcp.skillhive.corp.cn/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://company-approved-domain.example/mcp",
    "https://mcp.skillhive.corp.cn/mcp?token=secret",
    "https://mcp.skillhive.corp.cn/wrong-path",
  ])("rejects an unsafe or incompatible MCP address: %s", (url) => {
    expect(optionalEnterpriseHttpsUrl(url, "/mcp")).toEqual({ value: null, valid: false });
  });

  it("accepts a normal HTTPS market URL without imposing the MCP path", () => {
    expect(optionalEnterpriseHttpsUrl("https://market.workbuddy.cn/connectors/skillhive")).toEqual({
      value: "https://market.workbuddy.cn/connectors/skillhive",
      valid: true,
    });
  });

  it("treats an absent address as not configured", () => {
    expect(optionalEnterpriseHttpsUrl(undefined, "/mcp")).toEqual({ value: null, valid: false });
  });
});

describe("workBuddyConnectorReadiness", () => {
  it("separates package, client-test and launch gates", () => {
    const readiness = workBuddyConnectorReadiness({
      mcpUrlValid: true,
      environment: "test",
      reviewStatus: "submitted",
      marketUrlValid: false,
      verifiedClientVersion: null,
      verifiedOs: null,
      verifiedAt: null,
    });
    expect(readiness.readyForPackageBuild).toBe(true);
    expect(readiness.readyForClientTest).toBe(true);
    expect(readiness.readyForLaunch).toBe(false);
    expect(readiness.launchIssues).toContain("WorkBuddy 平台审核尚未通过");
  });

  it("requires a valid MCP address even when other launch evidence exists", () => {
    const readiness = workBuddyConnectorReadiness({
      mcpUrlValid: false,
      environment: "production",
      reviewStatus: "approved",
      marketUrlValid: true,
      verifiedClientVersion: "4.24.1",
      verifiedOs: "macOS 15",
      verifiedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(readiness.readyForPackageBuild).toBe(false);
    expect(readiness.readyForClientTest).toBe(false);
    expect(readiness.readyForLaunch).toBe(false);
  });

  it("marks all repository-visible gates ready only with complete evidence", () => {
    const readiness = workBuddyConnectorReadiness({
      mcpUrlValid: true,
      environment: "production",
      reviewStatus: "approved",
      marketUrlValid: true,
      verifiedClientVersion: "4.24.1",
      verifiedOs: "Windows 11",
      verifiedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(readiness).toMatchObject({
      readyForPackageBuild: true,
      readyForClientTest: true,
      readyForLaunch: true,
      launchIssues: [],
    });
  });
});
