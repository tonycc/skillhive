import { readFile } from "node:fs/promises";
import {
  parseSkillMd,
  validateResourceFiles,
  type ParsedSkill,
  type SkillResourceFile,
} from "@skillhive/skill-schema";
import { explorationContentSchema, validateSubmission } from "./exploration-data.js";

export const REQUIREMENT_EXPLORATION_APP_KEY = "requirement-exploration";

export const requirementExplorationApplication = {
  key: REQUIREMENT_EXPLORATION_APP_KEY,
  name: "需求探索",
  description: "引导员工澄清业务问题，将阶段性草稿和正式需求归集到公司服务器。",
  defaultTriggerPhrases: ["需求", "需求探索", "业务问题", "业务改进", "需求提交", "评审反馈"],
  type: "built_in" as const,
};

const baselineDirectory = new URL(
  "../../../examples/seed-skills/requirement-exploration/",
  import.meta.url,
);
const baselineResourcePaths = [
  "references/discussion-playbook.md",
  "references/exploration-content.schema.json",
  "references/grilling-protocol.json",
  "references/THIRD_PARTY_NOTICES.md",
] as const;

const requiredApplicationResourcePaths = [
  "references/discussion-playbook.md",
  "references/exploration-content.schema.json",
  "references/grilling-protocol.json",
] as const;

const requiredApplicationTools = [
  "get_exploration",
  "get_skill_file",
  "save_exploration",
  "submit_exploration",
] as const;

const requiredSubmissionFields = [
  "title",
  "problemDescription",
  "targetUsers",
  "currentProcess",
  "painAndEvidence",
  "objectivesAndBenefits",
  "scope",
  "acceptanceCriteria",
  "summary",
] as const;

/** 应用选择候选 Skill 版本时，验证其是否满足需求探索的固定契约。 */
export function validateRequirementExplorationApplicationSkill(
  parsed: ParsedSkill,
  files: SkillResourceFile[],
): void {
  const allowedTools = [...(parsed.frontmatter.allowed_tools ?? [])].sort();
  if (JSON.stringify(allowedTools) !== JSON.stringify([...requiredApplicationTools].sort())) {
    throw new Error(`需求探索应用 Skill 的 allowed_tools 必须且只能包含：${requiredApplicationTools.join("、")}`);
  }
  validateResourceFiles(files);
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const path of requiredApplicationResourcePaths) {
    if (!byPath.has(path) || !parsed.body.includes(path)) {
      throw new Error(`需求探索应用 Skill 必须包含并引用资源：${path}`);
    }
  }
  let schema: {
    properties?: Record<string, unknown>;
    required?: string[];
    "x-skillhive-submit-required"?: string[];
  };
  try {
    const encoded = byPath.get("references/exploration-content.schema.json")?.contentBase64 ?? "";
    schema = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as typeof schema;
  } catch {
    throw new Error("需求探索应用 Skill 的 exploration-content.schema.json 不是有效 JSON");
  }
  const serverFields = [...explorationContentSchema.keyof().options].sort();
  if (JSON.stringify(Object.keys(schema.properties ?? {}).sort()) !== JSON.stringify(serverFields)) {
    throw new Error("需求探索应用 Skill 的结构化字段与服务端 Schema 不一致");
  }
  if (JSON.stringify(schema.required) !== JSON.stringify(["title"])) {
    throw new Error("需求探索应用 Skill 的草稿必填字段必须为 title");
  }
  const submissionFields = [...(schema["x-skillhive-submit-required"] ?? [])].sort();
  const missingLabels = validateSubmission(explorationContentSchema.parse({ title: "临时标题" }));
  if (
    missingLabels.length + 1 !== requiredSubmissionFields.length
    || JSON.stringify(submissionFields) !== JSON.stringify([...requiredSubmissionFields].sort())
  ) {
    throw new Error("需求探索应用 Skill 的提交必填字段与服务端校验不一致");
  }
  validateGrillingProtocol(byPath.get("references/grilling-protocol.json")!.contentBase64);
}

function validateGrillingProtocol(contentBase64: string): void {
  let protocol: Record<string, unknown>;
  try {
    protocol = JSON.parse(Buffer.from(contentBase64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("需求探索应用 Skill 的 grilling-protocol.json 不是有效 JSON");
  }
  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
    throw new Error("需求探索应用 Skill 的 Grill Me 访谈协议不完整");
  }
  // 历史协议未强制声明版本；缺省仍按 1.0 的文本问答契约验证。
  const protocolVersion = protocol.version ?? "1.0";
  if (protocolVersion !== "1.0" && protocolVersion !== "1.1") {
    throw new Error("需求探索应用 Skill 的 Grill Me 访谈协议版本不受支持");
  }
  const questionFormat = protocol.questionFormat as Record<string, unknown> | undefined;
  if (
    protocol.protocol !== "grill-me"
    || protocol.decisionModel !== "design-tree"
    || protocol.questionStrategy !== "complete-frontier-per-round"
    || protocol.recomputeFrontierAfterEachRound !== true
    || questionFormat?.numbered !== true
    || questionFormat.titled !== true
    || questionFormat.recommendationRequired !== true
    || protocol.factOwner !== "assistant"
    || protocol.decisionOwner !== "user"
    || protocol.requiresSharedUnderstandingConfirmation !== true
    || protocol.requiresSeparateSubmissionConfirmation !== true
    || protocol.prohibitActionBeforeConfirmation !== true
  ) {
    throw new Error("需求探索应用 Skill 的 Grill Me 访谈协议不完整");
  }
  // 原生问答是 1.1 的新增约束，不能追溯应用到已发布的 1.0 快照。
  if (protocolVersion === "1.0") return;
  const nativeRequestTypes = questionFormat.nativeRequestTypes;
  if (
    questionFormat.interactionPreference !== "workbuddy-native-question"
    || !Array.isArray(nativeRequestTypes)
    || !nativeRequestTypes.includes("AskUserQuestion")
    || !nativeRequestTypes.includes("AskQuestion")
    || questionFormat.singleSelectForMutuallyExclusiveOptions !== true
    || questionFormat.multiSelectForIndependentOptions !== true
    || questionFormat.freeTextForOpenEndedFacts !== true
    || questionFormat.preserveCompleteFrontier !== true
    || questionFormat.fallback !== "numbered-text"
  ) {
    throw new Error("需求探索应用 Skill 的 Grill Me 访谈协议不完整");
  }
}

/** 读取随应用交付的可编辑基线规则包。 */
export async function loadRequirementExplorationBaseline(): Promise<{
  content: string;
  files: SkillResourceFile[];
}> {
  const content = await readFile(new URL("SKILL.md", baselineDirectory), "utf8");
  const parsed = parseSkillMd(content);
  if (parsed.frontmatter.name !== REQUIREMENT_EXPLORATION_APP_KEY) {
    throw new Error("内置需求探索 Skill 标识不一致");
  }
  const files = await Promise.all(baselineResourcePaths.map(async (path) => ({
    path,
    contentBase64: (await readFile(new URL(path, baselineDirectory))).toString("base64"),
  })));
  validateRequirementExplorationApplicationSkill(parsed, files);
  return { content, files };
}
