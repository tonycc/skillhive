import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ToolTextResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

const url = requiredUrl("WORKBUDDY_LOAD_MCP_URL");
const tokens = requiredTokens();
const concurrency = boundedInteger("WORKBUDDY_LOAD_CONCURRENCY", 20, 1, 100);
const iterations = boundedInteger("WORKBUDDY_LOAD_ITERATIONS", 10, 1, 1_000);
const thresholdMs = boundedInteger("WORKBUDDY_LOAD_P95_MS", 3_000, 1, 60_000);
const mode = process.env.WORKBUDDY_LOAD_MODE === "write" ? "write" : "read";
const environment = process.env.WORKBUDDY_LOAD_ENVIRONMENT?.trim() || "unspecified";

if (tokens.length < concurrency && process.env.WORKBUDDY_LOAD_ALLOW_TOKEN_REUSE !== "1") {
  throw new Error(
    `需要至少 ${concurrency} 枚独立测试员工令牌；如明确接受同一员工限流干扰，可设置 WORKBUDDY_LOAD_ALLOW_TOKEN_REUSE=1`,
  );
}

const startedAt = new Date();
const samples: Array<{ operation: string; durationMs: number }> = [];
const failures: Array<{ worker: number; operation: string; message: string }> = [];

await Promise.all(Array.from({ length: concurrency }, (_, worker) => runWorker(worker)));

const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
const finishedAt = new Date();
const p95 = percentile(durations, 0.95);
const report = {
  environment,
  target: url.origin + url.pathname,
  mode,
  concurrency,
  distinctTokens: new Set(tokens).size,
  iterationsPerClient: iterations,
  requestCount: samples.length,
  failureCount: failures.length,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationSeconds: Number(((finishedAt.getTime() - startedAt.getTime()) / 1_000).toFixed(3)),
  latencyMs: {
    p50: percentile(durations, 0.5),
    p95,
    p99: percentile(durations, 0.99),
    max: durations.at(-1) ?? null,
  },
  thresholdMs,
  passed: failures.length === 0 && p95 !== null && p95 <= thresholdMs,
  failures: failures.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

async function runWorker(worker: number): Promise<void> {
  const client = new Client({ name: `skillhive-load-${worker + 1}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${tokens[worker % tokens.length]}` } },
  });
  let explorationId: string | null = null;
  let revision = 0;
  try {
    await client.connect(transport);
    if (mode === "write") {
      const start = await measured(worker, "start_exploration", () => client.callTool({
        name: "start_exploration",
        arguments: {
          initialProblem: `性能测试 ${startedAt.toISOString()} worker ${worker + 1}`,
          idempotencyKey: `load-start-${randomUUID()}`,
          protocolVersion: "1.0",
        },
      }));
      const data = parseToolData<{ explorationId: string; revision: number }>(start as ToolTextResult);
      explorationId = data.explorationId;
      revision = data.revision;
    }

    for (let iteration = 0; iteration < iterations; iteration++) {
      if (mode === "read") {
        await measured(worker, "get_connector_status", () => client.callTool({
          name: "get_connector_status",
          arguments: { protocolVersion: "1.0" },
        }));
        await measured(worker, "list_my_explorations", () => client.callTool({
          name: "list_my_explorations",
          arguments: { page: 1, pageSize: 20 },
        }));
      } else {
        const saved = await measured(worker, "save_exploration", () => client.callTool({
          name: "save_exploration",
          arguments: {
            explorationId,
            expectedRevision: revision,
            idempotencyKey: `load-save-${randomUUID()}`,
            content: {
              title: `性能测试 worker ${worker + 1}`,
              problemDescription: "验证需求探索写入服务在目标并发下的响应时间。",
              targetUsers: "性能测试员工",
              currentProcess: "测试客户端并发调用 MCP。",
              painAndEvidence: [{ pain: "尚无目标环境性能证据", evidenceStatus: "employee_statement" }],
              objectivesAndBenefits: "形成可复核的延迟记录。",
              scope: "仅测试环境的 MCP 读写链路。",
              nonGoals: "不评估模型推理与公网传输。",
              acceptanceCriteria: ["报告包含 P95、并发数、环境和持续时长"],
              constraintsAndRisks: ["会在测试环境留下可识别的测试草稿"],
              pendingQuestions: [],
              summary: `性能测试第 ${iteration + 1} 次保存。`,
            },
          },
        }));
        revision = parseToolData<{ revision: number }>(saved as ToolTextResult).revision;
        await measured(worker, "get_exploration", () => client.callTool({
          name: "get_exploration",
          arguments: { explorationId },
        }));
      }
    }
  } catch (error) {
    failures.push({ worker: worker + 1, operation: explorationId ? "worker" : "connect", message: safeMessage(error) });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function measured<T>(worker: number, operation: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await action();
    if ((result as ToolTextResult)?.isError) throw new Error(toolErrorMessage(result as ToolTextResult));
    samples.push({ operation, durationMs: Number((performance.now() - started).toFixed(3)) });
    return result;
  } catch (error) {
    failures.push({ worker: worker + 1, operation, message: safeMessage(error) });
    throw error;
  }
}

function parseToolData<T>(result: ToolTextResult): T {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP 工具没有返回文本结果");
  const parsed = JSON.parse(text) as { data?: T } | T;
  return typeof parsed === "object" && parsed !== null && "data" in parsed
    ? (parsed as { data: T }).data
    : parsed as T;
}

function toolErrorMessage(result: ToolTextResult): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "MCP 工具返回错误";
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function requiredTokens(): string[] {
  const values = (process.env.WORKBUDDY_LOAD_PATS ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => !/^sk-[a-f0-9]{48}$/.test(value))) {
    throw new Error("WORKBUDDY_LOAD_PATS 必须提供逗号或换行分隔的测试员工令牌，且不得使用生产员工令牌");
  }
  return values;
}

function requiredUrl(name: string): URL {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} 未配置`);
  const parsed = new URL(raw);
  if (parsed.pathname !== "/mcp" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${name} 必须是无凭据、无查询参数的完整 /mcp 地址`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && process.env.WORKBUDDY_LOAD_ALLOW_HTTP === "1")) {
    throw new Error(`${name} 必须使用 HTTPS；本机隔离环境才可显式设置 WORKBUDDY_LOAD_ALLOW_HTTP=1`);
  }
  return parsed;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.replace(/sk-[a-f0-9]{48}/gi, "[REDACTED]").slice(0, 1_000);
}
