import { Hono } from "hono";
import {
  applicationDiscoveryConfigs,
  db,
  explorationAuditEvents,
  explorationPolicies,
  skills,
  skillVersionFiles,
  skillVersions,
} from "@skillhive/db";
import { parseSkillMd } from "@skillhive/skill-schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAdmin, type SessionUser } from "../auth.js";
import {
  loadRequirementExplorationBaseline,
  REQUIREMENT_EXPLORATION_APP_KEY,
  requirementExplorationApplication,
} from "../built-in-applications.js";
import { notifyPromptsChanged } from "../prompt-notifications.js";
import { validateTriggerPhrases } from "../discovery-config.js";

type AppEnv = { Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

class ApplicationSkillTypeConflictError extends Error {}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

async function requirementExplorationDetail() {
  const [policy, discoveryConfig] = await Promise.all([
    db.query.explorationPolicies.findFirst({
      where: eq(explorationPolicies.key, REQUIREMENT_EXPLORATION_APP_KEY),
    }),
    db.query.applicationDiscoveryConfigs.findFirst({
      where: eq(applicationDiscoveryConfigs.applicationKey, REQUIREMENT_EXPLORATION_APP_KEY),
    }),
  ]);
  const triggerPhrases = discoveryConfig?.triggerPhrases
    ?? requirementExplorationApplication.defaultTriggerPhrases;
  const applicationSkills = await db.select().from(skills)
    .where(eq(skills.skillType, "application"))
    .orderBy(desc(skills.updatedAt));
  const skill = applicationSkills.find((item) => item.id === policy?.skillId) ?? applicationSkills[0];
  if (!skill) {
    return {
      ...requirementExplorationApplication,
      triggerPhrases,
      initialized: false,
      skill: null,
      policy: policy ?? null,
    };
  }

  const versions = await db.select({
    id: skillVersions.id,
    version: skillVersions.version,
    changelog: skillVersions.changelog,
    publishedAt: skillVersions.createdAt,
  }).from(skillVersions).where(eq(skillVersions.skillId, skill.id)).orderBy(desc(skillVersions.createdAt));
  const latestRow = versions[0]
    ? await db.query.skillVersions.findFirst({ where: eq(skillVersions.id, versions[0].id) })
    : null;
  const files = latestRow
    ? await db.select({ path: skillVersionFiles.path, size: skillVersionFiles.size })
      .from(skillVersionFiles).where(eq(skillVersionFiles.versionId, latestRow.id))
    : [];
  let latestVersion: null | {
    id: string;
    version: string;
    description: string;
    body: string;
    changelog: string;
    publishedAt: Date;
    files: typeof files;
  } = null;
  if (latestRow) {
    const parsed = parseSkillMd(latestRow.content);
    latestVersion = {
      id: latestRow.id,
      version: latestRow.version,
      description: parsed.frontmatter.description,
      body: parsed.body,
      changelog: latestRow.changelog,
      publishedAt: latestRow.createdAt,
      files,
    };
  }
  return {
    ...requirementExplorationApplication,
    triggerPhrases,
    initialized: true,
    skill: {
      id: skill.id,
      slug: skill.slug,
      latestVersion,
      versions,
    },
    policy: policy ?? null,
  };
}

app.get("/", async (c) => {
  const detail = await requirementExplorationDetail();
  const activeVersion = detail.skill?.versions.find((item) => item.id === detail.policy?.skillVersionId)?.version ?? null;
  const activeVersionBlocked = Boolean(
    detail.policy?.skillVersionId
    && detail.policy.blockedSkillVersionIds.includes(detail.policy.skillVersionId),
  );
  return c.json({ data: [{
    key: detail.key,
    name: detail.name,
    description: detail.description,
    type: detail.type,
    initialized: detail.initialized,
    enabled: Boolean(detail.policy?.enabled && activeVersion && !activeVersionBlocked),
    activeVersion,
  }] });
});

app.get(`/${REQUIREMENT_EXPLORATION_APP_KEY}`, async (c) =>
  c.json({ data: await requirementExplorationDetail() }));

app.put(
  `/${REQUIREMENT_EXPLORATION_APP_KEY}/triggers`,
  validateTriggerPhrases,
  async (c) => {
    const actor = c.get("user");
    const { triggerPhrases } = c.req.valid("json");
    await db.transaction(async (tx) => {
      await tx.insert(applicationDiscoveryConfigs).values({
        applicationKey: REQUIREMENT_EXPLORATION_APP_KEY,
        triggerPhrases,
        updatedBy: actor.id,
      }).onConflictDoUpdate({
        target: applicationDiscoveryConfigs.applicationKey,
        set: { triggerPhrases, updatedBy: actor.id, updatedAt: new Date() },
      });
      await tx.insert(explorationAuditEvents).values({
        actorType: "admin",
        actorId: actor.id,
        action: "application.triggers_updated",
        metadata: { applicationKey: REQUIREMENT_EXPLORATION_APP_KEY, triggerPhrases },
      });
    });
    return c.json({ data: { triggerPhrases } });
  },
);

app.post(`/${REQUIREMENT_EXPLORATION_APP_KEY}/initialize`, async (c) => {
  const actor = c.get("user");
  const baseline = await loadRequirementExplorationBaseline();
  const parsed = parseSkillMd(baseline.content);
  const version = parsed.frontmatter.version ?? "1.0.0";
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${REQUIREMENT_EXPLORATION_APP_KEY}, 0))`);
      let skill = await tx.query.skills.findFirst({
        where: and(
          eq(skills.skillType, "application"),
          eq(skills.slug, REQUIREMENT_EXPLORATION_APP_KEY),
        ),
      });
      if (!skill) {
        const occupied = await tx.query.skills.findFirst({
          where: eq(skills.slug, REQUIREMENT_EXPLORATION_APP_KEY),
        });
        if (occupied) throw new ApplicationSkillTypeConflictError();
        [skill] = await tx.insert(skills).values({
          slug: REQUIREMENT_EXPLORATION_APP_KEY,
          name: "需求探索规则",
          summary: parsed.frontmatter.description,
          category: parsed.frontmatter.category ?? "产品",
          skillType: "application",
          status: "published",
          ownerId: actor.id,
        }).returning();
      }
      if (!skill) throw new Error("初始化需求探索规则失败");
      const existingVersion = await tx.query.skillVersions.findFirst({ where: and(
        eq(skillVersions.skillId, skill.id),
        eq(skillVersions.version, version),
      ) });
      if (!existingVersion) {
        const [createdVersion] = await tx.insert(skillVersions).values({
          skillId: skill.id,
          version,
          content: baseline.content,
          changelog: "初始化内置需求探索规则",
          publishedBy: actor.id,
        }).returning();
        if (!createdVersion) throw new Error("初始化需求探索版本失败");
        await tx.insert(skillVersionFiles).values(baseline.files.map((file) => ({
          versionId: createdVersion.id,
          path: file.path,
          contentBase64: file.contentBase64,
          size: decodedBase64Size(file.contentBase64),
        })));
        await tx.insert(explorationAuditEvents).values({
          actorType: "admin",
          actorId: actor.id,
          action: "application.skill_initialized",
          metadata: { applicationKey: REQUIREMENT_EXPLORATION_APP_KEY, version },
        });
      }
    });
  } catch (error) {
    if (error instanceof ApplicationSkillTypeConflictError) {
      return c.json({ error: "同名普通 Skill 已存在，不能转换为应用 Skill；请先处理标识冲突" }, 409);
    }
    throw error;
  }
  notifyPromptsChanged();
  return c.json({ data: await requirementExplorationDetail() });
});

export default app;
