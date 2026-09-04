import { z } from "zod";

const shortText = z.string().trim().max(8_000);
const shortList = z.array(shortText.min(1)).max(20);

export const evidenceSchema = z.object({
  pain: shortText.min(1),
  evidence: shortText.optional(),
  evidenceStatus: z.enum(["employee_statement", "to_verify"]).default("employee_statement"),
});

/** 草稿允许渐进补齐；正式提交由 validateSubmission 再做完整性校验。 */
export const explorationContentSchema = z.object({
  title: z.string().trim().min(1).max(128),
  problemDescription: shortText.optional(),
  targetUsers: shortText.optional(),
  currentProcess: shortText.optional(),
  painAndEvidence: z.array(evidenceSchema).max(20).default([]),
  objectivesAndBenefits: shortText.optional(),
  scope: shortText.optional(),
  nonGoals: shortText.optional(),
  acceptanceCriteria: shortList.default([]),
  constraintsAndRisks: shortList.default([]),
  pendingQuestions: shortList.default([]),
  summary: shortText.optional(),
}).strict();

export type ExplorationContent = z.infer<typeof explorationContentSchema>;

export function validateSubmission(content: ExplorationContent): string[] {
  const missing: string[] = [];
  if (!content.problemDescription) missing.push("问题描述");
  if (!content.targetUsers) missing.push("目标用户/受影响对象");
  if (!content.currentProcess) missing.push("当前流程");
  if (content.painAndEvidence.length === 0) missing.push("痛点与事实依据");
  if (!content.objectivesAndBenefits) missing.push("目标与预期收益");
  if (!content.scope) missing.push("需求范围");
  if (content.acceptanceCriteria.length === 0) missing.push("验收标准");
  if (!content.summary) missing.push("总结");
  return missing;
}

export function payloadSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
