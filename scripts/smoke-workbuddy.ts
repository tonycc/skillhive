import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.SKILLHIVE_INTERNAL_TOKEN ||= "smoke-internal-token-at-least-32-characters";
process.env.SKILLHIVE_SESSION_SECRET ||= "smoke-session-secret-at-least-32-characters";

const { app, createApp } = await import("../apps/registry/src/app.js");
const { generatePat, hashPassword, hashPat } = await import("../apps/registry/src/auth.js");
const { loadRequirementExplorationBaseline } = await import("../apps/registry/src/built-in-applications.js");
const { parseSkillMd } = await import("../packages/skill-schema/src/index.js");
const {
  db,
  departments,
  employees,
  employeeTokens,
  explorationAuditEvents,
  explorationIdempotency,
  explorationPolicies,
  explorationRevisions,
  explorations,
  skillDepartmentVisibility,
  skillVersionFiles,
  requirementSubmissions,
  requirementReviews,
  requirements,
  skillVersions,
  skills,
  userTokens,
  users,
} = await import("../packages/db/src/index.js");
const { and, eq } = await import("../apps/registry/node_modules/drizzle-orm/index.js");

const suffix = randomUUID().slice(0, 8);
const phoneSuffix = String(parseInt(suffix, 16)).slice(-8).padStart(8, "0");
let adminId = "";
let skillId = "";
let employeeId = "";
let secondEmployeeId = "";
let memberId = "";
let firstDepartmentId = "";
let secondDepartmentId = "";
let applicationSkillIdCreatedBySmoke = "";
let incompatibleApplicationSkillId = "";

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  return app.request(`http://localhost${path}`, {
    ...init,
    headers: {
      Origin: "http://localhost",
      Host: "localhost",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
  });
}

async function json<T>(response: Response, expected: number): Promise<T> {
  const body = await response.json() as T & { error?: string };
  assert.equal(response.status, expected, body.error ?? JSON.stringify(body));
  return body;
}

try {
  const existingBuiltInApplicationSkill = await db.query.skills.findFirst({
    where: eq(skills.slug, "requirement-exploration"),
  });
  const [admin] = await db.insert(users).values({
    email: `smoke-admin-${suffix}@example.invalid`,
    name: "Smoke Admin",
    passwordHash: await hashPassword(`Smoke-${suffix}-Password`),
    role: "admin",
  }).returning();
  assert(admin);
  adminId = admin.id;
  const [member] = await db.insert(users).values({
    email: `smoke-member-${suffix}@example.invalid`,
    name: "Smoke Member",
    passwordHash: await hashPassword(`Smoke-${suffix}-Password`),
    role: "member",
  }).returning();
  assert(member);
  memberId = member.id;
  const legacyPat = generatePat();
  const [legacyToken] = await db.insert(userTokens).values({
    userId: member.id,
    name: "Smoke legacy PAT",
    tokenHash: legacyPat.hash,
  }).returning();
  assert(legacyToken);
  await json(await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: member.email, password: `Smoke-${suffix}-Password` }),
  }), 403);
  await json(await api("/api/auth/resolve-pat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN! },
    body: JSON.stringify({ token: legacyPat.token }),
  }), 401);

  const [firstDepartment, secondDepartment] = await db.insert(departments).values([
    { name: `Smoke Department A ${suffix}` },
    { name: `Smoke Department B ${suffix}` },
  ]).returning();
  assert(firstDepartment && secondDepartment);
  firstDepartmentId = firstDepartment.id;
  secondDepartmentId = secondDepartment.id;

  const login = await json<{ data: { user: { role: string } } }>(await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: admin.email, password: `Smoke-${suffix}-Password` }),
  }), 200);
  assert.equal(login.data.user.role, "admin");
  const loginResponse = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: admin.email, password: `Smoke-${suffix}-Password` }),
  });
  const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie);
  assert.equal((await api("/api/auth/tokens", {}, cookie)).status, 404);
  assert.equal((await api("/api/auth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No longer supported" }),
  }, cookie)).status, 404);
  const smokeBaseline = await loadRequirementExplorationBaseline();
  const baselineVersion = parseSkillMd(smokeBaseline.content).frontmatter.version ?? "1.1.0";
  const smokeSlug = `requirement-exploration-${suffix}`;
  const smokeContent = smokeBaseline.content
    .replace("name: requirement-exploration", `name: ${smokeSlug}`)
    .replace("# 公司需求探索规则", "# 公司需求探索规则\n\n按阶段探索需求。");
  const publishedSmokeSkill = await json<{
    data: { slug: string; version: string; skillType: string };
  }>(await api("/api/skills/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: smokeContent,
      changelog: "端到端验证统一入口发布应用 Skill",
      files: smokeBaseline.files,
      skillType: "application",
    }),
  }, cookie), 201);
  assert.equal(publishedSmokeSkill.data.slug, smokeSlug);
  assert.equal(publishedSmokeSkill.data.skillType, "application");
  const skill = await db.query.skills.findFirst({ where: eq(skills.slug, smokeSlug) });
  assert(skill);
  skillId = skill.id;
  const version = await db.query.skillVersions.findFirst({ where: and(
    eq(skillVersions.skillId, skill.id),
    eq(skillVersions.version, baselineVersion),
  ) });
  assert(version);
  const cliSession = await json<{ data: { token: string } }>(await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Session-Mode": "bearer" },
    body: JSON.stringify({ email: admin.email, password: `Smoke-${suffix}-Password` }),
  }), 200);
  assert.equal((await api("/api/admin/employees", {
    headers: { Authorization: `Bearer ${cliSession.data.token}` },
  })).status, 403);
  const connectorInfo = await json<{ data: { source: string; readyForPackageBuild: boolean } }>(
    await api("/api/admin/explorations/connector", {}, cookie),
    200,
  );
  assert.equal(connectorInfo.data.source, "skillhive");
  const applicationList = await json<{ data: Array<{ key: string; initialized: boolean }> }>(
    await api("/api/admin/applications", {}, cookie),
    200,
  );
  assert(applicationList.data.some((item) =>
    item.key === "requirement-exploration" && typeof item.initialized === "boolean"));
  const applicationDetail = await json<{ data: { key: string; initialized: boolean } }>(
    await api("/api/admin/applications/requirement-exploration", {}, cookie),
    200,
  );
  assert.equal(applicationDetail.data.key, "requirement-exploration");
  assert.equal(typeof applicationDetail.data.initialized, "boolean");
  if (!existingBuiltInApplicationSkill) {
    const initializedApplication = await json<{
      data: { skill: { id: string; latestVersion: { version: string; files: Array<{ path: string }> } } };
    }>(await api("/api/admin/applications/requirement-exploration/initialize", {
      method: "POST",
    }, cookie), 200);
    applicationSkillIdCreatedBySmoke = initializedApplication.data.skill.id;
    assert.equal(initializedApplication.data.skill.latestVersion.version, baselineVersion);
    assert.deepEqual(
      initializedApplication.data.skill.latestVersion.files.map((item) => item.path).sort(),
      [
        "references/THIRD_PARTY_NOTICES.md",
        "references/discussion-playbook.md",
        "references/exploration-content.schema.json",
        "references/grilling-protocol.json",
      ],
    );
    const baseline = await loadRequirementExplorationBaseline();
    const publishedApplication = await json<{
      data: { slug: string; version: string; skillType: string };
    }>(await api("/api/skills/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: baseline.content.replace(`version: ${baselineVersion}`, "version: 1.1.1"),
        changelog: "验证统一入口发布应用 Skill",
        files: baseline.files,
        skillType: "application",
      }),
    }, cookie), 201);
    assert.equal(publishedApplication.data.slug, "requirement-exploration");
    assert.equal(publishedApplication.data.version, "1.1.1");
    assert.equal(publishedApplication.data.skillType, "application");
    assert.equal((await api("/api/skills/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: baseline.content.replace(`version: ${baselineVersion}`, "version: 1.1.2"),
        changelog: "不得转换为普通 Skill",
        files: baseline.files,
        skillType: "ordinary",
      }),
    }, cookie)).status, 403);
  }
  const incompatibleSlug = `incompatible-application-${suffix}`;
  const incompatible = await json<{ data: { slug: string; version: string; skillType: string } }>(await api("/api/skills/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cliSession.data.token}` },
    body: JSON.stringify({
      content: `---\nname: ${incompatibleSlug}\ndescription: candidate without requirement contract\nversion: 1.0.0\n---\n\n缺少需求探索固定契约。`,
      changelog: "验证不兼容应用 Skill 可进入候选池",
      files: [],
      skillType: "application",
    }),
  }), 201);
  assert.equal(incompatible.data.skillType, "application");
  const incompatibleSkill = await db.query.skills.findFirst({ where: eq(skills.slug, incompatibleSlug) });
  assert(incompatibleSkill);
  incompatibleApplicationSkillId = incompatibleSkill.id;
  const incompatibleVersion = await db.query.skillVersions.findFirst({
    where: eq(skillVersions.skillId, incompatibleSkill.id),
  });
  assert(incompatibleVersion);
  const policyOptions = await json<{ data: Array<{ skillVersionId: string }> }>(
    await api("/api/admin/explorations/policy/options", {}, cookie),
    200,
  );
  assert.equal(policyOptions.data.some((item) => item.skillVersionId === incompatibleVersion.id), false);
  assert.equal((await api("/api/admin/explorations/policy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: incompatibleSkill.id,
      skillVersionId: incompatibleVersion.id,
      enabled: true,
    }),
  }, cookie)).status, 409);

  const createdEmployee = await json<{ data: { id: string } }>(await api("/api/admin/employees", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: `139${phoneSuffix}`,
      name: "Smoke Employee",
      departmentId: firstDepartment.id,
    }),
  }, cookie), 201);
  employeeId = createdEmployee.data.id;
  assert.equal((await api("/api/admin/employees/legacy-users", {}, cookie)).status, 404);
  assert.equal((await api("/api/admin/employees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "123", name: "Invalid Phone" }),
  }, cookie)).status, 400);
  assert.equal((await api("/api/admin/employees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: `139${phoneSuffix}`, name: "Duplicate Phone" }),
  }, cookie)).status, 409);
  const employeePage = await json<{ data: { items: Array<{ id: string; phone: string | null }>; total: number; page: number; pageSize: number } }>(
    await api(`/api/admin/employees?keyword=${encodeURIComponent(`139${phoneSuffix}`)}&page=1&pageSize=20`, {}, cookie),
    200,
  );
  assert(employeePage.data.items.some((item) => item.id === employeeId && item.phone === `139${phoneSuffix}`));
  assert.equal(employeePage.data.page, 1);
  assert.equal(employeePage.data.pageSize, 20);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: skill.id, skillVersionId: version.id, enabled: true }),
  }, cookie), 200);
  const issued = await json<{ data: { token: string; id: string } }>(await api(`/api/admin/employees/${employeeId}/tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke WorkBuddy", expiresInDays: 1 }),
  }, cookie), 201);
  const resolved = await json<{ data: { id: string; tokenId: string; subjectType: string } }>(await api("/api/auth/resolve-pat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN! },
    body: JSON.stringify({ token: issued.data.token }),
  }), 200);
  assert.equal(resolved.data.subjectType, "employee");
  await json(await api("/api/auth/resolve-pat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN! },
    body: JSON.stringify({ token: legacyPat.token }),
  }), 401);
  assert.equal((await api("/api/admin/employees", {
    headers: { Authorization: `Bearer ${legacyPat.token}` },
  })).status, 401);
  const internalHeaders = {
    "Content-Type": "application/json",
    "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN!,
    "X-SkillHive-Employee-Id": employeeId,
    "X-SkillHive-Token-Id": resolved.data.tokenId,
  };
  const internalSkillHeaders = {
    ...internalHeaders,
    "X-SkillHive-Subject-Id": employeeId,
    "X-SkillHive-Subject-Type": "employee",
  };
  const ordinarySkillList = await json<{ data: Array<{ skillType: string }> }>(
    await api("/api/skills/internal", { headers: internalSkillHeaders }),
    200,
  );
  assert.equal(
    ordinarySkillList.data.some((item) => item.skillType !== "ordinary"),
    false,
    "普通 Skill 列表不得暴露应用 Skill",
  );
  assert.equal(
    (await api("/api/skills/internal/requirement-exploration", { headers: internalSkillHeaders })).status,
    403,
    "应用 Skill 不得从通用 Skill 详情入口读取",
  );
  const applicationCatalog = await json<{ data: Array<{ applicationKey: string; entryTool: string }> }>(
    await api("/api/internal/applications", { headers: internalSkillHeaders }),
    200,
  );
  assert(applicationCatalog.data.some((item) =>
    item.applicationKey === "requirement-exploration" && item.entryTool === "start_exploration"));
  const incompatibleStatus = await json<{ data: { protocolCompatible: boolean; explorationsWritable: boolean } }>(
    await api("/api/internal/explorations/status?protocolVersion=2.0", { headers: internalHeaders }),
    200,
  );
  assert.equal(incompatibleStatus.data.protocolCompatible, false);
  assert.equal(incompatibleStatus.data.explorationsWritable, false);
  const started = await json<{ data: { explorationId: string; revision: number; rule: {
    version: string;
    content: string;
    resources: Array<Record<string, unknown>>;
  } } }>(await api("/api/internal/explorations/start", {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ initialProblem: "审批状态不透明", idempotencyKey: `start-${suffix}`, protocolVersion: "1.0" }),
  }), 201);
  const storedIssued = await db.query.employeeTokens.findFirst({ where: eq(employeeTokens.id, issued.data.id) });
  assert.equal(storedIssued?.tokenHash, hashPat(issued.data.token));
  assert.notEqual(storedIssued?.tokenHash, issued.data.token);
  const issuedAudits = await db.select({ metadata: explorationAuditEvents.metadata })
    .from(explorationAuditEvents)
    .where(and(
      eq(explorationAuditEvents.actorId, admin.id),
      eq(explorationAuditEvents.action, "employee.token_issued"),
    ));
  assert(issuedAudits.some((item) => item.metadata.tokenId === issued.data.id));
  const tokenListResponse = await json<{ data: Array<Record<string, unknown>> }>(
    await api(`/api/admin/employees/${employeeId}/tokens`, {}, cookie), 200,
  );
  assert.equal(tokenListResponse.data.some((item) => "token" in item || "tokenHash" in item), false);
  const explorationId = started.data.explorationId;
  assert.equal(started.data.revision, 0);
  assert.equal(started.data.rule.version, baselineVersion);
  assert.match(started.data.rule.content, /按阶段探索需求/);
  assert.equal(started.data.rule.resources[0]?.path, "references/discussion-playbook.md");
  assert.equal(typeof started.data.rule.resources[0]?.size, "number");
  assert.equal("contentBase64" in started.data.rule.resources[0]!, false);
  const snapshotFilePath = String(started.data.rule.resources[0]?.path);
  const snapshotFileQuery = new URLSearchParams({
    slug: skill.slug,
    version: started.data.rule.version,
    path: snapshotFilePath,
  });
  const lockedResource = await json<{ data: { contentBase64: string } }>(
    await api(`/api/internal/explorations/${explorationId}/rule-file?${snapshotFileQuery}`, {
      headers: internalHeaders,
    }),
    200,
  );
  assert.equal(
    lockedResource.data.contentBase64,
    smokeBaseline.files.find((file) => file.path === snapshotFilePath)?.contentBase64,
  );
  await db.delete(skillVersionFiles).where(eq(skillVersionFiles.versionId, version.id));
  const lockedResourceAfterSourceRemoval = await json<{ data: { contentBase64: string } }>(
    await api(`/api/internal/explorations/${explorationId}/rule-file?${snapshotFileQuery}`, {
      headers: internalHeaders,
    }),
    200,
  );
  assert.equal(lockedResourceAfterSourceRemoval.data.contentBase64, lockedResource.data.contentBase64);
  // 源版本被人为破坏后不能再次关联；恢复完整不可变包，供后续回退场景验证。
  await db.insert(skillVersionFiles).values(smokeBaseline.files.map((file) => ({
    versionId: version.id,
    path: file.path,
    contentBase64: file.contentBase64,
    size: Buffer.from(file.contentBase64, "base64").byteLength,
  })));

  await json(await api("/api/skills/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: smokeContent
        .replace(`version: ${baselineVersion}`, "version: 2.0.0")
        .replace("按阶段探索需求。", "按第二版规则探索需求。"),
      changelog: "端到端验证应用 Skill 新版本",
      files: smokeBaseline.files,
      skillType: "application",
    }),
  }, cookie), 201);
  const version2 = await db.query.skillVersions.findFirst({ where: and(
    eq(skillVersions.skillId, skill.id),
    eq(skillVersions.version, "2.0.0"),
  ) });
  assert(version2);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: skill.id, skillVersionId: version2.id, enabled: true }),
  }, cookie), 200);
  const startedV2 = await json<{ data: { explorationId: string; rule: { version: string } } }>(await api("/api/internal/explorations/start", {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ initialProblem: "验证新规则", idempotencyKey: `start-v2-${suffix}`, protocolVersion: "1.0" }),
  }), 201);
  assert.equal(startedV2.data.rule.version, "2.0.0");
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: skill.id,
      skillVersionId: version2.id,
      blockedSkillVersionIds: [version2.id],
      enabled: true,
    }),
  }, cookie), 200);
  const blockedApplicationList = await json<{ data: Array<{ key: string; enabled: boolean }> }>(
    await api("/api/admin/applications", {}, cookie),
    200,
  );
  assert.equal(
    blockedApplicationList.data.find((item) => item.key === "requirement-exploration")?.enabled,
    false,
  );
  const blockedApplicationCatalog = await json<{ data: Array<{ applicationKey: string }> }>(
    await api("/api/internal/applications", { headers: internalSkillHeaders }),
    200,
  );
  assert.equal(blockedApplicationCatalog.data.some((item) => item.applicationKey === "requirement-exploration"), false);
  const oldRuleDetail = await json<{ data: { ruleSnapshot: { version: string; resources: Array<Record<string, unknown>> } } }>(
    await api(`/api/internal/explorations/${explorationId}`, { headers: internalHeaders }), 200,
  );
  assert.equal(oldRuleDetail.data.ruleSnapshot.version, baselineVersion);
  assert.equal("contentBase64" in oldRuleDetail.data.ruleSnapshot.resources[0]!, false);
  const adminRuleDetail = await json<{ data: { ruleSnapshot: { resources: Array<Record<string, unknown>> } } }>(
    await api(`/api/admin/explorations/${explorationId}`, {}, cookie), 200,
  );
  assert.equal("contentBase64" in adminRuleDetail.data.ruleSnapshot.resources[0]!, false);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skillId: skill.id,
      skillVersionId: version.id,
      blockedSkillVersionIds: [version2.id],
      enabled: true,
    }),
  }, cookie), 200);
  assert.equal((await api(`/api/internal/explorations/${startedV2.data.explorationId}`, {
    method: "PUT", headers: { ...internalHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: 0,
      content: { title: "危险版本不应继续写入" },
      idempotencyKey: `save-blocked-version-${suffix}`,
    }),
  })).status, 409);
  assert.equal((await api(`/api/internal/explorations/${startedV2.data.explorationId}`, {
    headers: internalHeaders,
  })).status, 200);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: skill.id, skillVersionId: version.id, enabled: true }),
  }, cookie), 200);
  const startedRollback = await json<{ data: { rule: { version: string } } }>(await api("/api/internal/explorations/start", {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ initialProblem: "验证规则回退", idempotencyKey: `start-rollback-${suffix}`, protocolVersion: "1.0" }),
  }), 201);
  assert.equal(startedRollback.data.rule.version, baselineVersion);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: skill.id, skillVersionId: version.id, enabled: false }),
  }, cookie), 200);
  assert.equal((await api("/api/internal/explorations/start", {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ initialProblem: "停用期间不可开始", idempotencyKey: `start-disabled-${suffix}`, protocolVersion: "1.0" }),
  })).status, 409);
  await json(await api("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId: skill.id, skillVersionId: version.id, enabled: true }),
  }, cookie), 200);

  const content = {
    title: "缩短采购审批等待时间",
    problemDescription: "采购审批经常无法确认当前处理人。",
    targetUsers: "采购申请人和审批人",
    currentProcess: "申请人提交表单后逐级线下询问。",
    painAndEvidence: [{ pain: "等待状态不透明", evidenceStatus: "employee_statement" }],
    objectivesAndBenefits: "让申请人及时了解状态，减少重复询问。",
    scope: "展示审批状态和当前环节。",
    acceptanceCriteria: ["申请人可查询本人申请的当前审批环节"],
    constraintsAndRisks: ["不得展示其他员工的采购金额"],
    pendingQuestions: ["审批系统是否提供事件接口"],
    summary: "为采购申请提供权限隔离的进度查询能力。",
  };
  const concurrentStarted = await json<{ data: { explorationId: string } }>(await api("/api/internal/explorations/start", {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ initialProblem: "并发修订验证", idempotencyKey: `start-concurrent-${suffix}`, protocolVersion: "1.0" }),
  }), 201);
  const concurrentId = concurrentStarted.data.explorationId;
  const concurrentResponses = await Promise.all([
    api(`/api/internal/explorations/${concurrentId}`, {
      method: "PUT", headers: internalHeaders,
      body: JSON.stringify({ expectedRevision: 0, content: { ...content, title: "并发修改 A" }, idempotencyKey: `save-concurrent-a-${suffix}` }),
    }),
    api(`/api/internal/explorations/${concurrentId}`, {
      method: "PUT", headers: internalHeaders,
      body: JSON.stringify({ expectedRevision: 0, content: { ...content, title: "并发修改 B" }, idempotencyKey: `save-concurrent-b-${suffix}` }),
    }),
  ]);
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 409]);
  const concurrentDetail = await json<{ data: { currentRevision: number } }>(
    await api(`/api/internal/explorations/${concurrentId}`, { headers: internalHeaders }), 200,
  );
  assert.equal(concurrentDetail.data.currentRevision, 1);
  const abandoned = await json<{ data: { state: string } }>(await api(`/api/internal/explorations/${concurrentId}/abandon`, {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 1, idempotencyKey: `abandon-${suffix}` }),
  }), 200);
  assert.equal(abandoned.data.state, "abandoned");
  const saved = await json<{ data: { revision: number } }>(await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 0, content, idempotencyKey: `save-${suffix}` }),
  }), 200);
  assert.equal(saved.data.revision, 1);
  const freshRegistry = createApp();
  const persisted = await json<{ data: { currentRevision: number } }>(await freshRegistry.request(
    `http://localhost/api/internal/explorations/${explorationId}`,
    { headers: internalHeaders },
  ), 200);
  assert.equal(persisted.data.currentRevision, 1);
  const replay = await json<{ data: { revision: number } }>(await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 0, content, idempotencyKey: `save-${suffix}` }),
  }), 200);
  assert.equal(replay.data.revision, 1);
  const staleSave = await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 0, content, idempotencyKey: `save-stale-${suffix}` }),
  });
  assert.equal(staleSave.status, 409);

  const adminDrafts = await json<{ data: { items: Array<{ id: string; lastSubmittedRevision: number | null }>; total: number } }>(
    await api(`/api/admin/explorations?keyword=${encodeURIComponent(content.title)}&page=1&pageSize=20`, {}, cookie), 200,
  );
  assert(adminDrafts.data.items.some((item) => item.id === explorationId && item.lastSubmittedRevision === null));
  assert(adminDrafts.data.total >= 1);
  assert.equal((await api("/api/admin/explorations?pageSize=101", {}, cookie)).status, 400);
  const auditPage = await json<{ data: { items: Array<{ action: string }>; total: number } }>(
    await api("/api/admin/audit?action=exploration.saved&page=1&pageSize=20", {}, cookie),
    200,
  );
  assert(auditPage.data.items.some((item) => item.action === "exploration.saved"));
  assert(auditPage.data.total >= 1);
  const mine = await json<{ data: { items: Array<{ id: string }> } }>(
    await api("/api/internal/explorations?page=1&pageSize=20", { headers: internalHeaders }), 200,
  );
  assert(mine.data.items.some((item) => item.id === explorationId));

  const second = await db.insert(employees).values({
    phone: `138${phoneSuffix}`,
    name: "Other Employee",
    departmentId: secondDepartmentId,
  }).returning();
  assert(second[0]);
  secondEmployeeId = second[0].id;
  const [secondToken] = await db.insert(employeeTokens).values({
    employeeId: secondEmployeeId,
    name: "isolation",
    tokenHash: `smoke-${randomUUID()}`,
    scopes: ["skills:read", "explorations:read:self", "explorations:write:self"],
    expiresAt: new Date(Date.now() + 60_000),
    issuedBy: admin.id,
  }).returning();
  assert(secondToken);
  const secondHeaders = {
    "Content-Type": "application/json",
    "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN!,
    "X-SkillHive-Employee-Id": secondEmployeeId,
    "X-SkillHive-Token-Id": secondToken.id,
  };
  const secondStarted = await json<{ data: { explorationId: string; rule: { version: string } } }>(
    await api("/api/internal/explorations/start", {
      method: "POST", headers: secondHeaders,
      body: JSON.stringify({ initialProblem: "跨部门全员规则", idempotencyKey: `start-second-${suffix}`, protocolVersion: "1.0" }),
    }), 201,
  );
  assert.equal(secondStarted.data.rule.version, baselineVersion);
  const denied = await api(`/api/internal/explorations/${explorationId}`, {
    headers: secondHeaders,
  });
  assert.equal(denied.status, 404);
  await db.insert(skillDepartmentVisibility).values({ skillId: skill.id, departmentId: firstDepartmentId });
  assert.equal((await api("/api/internal/explorations/start", {
    method: "POST", headers: secondHeaders,
    body: JSON.stringify({ initialProblem: "部门限制应阻止", idempotencyKey: `start-second-denied-${suffix}`, protocolVersion: "1.0" }),
  })).status, 409);
  await json(await api(`/api/internal/explorations/${secondStarted.data.explorationId}`, { headers: secondHeaders }), 200);
  assert.equal((await api(`/api/internal/explorations/${secondStarted.data.explorationId}`, {
    method: "PUT",
    headers: secondHeaders,
    body: JSON.stringify({
      expectedRevision: 0,
      content: { title: "部门权限收回后不得继续写入" },
      idempotencyKey: `save-second-denied-${suffix}`,
    }),
  })).status, 409);

  const submitted = await json<{ data: { requirementId: string; submittedRevision: number } }>(await api(`/api/internal/explorations/${explorationId}/submit`, {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 1, idempotencyKey: `submit-${suffix}` }),
  }), 200);
  assert.equal(submitted.data.submittedRevision, 1);
  const requirementList = await json<{ data: { items: Array<{ id: string }>; total: number } }>(
    await api(`/api/admin/requirements?keyword=${encodeURIComponent(content.title)}&page=1&pageSize=20`, {}, cookie), 200,
  );
  assert(requirementList.data.items.some((item) => item.id === submitted.data.requirementId));
  assert(requirementList.data.total >= 1);
  await json(await api(`/api/admin/requirements/${submitted.data.requirementId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, expectedSubmission: 1, status: "needs_information", publicFeedback: "请确认接口可用性" }),
  }, cookie), 200);
  const employeeDetail = await json<{ data: { reviewStatus: string; publicFeedback: string } }>(
    await api(`/api/internal/explorations/${explorationId}`, { headers: internalHeaders }), 200,
  );
  assert.equal(employeeDetail.data.reviewStatus, "needs_information");
  assert.equal(employeeDetail.data.publicFeedback, "请确认接口可用性");

  const revised = await json<{ data: { revision: number } }>(await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 1, content: { ...content, pendingQuestions: [], summary: `${content.summary} 接口能力已确认。` }, idempotencyKey: `save-2-${suffix}` }),
  }), 200);
  assert.equal(revised.data.revision, 2);
  await json(await api(`/api/internal/explorations/${explorationId}/submit`, {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 2, idempotencyKey: `submit-2-${suffix}` }),
  }), 200);
  const firstSubmission = await json<{ data: { requestedSubmission: {
    submission: number;
    revision: number;
    content: { summary: string };
    reviews: Array<{ publicFeedback: string | null }>;
  } } }>(await api(`/api/internal/explorations/${explorationId}?submission=1`, {
    headers: internalHeaders,
  }), 200);
  assert.equal(firstSubmission.data.requestedSubmission.submission, 1);
  assert.equal(firstSubmission.data.requestedSubmission.revision, 1);
  assert.equal(firstSubmission.data.requestedSubmission.content.summary, content.summary);
  assert(firstSubmission.data.requestedSubmission.reviews.some((review) => review.publicFeedback === "请确认接口可用性"));
  assert.equal((await api(`/api/internal/explorations/${explorationId}?submission=999`, {
    headers: internalHeaders,
  })).status, 404);
  const staleReview = await api(`/api/admin/requirements/${submitted.data.requirementId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost", Host: "localhost" },
    body: JSON.stringify({ expectedRevision: 1, expectedSubmission: 1, status: "accepted", publicFeedback: "旧页面操作" }),
  });
  assert.equal(staleReview.status, 409);
  const requirementDetail = await json<{ data: {
    departmentName: string | null;
    skillVersion: string | null;
    reviews: Array<{ submission: number; publicFeedback: string; reviewerName: string | null }>;
  } }>(
    await api(`/api/admin/requirements/${submitted.data.requirementId}`, {}, cookie), 200,
  );
  assert.equal(requirementDetail.data.departmentName, firstDepartment.name);
  assert.equal(requirementDetail.data.skillVersion, baselineVersion);
  assert(requirementDetail.data.reviews.some((review) =>
    review.submission === 1
    && review.publicFeedback === "请确认接口可用性"
    && review.reviewerName === admin.name));

  const abandonedDraft = await json<{ data: { revision: number } }>(await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({
      expectedRevision: 2,
      content: { ...content, summary: "这份正式提交后的修改应被放弃。" },
      idempotencyKey: `save-abandon-after-submit-${suffix}`,
    }),
  }), 200);
  assert.equal(abandonedDraft.data.revision, 3);
  const beforeAbandon = await json<{ data: { items: Array<{ id: string; hasUnsubmittedChanges: boolean }> } }>(
    await api(`/api/admin/requirements?keyword=${encodeURIComponent(content.title)}&page=1&pageSize=20`, {}, cookie),
    200,
  );
  assert.equal(beforeAbandon.data.items.find((item) => item.id === submitted.data.requirementId)?.hasUnsubmittedChanges, true);
  await json(await api(`/api/internal/explorations/${explorationId}/abandon`, {
    method: "POST", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 3, idempotencyKey: `abandon-after-submit-${suffix}` }),
  }), 200);
  const afterAbandon = await json<{ data: {
    state: string;
    currentRevision: number;
    activeRevision: number;
    activeContent: { summary: string };
  } }>(await api(`/api/internal/explorations/${explorationId}`, { headers: internalHeaders }), 200);
  assert.equal(afterAbandon.data.state, "submitted");
  assert.equal(afterAbandon.data.currentRevision, 3);
  assert.equal(afterAbandon.data.activeRevision, 2);
  assert.equal(afterAbandon.data.activeContent.summary, `${content.summary} 接口能力已确认。`);
  const afterAbandonList = await json<{ data: { items: Array<{ id: string; hasUnsubmittedChanges: boolean }> } }>(
    await api(`/api/admin/requirements?keyword=${encodeURIComponent(content.title)}&page=1&pageSize=20`, {}, cookie),
    200,
  );
  assert.equal(afterAbandonList.data.items.find((item) => item.id === submitted.data.requirementId)?.hasUnsubmittedChanges, false);

  const rotation = await json<{ data: { token: string; id: string } }>(await api(`/api/admin/employees/${employeeId}/tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke rotation", expiresInDays: 1 }),
  }, cookie), 201);
  const rotationIdentity = await json<{ data: { tokenId: string } }>(await api("/api/auth/resolve-pat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Internal-Token": process.env.SKILLHIVE_INTERNAL_TOKEN! },
    body: JSON.stringify({ token: rotation.data.token }),
  }), 200);
  await json(await api(`/api/admin/employees/${employeeId}/tokens/${rotation.data.id}`, {
    method: "DELETE",
  }, cookie), 200);
  assert.equal((await api(`/api/internal/explorations/${explorationId}`, { headers: {
    ...internalHeaders,
    "X-SkillHive-Token-Id": rotationIdentity.data.tokenId,
  } })).status, 401);
  const [expiredToken] = await db.insert(employeeTokens).values({
    employeeId,
    name: "expired",
    tokenHash: `smoke-expired-${randomUUID()}`,
    scopes: ["skills:read", "explorations:read:self", "explorations:write:self"],
    expiresAt: new Date(Date.now() - 1_000),
    issuedBy: admin.id,
  }).returning();
  assert(expiredToken);
  assert.equal((await api(`/api/internal/explorations/${explorationId}`, { headers: {
    ...internalHeaders,
    "X-SkillHive-Token-Id": expiredToken.id,
  } })).status, 401);

  await json(await api(`/api/internal/explorations/${explorationId}`, { headers: internalHeaders }), 200);
  const blockedWrite = await json<{ code: string; retryable: boolean; nextStep: string }>(await api(`/api/internal/explorations/${explorationId}`, {
    method: "PUT", headers: internalHeaders,
    body: JSON.stringify({ expectedRevision: 0, content, idempotencyKey: `save-stale-${suffix}` }),
  }), 409);
  assert.equal(blockedWrite.code, "REVISION_CONFLICT");
  assert.equal(blockedWrite.retryable, false);
  assert.match(blockedWrite.nextStep, /get_exploration/);
  const errorStats = await json<{ data: Array<{ code: string; count: number; lastOccurredAt: string | null }> }>(
    await api("/api/stats/exploration-errors?days=14", {}, cookie),
    200,
  );
  assert(errorStats.data.some((item) => item.code === "REVISION_CONFLICT" && item.count > 0 && item.lastOccurredAt));
  const errorAudit = await json<{ data: { items: Array<{ action: string; metadata: Record<string, unknown> }> } }>(
    await api("/api/admin/audit?action=exploration.error&page=1&pageSize=100", {}, cookie),
    200,
  );
  assert(errorAudit.data.items.some((item) =>
    item.action === "exploration.error"
    && item.metadata.code === "REVISION_CONFLICT"
    && !("error" in item.metadata)
    && !("content" in item.metadata)));

  const concurrentIssues = await Promise.all(Array.from({ length: 11 }, (_, index) => api(
    `/api/admin/employees/${employeeId}/tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Concurrent smoke ${index}`,
        expiresInDays: 1,
        scopes: ["skills:read", "explorations:read:self"],
      }),
    },
    cookie,
  )));
  assert.equal(concurrentIssues.filter((response) => response.status === 201).length, 9);
  assert.equal(concurrentIssues.filter((response) => response.status === 409).length, 2);
  const concurrentToken = await concurrentIssues.find((response) => response.status === 201)!.json() as {
    data: { id: string };
  };
  await json(await api(`/api/admin/employees/${employeeId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "disabled" }),
  }, cookie), 200);
  assert.equal((await api(`/api/internal/explorations/${explorationId}`, { headers: internalHeaders })).status, 401);
  await json(await api(`/api/admin/employees/${employeeId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }),
  }, cookie), 200);
  assert.equal((await api(`/api/internal/explorations/${explorationId}`, { headers: {
    ...internalHeaders,
    "X-SkillHive-Token-Id": concurrentToken.data.id,
  } })).status, 401);
  console.log("WorkBuddy 需求探索端到端 smoke 通过");
} finally {
  if (employeeId) {
    const owned = await db.select({ id: explorations.id }).from(explorations).where(eq(explorations.employeeId, employeeId));
    for (const item of owned) {
      const requirement = await db.query.requirements.findFirst({ where: eq(requirements.explorationId, item.id) });
      if (requirement) await db.delete(requirementReviews).where(eq(requirementReviews.requirementId, requirement.id));
      if (requirement) await db.delete(requirementSubmissions).where(eq(requirementSubmissions.requirementId, requirement.id));
      if (requirement) await db.delete(requirements).where(eq(requirements.id, requirement.id));
      await db.delete(explorationAuditEvents).where(eq(explorationAuditEvents.explorationId, item.id));
      await db.delete(explorationRevisions).where(eq(explorationRevisions.explorationId, item.id));
      await db.delete(explorations).where(eq(explorations.id, item.id));
    }
    await db.delete(explorationIdempotency).where(eq(explorationIdempotency.employeeId, employeeId));
    await db.delete(explorationAuditEvents).where(eq(explorationAuditEvents.actorId, employeeId));
    await db.delete(employeeTokens).where(eq(employeeTokens.employeeId, employeeId));
    await db.delete(employees).where(eq(employees.id, employeeId));
  }
  if (secondEmployeeId) {
    const owned = await db.select({ id: explorations.id }).from(explorations).where(eq(explorations.employeeId, secondEmployeeId));
    for (const item of owned) {
      const requirement = await db.query.requirements.findFirst({ where: eq(requirements.explorationId, item.id) });
      if (requirement) await db.delete(requirementReviews).where(eq(requirementReviews.requirementId, requirement.id));
      if (requirement) await db.delete(requirementSubmissions).where(eq(requirementSubmissions.requirementId, requirement.id));
      if (requirement) await db.delete(requirements).where(eq(requirements.id, requirement.id));
      await db.delete(explorationAuditEvents).where(eq(explorationAuditEvents.explorationId, item.id));
      await db.delete(explorationRevisions).where(eq(explorationRevisions.explorationId, item.id));
      await db.delete(explorations).where(eq(explorations.id, item.id));
    }
    await db.delete(explorationIdempotency).where(eq(explorationIdempotency.employeeId, secondEmployeeId));
    await db.delete(explorationAuditEvents).where(eq(explorationAuditEvents.actorId, secondEmployeeId));
    await db.delete(employeeTokens).where(eq(employeeTokens.employeeId, secondEmployeeId));
    await db.delete(employees).where(eq(employees.id, secondEmployeeId));
  }
  await db.delete(explorationPolicies).where(eq(explorationPolicies.key, "requirement-exploration"));
  if (skillId) await db.delete(skills).where(eq(skills.id, skillId));
  if (incompatibleApplicationSkillId) {
    await db.delete(skills).where(eq(skills.id, incompatibleApplicationSkillId));
  }
  if (applicationSkillIdCreatedBySmoke) {
    await db.delete(skills).where(eq(skills.id, applicationSkillIdCreatedBySmoke));
  }
  if (adminId) await db.delete(explorationAuditEvents).where(eq(explorationAuditEvents.actorId, adminId));
  if (adminId) await db.delete(users).where(eq(users.id, adminId));
  if (memberId) await db.delete(users).where(eq(users.id, memberId));
  if (firstDepartmentId) await db.delete(departments).where(eq(departments.id, firstDepartmentId));
  if (secondDepartmentId) await db.delete(departments).where(eq(departments.id, secondDepartmentId));
}
