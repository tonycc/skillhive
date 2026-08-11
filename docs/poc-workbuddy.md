# WorkBuddy 接入 POC 验证手册

> 目标：用最小成本（半天以内）验证 SkillHive 与腾讯 WorkBuddy 的 MCP 集成可行性。
> POC 通过前，不投入任何后续开发。

## ✅ 已确认的信息（来自 WorkBuddy 官方文档，2026-08）

- **Q1 ✅ 支持自定义 MCP Server**，配置方式为 JSON 配置文件中的 `mcpServers` 字段
- **Q2 ✅ 传输方式**：SSE / HTTP 模式（远程 URL 接入）；鉴权支持 `Authorization: Bearer <token>` 请求头
- **Q3 ✅ 网络**：配置示例使用 localhost，WorkBuddy 为本地客户端形态，可直接访问本机服务，无需内网穿透

### WorkBuddy 配置示例（填入其 MCP 配置文件）

```json
{
  "mcpServers": {
    "skillhive": {
      "url": "http://localhost:3100/sse"
    }
  }
}
```

## 待验证的问题

| # | 问题 | 不通过的后果 |
|---|---|---|
| Q4 | WorkBuddy 是否支持 MCP `prompts` 原语（用户主动选用的模板）？ | 决定消费体验设计（降级为 tools 返回内容） |
| Q5 | SSE 实际联调是否顺畅（工具发现、对话中调用） | 排查协议细节差异 |

## 第 0 步：信息收集（已完成 ✅）

已确认 WorkBuddy 支持 SSE/HTTP 远程 MCP 接入，见文档顶部「已确认的信息」。

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

## 第 2 步：网络打通（已简化 ✅）

WorkBuddy 为本地客户端，直接访问 `localhost:3100` 即可，无需内网穿透。
若后续要在公司服务器部署供多人使用，将 URL 换成服务器地址即可。

## 第 3 步：在 WorkBuddy 中配置 MCP Server

将文档顶部的配置 JSON 填入 WorkBuddy 的 MCP 配置文件，保存后重启/刷新 WorkBuddy。

## 第 4 步：验证清单

- [ ] **连接成功**：WorkBuddy 显示 skillhive MCP Server 已连接/可用
- [ ] **工具发现**：能看到 `list_skills` / `search_skills` / `get_skill` 三个工具
- [ ] **对话调用**：在 WorkBuddy 对话中输入「帮我列出公司可用的 AI skill」，观察是否调用 `list_skills` 并返回 weekly-report / invoice-extract
- [ ] **内容执行**：输入「用周报 skill 帮我写周报」，观察是否调用 `get_skill` 获取模板并执行
- [ ] **prompts 探测**：检查 WorkBuddy 界面是否有「快捷指令 / 斜杠命令」类入口能呈现 MCP prompts → Q4

## 第 5 步：记录结论（回填本表）

| 问题 | 结论 | 备注 |
|---|---|---|
| Q4 支持 prompts 原语？ | ☐ 是 / ☐ 否 | |
| Q5 SSE 联调顺畅？ | ☐ 是 / ☐ 否 | |

## 常见失败与对策

| 现象 | 可能原因 | 对策 |
|---|---|---|
| 连接失败/一直转圈 | 服务没启动 / 端口不对 | 先 `curl http://localhost:3100/health` 自检 |
| 连接成功但看不到工具 | 协议不兼容 | 换 `http://localhost:3100/mcp`（Streamable HTTP）再试 |
| 工具调用无响应 | 会话过期 / 请求格式差异 | 看 MCP Server 终端日志，带现象反馈 |
| 对话中模型不主动调工具 | 工具描述不清晰 | 正常现象，prompts 原语才是消费主路径 |
