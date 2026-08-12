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

/** 需求许愿状态 */
export const requestStatusEnum = pgEnum("request_status", [
  "open",
  "planned",
  "done",
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
  (t) => [index("skills_status_idx").on(t.status)],
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
  (t) => [index("skill_versions_skill_idx").on(t.skillId)],
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
  (t) => [index("skill_version_files_version_idx").on(t.versionId)],
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
