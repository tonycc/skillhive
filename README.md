# SkillHive（技能蜂巢）

[![CI](https://github.com/tonycc/skillhive/actions/workflows/ci.yml/badge.svg)](https://github.com/tonycc/skillhive/actions/workflows/ci.yml)

> 企业内部 AI Skill 中枢：IT 集中开发与治理，全员通过 MCP 客户端（如腾讯 WorkBuddy）零配置使用。

## 项目背景

企业内员工编写的 AI Skill（提示词模板、工作流技能）散落在各自本地，无法共享、无法复用、无人维护。
SkillHive 提供"集中发布 + 统一分发 + 数据反馈"的完整闭环：

```
IT 部门（发布者）                     全体员工（消费者）
┌──────────────────┐          ┌────────────────────────┐
│ CLI 发布 / 版本管理 │          │ Web Console：           │
│ Git 工作流 / 灰度   │          │  市场浏览/搜索/评分      │
└────────┬─────────┘          │  需求许愿/投票           │
         ▼                    └───────────┬────────────┘
┌─────────────────────────────────────────▼────────────┐
│              SkillHive Registry (Hono API)            │
│     版本管理 / RBAC / 灰度发布 / 埋点统计 / 需求池      │
└──────────────────────┬────────────────────────────────┘
                       ▼
            MCP Server (prompts + tools)
                       ▼
        WorkBuddy / Claude Code / 任意 MCP 客户端
```

## 仓库结构（pnpm monorepo）

| 目录 | 说明 |
|---|---|
| `apps/registry` | 核心注册中心 API（Hono + Drizzle + PostgreSQL） |
| `apps/mcp-server` | MCP 协议服务，向 Agent 客户端暴露 skill |
| `apps/console` | Web 控制台（Vue 3 + Vite + Element Plus），面向全体员工的技能市场 |
| `apps/cli` | `skillhive` 命令行工具，IT 发布 skill 使用 |
| `packages/db` | Drizzle schema 与数据库客户端 |
| `packages/skill-schema` | SKILL.md 格式的解析与校验（Zod） |

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 初始化数据库迁移（首次）
docker compose up -d postgres && pnpm db:migrate

# 3. 一键启动全部服务（数据库 + Registry + MCP Server + Console）
pnpm dev
```

启动后访问：

| 服务 | 地址 |
|---|---|
| Console 技能市场 | http://localhost:3000 |
| 数据看板 | http://localhost:3000/stats |
| Registry API | http://localhost:3001/health |
| MCP Server（WorkBuddy 连 /sse） | http://localhost:3100/health |

也可以按需单独启动：`pnpm dev:registry` / `pnpm dev:mcp` / `pnpm dev:console`。

## 路线图

- [x] 项目骨架与数据模型
- [x] Skill 发布 / 版本管理 / CLI（鉴权待接入）
- [x] 数据库迁移与发布持久化闭环
- [ ] MCP Server（tools + prompts 原语）
- [x] Web Console 技能市场（Vue 3 + Element Plus）
- [x] Web 端发布 skill（表单组装 / 上传 SKILL.md）
- [x] CLI sync 增量同步到本地技能目录（WorkBuddy / 菜单分发通道）
- [x] 数据看板（概览/趋势/技能排行）
- [ ] 企业微信登录 + 部门级可见性
- [ ] 调用埋点与数据看板
- [ ] 需求许愿与投票
- [ ] 语义搜索（Python sidecar + pgvector）

## 许可证

[MIT](./LICENSE)
