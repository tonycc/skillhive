#!/bin/sh
# 在目标服务器执行：载入 commit 镜像、校验生产配置、健康切换并保留一个回退版本。
set -eu

: "${SKILLHIVE_DEPLOY_SHA:?缺少 SKILLHIVE_DEPLOY_SHA}"

artifact="${SKILLHIVE_DEPLOY_ARTIFACT:-images.tar.gz}"
compose_file="${SKILLHIVE_COMPOSE_FILE:-docker-compose.prod.yml}"

case "$artifact" in
  ""|*/*) echo "部署镜像包必须是当前目录下的文件名" >&2; exit 1 ;;
esac
test -f "$artifact" || { echo "部署镜像包不存在：$artifact" >&2; exit 1; }
test -f "$compose_file" || { echo "Compose 文件不存在：$compose_file" >&2; exit 1; }
test -f .env || { echo "生产 .env 不存在" >&2; exit 1; }

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-skillhive}"
new_server="skillhive-server:${SKILLHIVE_DEPLOY_SHA}"
new_console="skillhive-console:${SKILLHIVE_DEPLOY_SHA}"

registry_id="$(docker compose -f "$compose_file" ps -q registry 2>/dev/null || true)"
console_id="$(docker compose -f "$compose_file" ps -q console 2>/dev/null || true)"
previous_server=""
previous_console=""
if [ -n "$registry_id" ]; then previous_server="$(docker inspect --format '{{.Config.Image}}' "$registry_id")"; fi
if [ -n "$console_id" ]; then previous_console="$(docker inspect --format '{{.Config.Image}}' "$console_id")"; fi

if [ -n "$previous_server" ] && [ -n "$previous_console" ]; then
  docker tag "$previous_server" skillhive-server:rollback
  docker tag "$previous_console" skillhive-console:rollback
fi

docker load < "$artifact"
rm -f "$artifact"
docker image inspect "$new_server" >/dev/null
docker image inspect "$new_console" >/dev/null

if ! docker run --rm --env-file .env --entrypoint node "$new_server" \
  scripts/validate-production-env.mjs --from-process --phase deploy; then
  docker image rm "$new_server" "$new_console" >/dev/null 2>&1 || true
  exit 1
fi

export SERVER_IMAGE="$new_server"
export CONSOLE_IMAGE="$new_console"
if ! docker compose -f "$compose_file" up -d --wait --wait-timeout 180; then
  echo "新版本健康检查失败，开始恢复原应用镜像；数据库迁移不会自动回滚" >&2
  if [ -n "$previous_server" ] && [ -n "$previous_console" ]; then
    export SERVER_IMAGE=skillhive-server:rollback
    export CONSOLE_IMAGE=skillhive-console:rollback
    docker compose -f "$compose_file" up -d --wait --wait-timeout 180
  else
    echo "首次部署没有可恢复的原镜像" >&2
  fi
  docker image rm "$new_server" "$new_console" >/dev/null 2>&1 || true
  exit 1
fi

# rollback 标签保留上一套应用镜像；移除其旧名称后，prune 可清理更早的无标签镜像。
if [ -n "$previous_server" ] && [ "$previous_server" != "skillhive-server:rollback" ] && [ "$previous_server" != "$new_server" ]; then
  docker image rm "$previous_server" >/dev/null 2>&1 || true
fi
if [ -n "$previous_console" ] && [ "$previous_console" != "skillhive-console:rollback" ] && [ "$previous_console" != "$new_console" ]; then
  docker image rm "$previous_console" >/dev/null 2>&1 || true
fi
docker image prune -f
echo "SkillHive ${SKILLHIVE_DEPLOY_SHA} 已完成健康切换"
