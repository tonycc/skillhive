# 企业内分发 skillhive sync 的三种方式

> 背景：WorkBuddy 无管理员侧技能分发能力，`skillhive sync` 是正式分发通道。
> 目标：IT 统一下发，员工零操作，平台发布后全公司自动更新。

## sync 的行为约定（可安全反复执行）

- **增量**：内容无变化不覆写（输出"已是最新"）
- **更新**：平台出新版本后自动覆盖本地
- **下架**：平台下架的 skill 自动从本地移除（仅清理清单内由本工具同步的，绝不动员工自行安装的技能）
- 清单文件：`<技能目录>/.skillhive-manifest.json`

## 方式一：cron（最简单，适合试点）

在员工机执行一次（或 MDM 推送 crontab）：

```cron
*/30 * * * * cd /opt/skillhive/apps/cli && /usr/local/bin/pnpm dev sync >> /tmp/skillhive-sync.log 2>&1
```

## 方式二：macOS launchd（员工机为 Mac 时推荐）

`/Library/LaunchAgents/com.skillhive.sync.plist`（MDM 推送）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.skillhive.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/pnpm</string>
    <string>--dir</string><string>/opt/skillhive/apps/cli</string>
    <string>dev</string><string>sync</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/skillhive-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/skillhive-sync.log</string>
</dict>
</plist>
```

## 方式三：打包为独立二进制（员工机无 Node 环境时）

```bash
# 用 bun 打包单文件可执行程序（体积约 50MB）
bun build apps/cli/src/index.ts --compile --outfile skillhive-cli

# 员工机只需一个二进制 + 一条 cron：
*/30 * * * * SKILLHIVE_REGISTRY_URL=http://skillhive.internal:3001 /usr/local/bin/skillhive-cli sync
```

## 注意事项

- 员工机需能访问 Registry（内网地址），通过 `SKILLHIVE_REGISTRY_URL` 环境变量配置
- sync 后需**重启 WorkBuddy** 才能在 / 菜单中看到新 skill（WorkBuddy 启动时加载技能目录）
- 对话直说「用 xx 帮我…」的 MCP 路径是实时的，不受 sync 周期影响
