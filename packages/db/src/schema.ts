import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

// ---------- 枚举 ----------

/** 用户角色：admin=管理员 publisher=发布者(IT) member=普通员工 */
export const userRoleEnum = pgEnum("user_role", ["admin", "publisher", "member"]);

/** skill 生命周期状态：draft 草稿 → beta 灰度 → published 正式 → archived 下架 */
export const skillStatusEnum = pgEnum("skill_status", [
  "draft",
  "beta",
  "published",
  "archived",
]);

/** Skill 用途类型：ordinary 可被企业助手检索，application 仅供应用选择。 */
export const skillTypeEnum = pgEnum("skill_type", ["ordinary", "application"]);

/** 需求许愿状态 */
export const requestStatusEnum = pgEnum("request_status", [
  "open",
  "planned",
  "done",
  "rejected",
]);

/** WorkBuddy 连接器员工状态。员工不是 Console 登录用户。 */
export const employeeStatusEnum = pgEnum("employee_status", ["active", "disabled"]);


export const explorationStateEnum = pgEnum("exploration_state", [
  "discussing",
  "submitted",
  "editing",
  "abandoned",
]);

export const requirementReviewStatusEnum = pgEnum("requirement_review_status", [
  "pending_review",
  "needs_information",
  "in_review",
  "accepted",
  "deferred",
  "rejected",
]);

// ---------- 组织与用户 ----------

export const departments = pgTable("departments", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 128 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 256 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  /** scrypt 密码哈希（scrypt:salt:hash，base64）；为 null 的账号不可登录 */
  passwordHash: varchar("password_hash", { length: 256 }),
  /** 会话版本；修改密码时递增，使此前签发的 JWT 立即失效 */
  sessionVersion: integer("session_version").notNull().default(0),
  /** 非空表示账号已停用；所有登录态与 PAT 身份解析都必须拒绝 */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  role: userRoleEnum("role").notNull().default("member"),
  departmentId: uuid("department_id").references(() => departments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Skill 与版本 ----------

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 全局唯一标识，如 "weekly-report" */
    slug: varchar("slug", { length: 128 }).notNull().unique(),
    name: varchar("name", { length: 256 }).notNull(),
    summary: varchar("summary", { length: 512 }).notNull().default(""),
    /** 分类，如：研发 / 市场 / 财务 / 通用 */
    category: varchar("category", { length: 64 }).notNull().default("通用"),
    /** 用途分类与具体应用解耦；应用关系由各应用的运行策略维护。 */
    skillType: skillTypeEnum("skill_type").notNull().default("ordinary"),
    status: skillStatusEnum("status").notNull().default("draft"),
    /** 图标 URL（来自 frontmatter icon 字段），供客户端展示 */
    iconUrl: varchar("icon_url", { length: 1024 }),
    ownerId: uuid("owner_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("skills_status_idx").on(t.status),
    index("skills_type_idx").on(t.skillType),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /** 语义化版本号，如 1.2.0 */
    version: varchar("version", { length: 32 }).notNull(),
    /** SKILL.md 全文（frontmatter + 正文） */
    content: text("content").notNull(),
    changelog: text("changelog").notNull().default(""),
    publishedBy: uuid("published_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_versions_skill_idx").on(t.skillId),
    uniqueIndex("skill_versions_skill_version_unique").on(t.skillId, t.version),
  ],
);

/** 技能包资源文件（scripts/ references/ assets/），随版本不可变存储 */
export const skillVersionFiles = pgTable(
  "skill_version_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    /** 相对技能包根目录的路径，如 references/policy.md */
    path: varchar("path", { length: 512 }).notNull(),
    /** base64 编码内容（文本与二进制统一存储） */
    contentBase64: text("content_base64").notNull(),
    /** 原始字节数（解码前） */
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_version_files_version_idx").on(t.versionId),
    uniqueIndex("skill_version_files_version_path_unique").on(t.versionId, t.path),
  ],
);

// ---------- 历史用户个人 PAT（已不用于 MCP，仅保留失效和数据兼容） ----------

export const userTokens = pgTable(
  "user_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 备注，如“工作 Mac 的 WorkBuddy” */
    name: varchar("name", { length: 128 }).notNull().default(""),
    /** 令牌哈希（sha256）；明文仅创建时返回一次，服务端不存明文 */
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 吊销时间；非 null 即失效 */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("user_tokens_user_idx").on(t.userId)],
);

// ---------- WorkBuddy 官方连接器身份 ----------

/**
 * 员工档案与 Console 用户彻底分离：员工只在 WorkBuddy 中使用连接器，不能登录管理端。
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 现有员工迁移期间允许为空；新建和编辑员工时由 API 强制填写。 */
    phone: varchar("phone", { length: 16 }).unique(),
    name: varchar("name", { length: 128 }).notNull(),
    email: varchar("email", { length: 256 }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    status: employeeStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("employees_email_unique").on(t.email),
    index("employees_department_idx").on(t.departmentId),
  ],
);

/** 由管理员发放给单个员工的 MCP Bearer 令牌；明文只在创建时返回一次。 */
export const employeeTokens = pgTable(
  "employee_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull().default("WorkBuddy"),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("employee_tokens_employee_idx").on(t.employeeId)],
);

/** 需求探索入口当前启用的 skill 版本；开始探索后会锁定到具体版本。 */
export const explorationPolicies = pgTable("exploration_policies", {
  key: varchar("key", { length: 64 }).primaryKey(),
  skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
  skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(false),
  /** 被紧急隔离的规则版本：历史记录仍可读，但不能继续保存、提交或放弃。 */
  blockedSkillVersionIds: jsonb("blocked_skill_version_ids").$type<string[]>().notNull().default([]),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- 需求探索、正式提交与审核 ----------

export const explorations = pgTable(
  "explorations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    number: varchar("number", { length: 40 }).notNull().unique(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    ruleContentHash: varchar("rule_content_hash", { length: 64 }),
    /** 启动时锁定的规则正文与资源快照，避免后续版本清理破坏历史可恢复性。 */
    ruleSnapshot: jsonb("rule_snapshot"),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    title: varchar("title", { length: 128 }).notNull().default("未命名需求探索"),
    state: explorationStateEnum("state").notNull().default("discussing"),
    currentRevision: integer("current_revision").notNull().default(0),
    lastSubmittedRevision: integer("last_submitted_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  },
  (t) => [
    index("explorations_employee_updated_idx").on(t.employeeId, t.updatedAt),
    index("explorations_state_updated_idx").on(t.state, t.updatedAt),
  ],
);

export const explorationRevisions = pgTable(
  "exploration_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    content: jsonb("content").notNull(),
    createdByTokenId: uuid("created_by_token_id").references(() => employeeTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("exploration_revisions_number_unique").on(t.explorationId, t.revision),
    index("exploration_revisions_exploration_idx").on(t.explorationId, t.createdAt),
  ],
);

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    number: varchar("number", { length: 40 }).notNull().unique(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id, { onDelete: "restrict" })
      .unique(),
    reviewStatus: requirementReviewStatusEnum("review_status").notNull().default("pending_review"),
    currentSubmission: integer("current_submission").notNull().default(1),
    reviewRevision: integer("review_revision").notNull().default(0),
    publicFeedback: text("public_feedback"),
    internalNote: text("internal_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("requirements_status_updated_idx").on(t.reviewStatus, t.updatedAt)],
);

/** 每次正式提交都固定指向一个不可变的探索修订。 */
export const requirementSubmissions = pgTable(
  "requirement_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    explorationRevisionId: uuid("exploration_revision_id")
      .notNull()
      .references(() => explorationRevisions.id, { onDelete: "restrict" }),
    submission: integer("submission").notNull(),
    submittedByTokenId: uuid("submitted_by_token_id").references(() => employeeTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("requirement_submissions_number_unique").on(t.requirementId, t.submission),
    uniqueIndex("requirement_submissions_revision_unique").on(t.explorationRevisionId),
  ],
);

/** 评审采用追加历史；requirements 只保存当前投影，不能覆盖旧提交意见。 */
export const requirementReviews = pgTable(
  "requirement_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => requirements.id, { onDelete: "cascade" }),
    submission: integer("submission").notNull(),
    reviewRevision: integer("review_revision").notNull(),
    status: requirementReviewStatusEnum("status").notNull(),
    publicFeedback: text("public_feedback"),
    internalNote: text("internal_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("requirement_reviews_revision_unique").on(t.requirementId, t.reviewRevision),
    index("requirement_reviews_requirement_idx").on(t.requirementId, t.createdAt),
  ],
);

/** 员工写操作的幂等结果；相同 key 只能重放同一请求。 */
export const explorationIdempotency = pgTable(
  "exploration_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    explorationId: uuid("exploration_id").references(() => explorations.id, { onDelete: "cascade" }),
    operation: varchar("operation", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    response: jsonb("response").notNull(),
    statusCode: integer("status_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("exploration_idempotency_key_unique").on(t.employeeId, t.operation, t.key),
    index("exploration_idempotency_expiry_idx").on(t.expiresAt),
  ],
);

export const explorationAuditEvents = pgTable(
  "exploration_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: uuid("actor_id"),
    action: varchar("action", { length: 64 }).notNull(),
    explorationId: uuid("exploration_id").references(() => explorations.id, {
      onDelete: "set null",
    }),
    requirementId: uuid("requirement_id").references(() => requirements.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("exploration_audit_time_idx").on(t.createdAt)],
);

/** 部门级可见性（空表记录 = 全员可见） */
export const skillDepartmentVisibility = pgTable(
  "skill_department_visibility",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.departmentId] })],
);

// ---------- 需求许愿与投票 ----------

export const skillRequests = pgTable("skill_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 256 }).notNull(),
  description: text("description").notNull().default(""),
  status: requestStatusEnum("status").notNull().default("open"),
  requesterId: uuid("requester_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skillRequestVotes = pgTable(
  "skill_request_votes",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => skillRequests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] })],
);

// ---------- 调用埋点 ----------

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** 来源客户端，如 workbuddy / claude-code / cli */
    client: varchar("client", { length: 64 }).notNull().default("unknown"),
    /** 事件类型：view / invoke / favorite / rate */
    event: varchar("event", { length: 32 }).notNull(),
    /** 评分事件的分值（1-5），其余事件为空 */
    score: varchar("score", { length: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_events_skill_time_idx").on(t.skillId, t.createdAt)],
);
