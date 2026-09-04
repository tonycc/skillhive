# SkillHive（技能蜂巢）

[![CI](https://github.com/tonycc/skillhive/actions/workflows/ci.yml/badge.svg)](https://github.com/tonycc/skillhive/actions/workflows/ci.yml)

> 企业内部 AI Skill 中枢：管理员集中运营，员工通过 MCP 客户端（如腾讯 WorkBuddy）使用企业技能并归集需求探索成果。

## 项目背景

企业内员工编写的 AI Skill（提示词模板、工作流技能）散落在各自本地，无法共享、无法复用、无人维护。
SkillHive 提供"集中发布 + 统一分发 + 数据反馈"的完整闭环：

```
管理员（Web Console）                 员工（仅 WorkBuddy）
┌────────────────────┐        ┌────────────────────────┐
│ Skill / 规则版本管理 │        │ 连接器 + 企业 Skill 助手 │
│ 员工、令牌、草稿、评审 │        │ 检索 / 执行 / 应用流程   │
└─────────┬──────────┘        └───────────┬────────────┘
          ▼                               ▼
┌──────────────────────────────────────────────────────┐
│              SkillHive Registry (Hono API)           │
│ 身份隔离 / 修订版本 / 正式快照 / 评审反馈 / 操作审计   │
└────────────────────────┬─────────────────────────────┘
                         ▼
              MCP Server (prompts + tools)
```

## 仓库结构（pnpm monorepo）

| 目录 | 说明 |
|---|---|
| `apps/registry` | 核心注册中心 API（Hono + Drizzle + PostgreSQL） |
| `apps/mcp-server` | MCP 协议服务，向 Agent 客户端暴露 skill |
| `apps/console` | 管理员专用运营平台，区分内置应用、普通 Skill 与连接器（Vue 3 + Vite + Element Plus） |
| `apps/cli` | `skillhive` 命令行工具，IT 发布 Skill 使用 |
| `packages/db` | Drizzle schema 与数据库客户端 |
| `packages/skill-schema` | SKILL.md 格式的解析与校验（Zod） |
| `integrations/workbuddy` | WorkBuddy 官方连接器源文件、企业 Skill 助手、应用快捷入口和安全构建脚本 |

## 产品方案

- [文档索引](docs/README.md)：产品基线、运行手册、验收证据和维护边界。
- [WorkBuddy 官方连接器与需求探索产品方案](docs/product/workbuddy-connector-requirement-exploration.md)：WorkBuddy 员工入口、管理员专用 Web、MCP + Skill 接入及需求结果归集设计。
- [WorkBuddy 需求探索上线与回退手册](docs/operations/workbuddy-requirement-exploration-runbook.md)：部署、规则激活、员工发放、验证、清理和故障回退步骤。
- [MVP 验收追踪表](docs/operations/workbuddy-requirement-exploration-acceptance.md)：A01—A20 的仓库证据、外部证据与剩余门槛。
- [连接器提交与实测记录](docs/operations/workbuddy-connector-submission-record.md)：每个正式连接器版本需要单独填写的构建、平台审核和真实客户端证据模板。
- [连接器构建说明](integrations/workbuddy/README.md)：从可审计源目录生成本地审核包及校验摘要。

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 创建本地配置，并为两个密钥填入各自至少 32 字符的随机值
cp .env.example .env

# 3. 初始化数据库迁移（首次）
docker compose up -d postgres && pnpm db:migrate

# 4. 一键启动全部服务（数据库 + Registry + MCP Server + Console）
pnpm dev
```

启动后访问：

| 服务 | 地址 |
|---|---|
| 管理员运营平台 | http://localhost:3000 |
| 数据看板 | http://localhost:3000/stats |
| Registry API | http://localhost:3001/health |
| MCP Server（官方连接器使用 /mcp） | http://localhost:3100/health |

也可以按需单独启动：`pnpm dev:registry` / `pnpm dev:mcp` / `pnpm dev:console`。

员工不能登录 Web 或自助生成令牌。管理员在“员工与令牌”中完成员工建档并定向发放专属令牌。本地 stdio 兼容接入设置
`SKILLHIVE_PAT=sk-...` 与 `SKILLHIVE_INTERNAL_TOKEN` 后运行 `pnpm --filter
@skillhive/mcp-server dev:stdio`。`SKILLHIVE_PAT` 必须使用管理员在员工档案中发放的员工连接器令牌。SSE 客户端必须在 `/sse` 和后续 `/messages`
请求中都携带同一枚 `Authorization: Bearer <员工连接器令牌>`；这能防止泄漏的 sessionId 被复用。
Web 登录只返回 HttpOnly Cookie；CLI 会显式请求 Bearer 会话，避免浏览器脚本拿到 JWT。

## 生产部署（试运营）

全栈 docker-compose（postgres + registry + mcp-server + console/nginx）：

```bash
# 1. 准备配置（参考 .env.example）：数据库密码、会话密钥、内部令牌、首次启动引导的管理员账号
cp .env.example .env && vi .env

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build
```

生产环境会拒绝空密码、短于 32 字符的会话密钥或内部令牌；WorkBuddy 上线门禁还会拒绝
低复杂度或复用密钥。端口只绑定 `127.0.0.1`，由服务器前的企业 HTTPS 反向代理对外提供服务；
当前方案不允许把对应的 `*_BIND_ADDRESS` 改为局域网地址或 `0.0.0.0`。Console 会在同域代理
`/sse`、`/messages` 与 `/mcp`，因此默认 `PUBLIC_MCP_URL=/sse` 不会降级为明文跨域连接。
`PUBLIC_MCP_URL` 仍用于兼容 SSE 客户端且只接受根路径 `/sse`；官方连接器独立使用同域
`/mcp` Streamable HTTP 入口。带路径前缀、查询参数或片段的 SSE 地址会在 MCP 启动时被拒绝，
避免生成无法投递 `/messages` 的半可用配置。
MCP 在生产模式会拒绝非 HTTPS 的外部请求；只有明确评估过受控明文网络后才可设置
`SKILLHIVE_ALLOW_HTTP=1`。前置 TLS 代理必须覆盖（不能直接透传客户端提供的）
`X-Forwarded-Proto: https` 与 `X-Forwarded-For`，并保持原始 `Host`；不要将 Console、
Registry 或 MCP 的容器端口直接暴露到不受信网络。

启动后入口：

| 服务 | 默认端口 | 用途 |
|---|---|---|
| Console | https://你的企业域名 | 管理员运营入口（nginx 托管 + /api 反代） |
| Registry | https://你的企业域名/api | CLI publish 入口（也可经独立受控域名） |
| MCP Server | https://你的企业域名/mcp | WorkBuddy 官方连接器入口（员工专属 Bearer 鉴权） |

registry 首次启动会自动执行数据库迁移；在 `.env` 中设置 `SKILLHIVE_ADMIN_EMAIL` / `SKILLHIVE_ADMIN_PASSWORD` 可引导创建管理员账号（验证后建议移除）。

## 自动部署（GitHub Actions → 阿里云 ECS）

推送 `main` 分支即自动部署：完整 `pnpm check` 与生产依赖审计 → 构建带 commit 标签的镜像 → SCP 直传服务器 → 在切换服务前校验服务器生产配置 → Compose 等待全部健康检查。新版本不健康时流水线恢复原镜像并失败退出。工作流见 `.github/workflows/deploy.yml`，不依赖镜像仓库，只需在仓库 Secrets 配置 `ECS_HOST` / `ECS_USER` / `ECS_SSH_KEY` 三项（详见文件头注释），服务器按上一节完成一次性准备即可。
管理员可通过 `PATCH /api/auth/users/:id/status`（请求体 `{ "disabled": true }`）停用管理或 CLI 账号；
也可在服务器上运行 `pnpm --filter @skillhive/registry create-user -- --email <账号> --disable`
执行离线停用。停用会立即失效该账号的登录会话，并使遗留个人 PAT 数据失效；系统不再提供个人 PAT 签发接口。
员工连接器令牌应在“员工与令牌”中单独吊销，或通过停用员工一次性失效。
从旧版本升级前请先备份数据库：`0005` 会在历史重复版本/资源文件中保留最新一条，
然后建立唯一约束；`0006` 会增加账号停用时间字段；`0007`—`0016` 完成员工连接器身份、探索修订、正式需求快照、历史评审、清理关联、规则版本熔断、审计，以及普通 Skill/应用 Skill 的最终用途分类。中间迁移会移除未采用的告知、交付跟踪、历史账号映射和应用归属字段。旧匿名投票账号不会再新增，历史数据可按企业留存策略另行归档。

## 质量校验

提交前运行 `pnpm check`，会依次执行 ESLint、全 workspace 类型检查、单元测试、WorkBuddy 连接器源文件校验和
可直接启动的生产构建。数据库运行时可用
`pnpm smoke:workbuddy` 验证管理员、员工令牌、草稿、隔离、幂等、提交和评审闭环；`pnpm load:workbuddy`
通过真实 Streamable HTTP `/mcp` 地址执行读/写并发性能验收。真实企业 HTTPS 地址确认后，按
[连接器构建说明](integrations/workbuddy/README.md) 生成待审核目录。部署前使用 `pnpm validate:production -- --env-file .env --phase deploy` 校验生产配置；全员发布前改用 `--phase launch`。CI 还会检查生产依赖高危漏洞与 Compose 配置。

## 许可证

[MIT](./LICENSE)
