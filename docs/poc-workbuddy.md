# WorkBuddy 接入 POC 验证手册

> 目标：用最小成本（半天以内）验证 SkillHive 与腾讯 WorkBuddy 的 MCP 集成可行性。
> POC 通过前，不投入任何后续开发。

## POC 要回答的 4 个问题

| # | 问题 | 不通过的后果 |
|---|---|---|
| Q1 | WorkBuddy 是否支持接入企业自定义 MCP Server？ | 项目需要换客户端载体（重大变更） |
| Q2 | 支持哪种传输与鉴权？（Streamable HTTP / SSE；Token / OAuth） | 影响 MCP Server 的部署形态 |
| Q3 | WorkBuddy 能否访问到部署在企业内网的 MCP Server？ | 需要调整网络/部署方案 |
| Q4 | 是否支持 MCP `prompts` 原语（用户主动选用的模板）？ | 决定消费体验设计（降级为 tools 返回内容） |

## 第 0 步：信息收集（1 小时，不写代码）

- [ ] 查阅 WorkBuddy 官方文档 / 管理后台，找「MCP」「自定义工具」「插件」「开放平台」相关入口
- [ ] 确认你们使用的是 **SaaS 版还是私有化部署版**（直接影响 Q3）
- [ ] 确认配置 MCP Server 需要什么权限（超级管理员？应用管理员？）
- [ ] 如果文档不清楚，直接问 WorkBuddy 的客户成功/技术支持，把 Q1/Q2 抛给他们

## 第 1 步：启动 POC 服务器（10 分钟）

```bash
# 终端 1：启动数据库 + Registry（提供真实 skill 数据）
docker compose up -d postgres
pnpm dev:registry

# 终端 2：启动 MCP Server（Streamable HTTP 模式）
pnpm --filter @skillhive/mcp-server dev:http
```

自检（模拟 MCP 客户端握手）：

```bash
curl -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 预期：返回 search_skills / list_skills / get_skill 三个工具
```

## 第 2 步：让 WorkBuddy 能访问到 POC 服务器

按实际情况三选一：

| 场景 | 方案 |
|---|---|
| WorkBuddy 私有化部署在内网 | 把 POC 服务跑在一台内网服务器上即可 |
| WorkBuddy 是 SaaS，公司允许暴露测试端口 | 内网穿透（frp / ngrok / cloudflared）临时暴露 3100 端口 |
| 公司安全策略不允许任何暴露 | 申请一台有公网入口的测试云主机部署 POC |

## 第 3 步：在 WorkBuddy 中配置 MCP Server

在 WorkBuddy 管理后台的 MCP/工具配置入口添加：

- **Server URL**：`http(s)://<你的地址>/mcp`
- **鉴权**：POC 阶段留空（我们暂未实现鉴权，勿在内网外长期暴露）

## 第 4 步：验证清单

- [ ] **连接成功**：WorkBuddy 显示 MCP Server 已连接/可用 → Q1 ✅
- [ ] **工具发现**：能看到 `list_skills` / `search_skills` / `get_skill` 三个工具
- [ ] **对话调用**：在 WorkBuddy 对话中输入「帮我列出公司可用的 AI skill」，观察是否调用 `list_skills` 并返回 weekly-report / invoice-extract
- [ ] **内容执行**：输入「用周报 skill 帮我写周报」，观察是否调用 `get_skill` 获取模板并执行
- [ ] **prompts 探测**：检查 WorkBuddy 界面是否有「快捷指令 / 斜杠命令」类入口能呈现 MCP prompts → Q4

## 第 5 步：记录结论（回填本表）

| 问题 | 结论 | 备注 |
|---|---|---|
| Q1 支持自定义 MCP？ | ☐ 是 / ☐ 否 | |
| Q2 传输方式 / 鉴权 | | |
| Q3 网络可达性 | | |
| Q4 支持 prompts 原语？ | ☐ 是 / ☐ 否 | |

## 常见失败与对策

| 现象 | 可能原因 | 对策 |
|---|---|---|
| 添加 Server 时报连接失败 | 网络不通 / 只支持 HTTPS | 换 HTTPS（caddy 反代）或检查网络 |
| 连接成功但看不到工具 | 只支持 SSE 旧协议 | 告诉我们，补 SSE transport |
| 工具调用无响应 | 鉴权要求 / 请求体大小限制 | 抓包确认请求格式 |
| 对话中模型不主动调工具 | 工具描述不清晰 | 正常现象，prompts 原语才是消费主路径 |
