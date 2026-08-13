#!/bin/sh
# Registry 生产容器入口：数据库迁移 → （可选）引导管理员账号 → 启动服务
set -e

echo "[entrypoint] 执行数据库迁移…"
pnpm --filter @skillhive/db db:migrate

# 首次部署引导：设置了 SKILLHIVE_ADMIN_EMAIL + SKILLHIVE_ADMIN_PASSWORD 时创建/重置管理员
if [ -n "$SKILLHIVE_ADMIN_EMAIL" ] && [ -n "$SKILLHIVE_ADMIN_PASSWORD" ]; then
  echo "[entrypoint] 引导管理员账号：$SKILLHIVE_ADMIN_EMAIL"
  pnpm --filter @skillhive/registry create-user \
    --email "$SKILLHIVE_ADMIN_EMAIL" \
    --name "${SKILLHIVE_ADMIN_NAME:-管理员}" \
    --role admin
fi

echo "[entrypoint] 启动 Registry…"
exec node apps/registry/dist/index.js
