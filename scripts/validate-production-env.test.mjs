import { describe, expect, it } from "vitest";
import {
  parseEnvFile,
  parseProductionValidationOptions,
  validateProductionEnv,
} from "./validate-production-env.mjs";

const connectorMeta = {
  source: "skillhive",
  version: "1.0.0",
  minWorkbuddyVersion: "4.24.0",
};

const validDeploy = {
  POSTGRES_PASSWORD: "db-L8wZ4vT1qP7mR2x",
  SKILLHIVE_SESSION_SECRET: "session-L8wZ4vT1qP7mR2xK9sN6bH3cF5dJ",
  SKILLHIVE_INTERNAL_TOKEN: "internal-Q2nX7kM4pV9cD5sA8wR1tY6hF3zB",
  CONSOLE_BIND_ADDRESS: "127.0.0.1",
  REGISTRY_BIND_ADDRESS: "127.0.0.1",
  MCP_BIND_ADDRESS: "127.0.0.1",
};

const validLaunch = {
  ...validDeploy,
  SKILLHIVE_COMPANY_NAME: "示例公司研发中心",
  WORKBUDDY_CONNECTOR_MCP_URL: "https://mcp.skillhive.corp.cn/mcp",
  WORKBUDDY_CONNECTOR_ENVIRONMENT: "production",
  WORKBUDDY_CONNECTOR_SOURCE: "skillhive",
  WORKBUDDY_CONNECTOR_VERSION: "1.0.0",
  WORKBUDDY_MIN_CLIENT_VERSION: "4.24.0",
  EXPLORATION_DRAFT_RETENTION_DAYS: "90",
  EXPLORATION_SUBMITTED_RETENTION_DAYS: "365",
};

describe("production environment validation", () => {
  it("parses comments, quoted values and equals signs", () => {
    expect(parseEnvFile("# comment\nA=one\nB='two words'\nC=x=y # note\n")).toEqual({
      A: "one",
      B: "two words",
      C: "x=y",
    });
  });

  it("parses file and process-environment modes without ambiguity", () => {
    expect(parseProductionValidationOptions(["--", "--env-file", "prod.env", "--phase", "launch"]))
      .toEqual({ envFile: "prod.env", phase: "launch", fromProcess: false });
    expect(parseProductionValidationOptions(["--from-process"]))
      .toEqual({ envFile: ".env", phase: "deploy", fromProcess: true });
    expect(() => parseProductionValidationOptions(["--from-process", "--env-file", ".env"]))
      .toThrow(/不能同时使用/);
    expect(() => parseProductionValidationOptions(["--phase", "deploy", "--phase", "launch"]))
      .toThrow(/只能提供一次/);
  });

  it("accepts deployment before WorkBuddy launch configuration and uses runtime retention defaults", () => {
    expect(validateProductionEnv({
      ...validDeploy,
      SKILLHIVE_COMPANY_NAME: "本企业",
      WORKBUDDY_CONNECTOR_MCP_URL: "",
      WORKBUDDY_CONNECTOR_ENVIRONMENT: "unconfigured",
      WORKBUDDY_CONNECTOR_SOURCE: "legacy-source",
      WORKBUDDY_CONNECTOR_VERSION: "0.0.0",
      WORKBUDDY_MIN_CLIENT_VERSION: "0.0.0",
    }, { phase: "deploy", connectorMeta })).toEqual([]);
  });

  it("rejects an explicitly invalid retention period during deployment", () => {
    const issues = validateProductionEnv({
      ...validDeploy,
      EXPLORATION_DRAFT_RETENTION_DAYS: "0",
    }, { phase: "deploy", connectorMeta });
    expect(issues.join("\n")).toMatch(/DRAFT_RETENTION_DAYS/);
  });

  it("rejects weak or reused secrets without returning their values", () => {
    const secret = "password";
    const issues = validateProductionEnv({
      ...validDeploy,
      POSTGRES_PASSWORD: secret,
      SKILLHIVE_SESSION_SECRET: secret,
      SKILLHIVE_INTERNAL_TOKEN: secret,
    }, { phase: "deploy", connectorMeta });
    expect(issues.join("\n")).not.toContain(secret);
    expect(issues.join("\n")).toMatch(/低复杂度/);
    expect(issues.join("\n")).toMatch(/必须使用不同随机值/);
  });

  it("rejects unsafe production transport and public service binds during deployment", () => {
    const issues = validateProductionEnv({
      ...validDeploy,
      MCP_BIND_ADDRESS: "0.0.0.0",
      SKILLHIVE_ALLOW_HTTP: "1",
    }, { phase: "deploy", connectorMeta });
    expect(issues.join("\n")).toMatch(/回环地址/);
    expect(issues.join("\n")).toMatch(/禁止启用/);
  });

  it("rejects unsafe WorkBuddy endpoints and non-production labels only at launch", () => {
    const issues = validateProductionEnv({
      ...validLaunch,
      WORKBUDDY_CONNECTOR_MCP_URL: "http://127.0.0.1:3100/mcp",
      WORKBUDDY_CONNECTOR_ENVIRONMENT: "test",
    }, { phase: "launch", connectorMeta });
    expect(issues.join("\n")).toMatch(/MCP_URL 无效/);
    expect(issues.join("\n")).toMatch(/必须是 production/);
  });

  it("requires platform and real-client evidence before launch", () => {
    const issues = validateProductionEnv(validLaunch, { phase: "launch", connectorMeta });
    expect(issues.join("\n")).toMatch(/REVIEW_STATUS/);
    expect(issues.join("\n")).toMatch(/MARKET_URL/);
    expect(issues.join("\n")).toMatch(/VERIFIED_CLIENT_VERSION/);
  });

  it("accepts a launch environment with external evidence fields", () => {
    expect(validateProductionEnv({
      ...validLaunch,
      WORKBUDDY_CONNECTOR_REVIEW_STATUS: "approved",
      WORKBUDDY_CONNECTOR_MARKET_URL: "https://open.workbuddy.cn/connectors/skillhive",
      WORKBUDDY_VERIFIED_CLIENT_VERSION: "4.24.1",
      WORKBUDDY_VERIFIED_OS: "macOS 15",
      WORKBUDDY_VERIFIED_AT: "2026-09-04T08:00:00+08:00",
    }, { phase: "launch", connectorMeta })).toEqual([]);
  });
});
