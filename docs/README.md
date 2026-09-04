# SkillHive 文档索引

本文档目录区分产品基线、操作手册和证据记录。仓库验证通过不等于生产部署、WorkBuddy 平台审核或全员发布完成。

## 产品基线

- [WorkBuddy 官方连接器与需求探索产品方案](product/workbuddy-connector-requirement-exploration.md)：当前产品边界、应用与 Skill 模型、Grill Me 流程、身份、数据和验收定义。

## 操作与证据

- [需求探索上线与回退手册](operations/workbuddy-requirement-exploration-runbook.md)：部署、迁移、规则激活、员工接入、构建、清理和故障回退。
- [MVP 验收追踪表](operations/workbuddy-requirement-exploration-acceptance.md)：A01—A20 的仓库证据与外部待办。
- [连接器提交与实测记录](operations/workbuddy-connector-submission-record.md)：每个正式连接器版本单独填写的构建、平台审核、客户端兼容和发布结论模板。
- [WorkBuddy 连接器构建说明](../integrations/workbuddy/README.md)：可审计源目录、审核包生成和摘要验证。

## 当前边界

- SkillHive Web 仅供管理员运营；员工只通过 WorkBuddy 使用企业能力。
- 普通 Skill 与应用 Skill 共用发布入口，发布时不关联具体应用；应用在自身配置页选择兼容应用 Skill。
- 需求探索应用 Skill 必须包含完整 Grill Me 决策树和 frontier 协议。
- 个人 PAT 签发入口已移除；员工使用管理员定向发放的独立连接器令牌。
- 本地构建产物位于被忽略的 `dist/` 目录，可随时重新生成，不作为源码或平台提交证据长期保存。

## 维护约定

- 产品模型变化时，先更新产品方案，再同步运行手册、验收表和提交模板。
- 自动化证据变化时更新验收表；不要把本地测试写成平台审核、生产部署或真实客户端已完成。
- 不在文档中写入员工令牌、内部服务令牌、需求正文或未批准的生产地址。
- `docs/internal/` 是本机历史讨论资料并被 Git 忽略，不作为实施依据。
