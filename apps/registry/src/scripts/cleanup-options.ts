export type CleanupOptions = {
  execute: boolean;
  approvedBy: string | null;
  mode: "retention" | "delete-request";
  explorationId: string | null;
  requestRef: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionValue(args: string[], name: string): string | null {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 只能提供一次`);
  if (indexes.length === 0) return null;
  const value = args[indexes[0]! + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数值`);
  return value;
}

export function parseCleanupOptions(rawArgs: string[]): CleanupOptions {
  const args = rawArgs.filter((value) => value !== "--");
  const knownOptions = new Set(["--execute", "--approved-by", "--exploration-id", "--request-ref"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!knownOptions.has(value)) throw new Error(`未知参数：${value}`);
    if (value !== "--execute") index += 1;
  }

  const execute = args.includes("--execute");
  if (args.filter((value) => value === "--execute").length > 1) {
    throw new Error("--execute 只能提供一次");
  }
  const approvedBy = optionValue(args, "--approved-by");
  const explorationId = optionValue(args, "--exploration-id");
  const requestRef = optionValue(args, "--request-ref");

  if (approvedBy && approvedBy.length > 128) throw new Error("--approved-by 最多 128 个字符");
  if (execute && !approvedBy) throw new Error("执行清理必须提供 --approved-by <审批人或审批单号>");
  if (explorationId && !UUID_PATTERN.test(explorationId)) throw new Error("--exploration-id 必须是合法 UUID");
  if (requestRef && requestRef.length > 128) throw new Error("--request-ref 最多 128 个字符");
  if (explorationId && !requestRef) {
    throw new Error("按删除申请清理必须提供 --request-ref <删除申请或工单编号>");
  }
  if (!explorationId && requestRef) throw new Error("--request-ref 只能与 --exploration-id 同时使用");

  return {
    execute,
    approvedBy,
    mode: explorationId ? "delete-request" : "retention",
    explorationId,
    requestRef,
  };
}

export function boundedRetentionDays(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3_650 ? parsed : fallback;
}
