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
| Console 技能市场 | http://localhost:3000 |
| 数据看板 | http://localhost:3000/stats |
| Registry API | http://localhost:3001/health |
| MCP Server（WorkBuddy 连 /sse） | http://localhost:3100/health |

也可以按需单独启动：`pnpm dev:registry` / `pnpm dev:mcp` / `pnpm dev:console`。

本地 stdio 接入同样按员工身份过滤技能：先在 Console 生成 PAT，再设置
`SKILLHIVE_PAT=sk-...` 与 `SKILLHIVE_INTERNAL_TOKEN` 后运行 `pnpm --filter
@skillhive/mcp-server dev:stdio`。SSE 客户端必须在 `/sse` 和后续 `/messages`
请求中都携带同一枚 `Authorization: Bearer <PAT>`；这能防止泄漏的 sessionId 被复用。
Web 登录只返回 HttpOnly Cookie；CLI 会显式请求 Bearer 会话，避免浏览器脚本拿到 JWT。

## 生产部署（试运营）

全栈 docker-compose（postgres + registry + mcp-server + console/nginx）：

```bash
# 1. 准备配置（参考 .env.example）：数据库密码、会话密钥、内部令牌、首次启动引导的管理员账号
cp .env.example .env && vi .env

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build
```

生产环境会拒绝空密码、短于 32 字符的会话密钥或内部令牌。默认端口只绑定
`127.0.0.1`，请在服务器前配置企业 HTTPS 反向代理；只有确认主机防火墙与网络边界后，
才将对应的 `*_BIND_ADDRESS` 改为局域网地址或 `0.0.0.0`。Console 会在同域代理
`/sse`、`/messages` 与 `/mcp`，因此默认 `PUBLIC_MCP_URL=/sse` 不会降级为明文跨域连接。
当前生产代理仅支持根路径 `/sse`；带路径前缀、查询参数或片段的
`PUBLIC_MCP_URL` 会在 MCP 启动时被拒绝，避免生成无法投递 `/messages` 的半可用配置。
MCP 在生产模式会拒绝非 HTTPS 的外部请求；只有明确评估过受控明文网络后才可设置
`SKILLHIVE_ALLOW_HTTP=1`。前置 TLS 代理必须覆盖（不能直接透传客户端提供的）
`X-Forwarded-Proto: https` 与 `X-Forwarded-For`，并保持原始 `Host`；不要将 Console、
Registry 或 MCP 的容器端口直接暴露到不受信网络。

启动后入口：

| 服务 | 默认端口 | 用途 |
|---|---|---|
| Console | https://你的企业域名 | 员工网页入口（nginx 托管 + /api 反代） |
| Registry | https://你的企业域名/api | CLI publish 入口（也可经独立受控域名） |
| MCP Server | https://你的企业域名/sse | WorkBuddy MCP 配置入口（PAT Bearer 鉴权） |

registry 首次启动会自动执行数据库迁移；在 `.env` 中设置 `SKILLHIVE_ADMIN_EMAIL` / `SKILLHIVE_ADMIN_PASSWORD` 可引导创建管理员账号（验证后建议移除）。

## 自动部署（GitHub Actions → 阿里云）

推送 `main` 分支即自动部署：质量门禁（lint/test/build）→ 构建镜像推送阿里云容器镜像服务（ACR）→ SSH 到 ECS 拉取重启。工作流见 `.github/workflows/deploy.yml`，需在仓库 Secrets 配置 ACR 凭证与 ECS SSH 信息（详见文件头注释），服务器按上一节完成一次性准备即可。
管理员可通过 `PATCH /api/auth/users/:id/status`（请求体 `{ "disabled": true }`）停用账号；
也可在服务器上运行 `pnpm --filter @skillhive/registry create-user -- --email <账号> --disable`
执行离线停用。停用会立即失效登录会话并吊销该账号的全部 PAT；使用 `--enable` 可重新启用，
但已吊销的 PAT 不会恢复。
从旧版本升级前请先备份数据库：`0005` 会在历史重复版本/资源文件中保留最新一条，
然后建立唯一约束；`0006` 会增加账号停用时间字段。旧匿名投票账号不会再新增，
历史数据可按企业留存策略另行归档。

## 质量校验

提交前运行 `pnpm check`，会依次执行 ESLint、全 workspace 类型检查、单元测试和
可直接启动的生产构建。CI 还会检查生产依赖高危漏洞与 Compose 配置。

## 许可证

[MIT](./LICENSE)
