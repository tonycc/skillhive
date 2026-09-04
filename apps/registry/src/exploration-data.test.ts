import { describe, expect, it } from "vitest";
import { explorationContentSchema, payloadSize, validateSubmission } from "./exploration-data.js";

const complete = {
  title: "缩短采购审批等待时间",
  problemDescription: "采购审批经常无法确认当前处理人。",
  targetUsers: "采购申请人和审批人",
  currentProcess: "申请人提交表单后逐级线下询问。",
  painAndEvidence: [{ pain: "等待状态不透明", evidenceStatus: "employee_statement" as const }],
  objectivesAndBenefits: "让申请人及时了解状态，减少重复询问。",
  scope: "展示审批状态和当前环节。",
  acceptanceCriteria: ["申请人可查询本人申请的当前审批环节"],
  constraintsAndRisks: ["不得展示其他员工的采购金额"],
  pendingQuestions: ["审批系统是否提供事件接口"],
  summary: "为采购申请提供权限隔离的进度查询能力。",
};

describe("exploration content", () => {
  it("allows an incomplete draft and reports formal submission gaps", () => {
    const draft = explorationContentSchema.parse({ title: "暂定标题" });
    expect(draft.painAndEvidence).toEqual([]);
    expect(validateSubmission(draft)).toContain("问题描述");
  });

  it("accepts a complete formal submission", () => {
    const parsed = explorationContentSchema.parse(complete);
    expect(validateSubmission(parsed)).toEqual([]);
    expect(payloadSize(parsed)).toBeLessThan(64 * 1024);
  });

  it("rejects unknown fields so raw chat cannot be smuggled into the draft", () => {
    expect(() => explorationContentSchema.parse({ ...complete, conversation: ["secret"] })).toThrow();
  });
});
