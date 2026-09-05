# SkillHive 公开市场连接器构建

`skillhive/` 是可审计的连接器源文件，包含统一发现普通 Skill 和应用的“企业 Skill 助手”，以及兼容既有使用方式的“需求探索”显式快捷入口。真实企业 MCP 地址不得提交到仓库；发布前由 IT 在隔离的构建环境中生成最终目录：

该包计划由个人实名认证开发者提交到 WorkBuddy 公开市场，建议服务类目为“商业服务—企业管理”。市场中的所有用户可以查看和安装连接器，但安装不会授予企业数据权限；只有持目标企业管理员签发的有效 SkillHive 员工令牌，才能访问该企业的 Skill、应用和需求数据。公司普通 Skill、业务规则、员工令牌及其他凭据均不进入公开包。

```bash
pnpm connector:build -- "$WORKBUDDY_CONNECTOR_MCP_URL"
pnpm connector:verify
```

先由 IT 将 `WORKBUDDY_CONNECTOR_MCP_URL` 注入为已确认的测试或正式地址。构建命令接受域名或 IP 形式的 HTTP(S) `/mcp` 地址，但仍拒绝 URL 凭据、查询参数、片段和错误路径；它会在 `integrations/workbuddy/dist/` 生成符合官方目录结构的 `skillhive/`、版本化 ZIP，以及包外的 SHA-256 文件清单。`connector:verify` 会重新读取 ZIP，核对归档摘要、精确文件集合和每个包内文件摘要，并再次扫描真实凭据与服务端秘密配置。协议、地址、网络暴露范围及其是否符合平台提交要求由发布人员人工确认。构建产物被 Git 忽略，提交审核前还必须按[提交与实测记录](../../docs/operations/workbuddy-connector-submission-record.md)人工复核，并在真实 WorkBuddy 客户端验证安装、Token 表单、工具发现、草稿保存、正式提交和吊销生效。

仓库提供手动 GitHub Actions 工作流 `Build WorkBuddy Connector Review Package`。在仓库 Secret `WORKBUDDY_CONNECTOR_MCP_URL` 中配置获批地址后手动运行；工作流不会打印地址，只上传版本化 ZIP 和 SHA-256 清单，并在 7 天后自动删除 Actions 产物。下载后仍须核对摘要并通过批准渠道提交，不得把 Actions 产物链接当作员工安装入口。

只校验源文件：

```bash
pnpm connector:validate
```

校验覆盖官方提交前检查中可由仓库自动证明的部分：市场元数据与双语示例、语义化版本、单一 Streamable HTTP Server、Token 密码字段、企业 Skill 助手与需求探索入口的必填字段和核心工具契约、入口服从锁定 Grill Me frontier 且不限制每轮问题数量，以及包内秘密/本机地址扫描。`source` 的全局唯一性、平台审核和真实客户端兼容性必须在 WorkBuddy 开放平台及目标设备另行验证。

`integrations/workbuddy/dist/` 是可重复生成的本地审核产物，不属于源码。执行清理后需要提交审核包时，重新运行上面的 `connector:build` 和 `connector:verify` 即可。

WorkBuddy 官方连接器规范：https://open.workbuddy.cn/docs/connector
