import { Hono } from "hono";
import {
  applicationDiscoveryConfigs,
  db,
  explorationPolicies,
  skillDepartmentVisibility,
  skills,
  skillVersions,
} from "@skillhive/db";
import { and, eq } from "drizzle-orm";
import {
  requireInternalToken,
  resolveInternalEmployee,
  type InternalEmployeeIdentity,
} from "../auth.js";
import {
  REQUIREMENT_EXPLORATION_APP_KEY,
  requirementExplorationApplication,
} from "../built-in-applications.js";

type InternalApplicationsEnv = { Variables: { employee: InternalEmployeeIdentity } };
const app = new Hono<InternalApplicationsEnv>();

app.use("*", requireInternalToken, async (c, next) => {
  const employee = await resolveInternalEmployee(c);
  if (!employee) return c.json({ error: "员工身份或接入令牌已失效" }, 401);
  if (!employee.scopes.includes("skills:read")) {
    return c.json({ error: "令牌没有企业能力读取权限" }, 403);
  }
  c.set("employee", employee);
  await next();
});

app.get("/", async (c) => {
  const employee = c.get("employee");
  const requiredScopes = ["skills:read", "explorations:read:self", "explorations:write:self"];
  if (!requiredScopes.every((scope) => employee.scopes.includes(scope))) return c.json({ data: [] });

  const policy = await db.query.explorationPolicies.findFirst({
    where: eq(explorationPolicies.key, REQUIREMENT_EXPLORATION_APP_KEY),
  });
  if (!policy?.enabled || !policy.skillId || !policy.skillVersionId) return c.json({ data: [] });
  if (policy.blockedSkillVersionIds.includes(policy.skillVersionId)) return c.json({ data: [] });

  const active = await db.select({
    skillId: skills.id,
    versionId: skillVersions.id,
  }).from(skills).innerJoin(skillVersions, and(
    eq(skillVersions.id, policy.skillVersionId),
    eq(skillVersions.skillId, skills.id),
  )).where(and(
    eq(skills.id, policy.skillId),
    eq(skills.status, "published"),
    eq(skills.skillType, "application"),
  )).limit(1);
  if (!active[0]) return c.json({ data: [] });

  const discoveryConfig = await db.query.applicationDiscoveryConfigs.findFirst({
    where: eq(applicationDiscoveryConfigs.applicationKey, REQUIREMENT_EXPLORATION_APP_KEY),
  });

  const visibility = await db.select({ departmentId: skillDepartmentVisibility.departmentId })
    .from(skillDepartmentVisibility)
    .where(eq(skillDepartmentVisibility.skillId, active[0].skillId));
  if (
    visibility.length > 0
    && (employee.departmentId === null
      || !visibility.some((item) => item.departmentId === employee.departmentId))
  ) return c.json({ data: [] });

  const triggerPhrases = discoveryConfig?.triggerPhrases
    ?? requirementExplorationApplication.defaultTriggerPhrases;

  return c.json({ data: [{
    key: requirementExplorationApplication.key,
    name: requirementExplorationApplication.name,
    summary: requirementExplorationApplication.description,
    category: "产品",
    triggerPhrases,
    /** 兼容尚未升级、仍读取 keywords 的 MCP Server。 */
    keywords: triggerPhrases,
    entryType: "application",
    applicationKey: requirementExplorationApplication.key,
    entryTool: "start_exploration",
    resumeTool: "get_exploration",
  }] });
});

export default app;
