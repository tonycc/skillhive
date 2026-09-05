import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const created = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "skillhive-remote-deploy-"));
  created.push(directory);
  const fakeBin = join(directory, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(fakeBin));
  const docker = join(fakeBin, "docker");
  await writeFile(docker, `#!/bin/sh
echo "$SERVER_IMAGE|$CONSOLE_IMAGE|$*" >> "$FAKE_DOCKER_LOG"
echo "$SKILLHIVE_ALLOW_HTTP|$CONSOLE_BIND_ADDRESS|$REGISTRY_BIND_ADDRESS|$MCP_BIND_ADDRESS" >> "$FAKE_DOCKER_ENV_LOG"
case "$*" in
  *"ps -q registry"*) echo registry-id ;;
  *"ps -q console"*) echo console-id ;;
  "inspect --format {{.Config.Image}} registry-id") echo "\${FAKE_PREVIOUS_SERVER:-skillhive-server:old}" ;;
  "inspect --format {{.Config.Image}} console-id") echo "\${FAKE_PREVIOUS_CONSOLE:-skillhive-console:old}" ;;
  *"run --rm --env-file .env --entrypoint node"*)
    if test "$FAKE_MODE" = validation; then exit 1; fi
    ;;
  *"up -d --wait --wait-timeout 180"*)
    count=0
    test -f "$FAKE_UP_COUNT" && count="$(sed -n '1p' "$FAKE_UP_COUNT")"
    count=$((count + 1))
    echo "$count" > "$FAKE_UP_COUNT"
    if test "$FAKE_MODE" = failure && test "$count" -eq 1; then exit 1; fi
    ;;
esac
exit 0
`);
  await chmod(docker, 0o755);
  await writeFile(join(directory, "images.tar.gz"), "fake image archive");
  await writeFile(join(directory, "docker-compose.prod.yml"), "services: {}\n");
  await writeFile(join(directory, ".env"), `TEST_ONLY=1
SKILLHIVE_ALLOW_HTTP=1
CONSOLE_BIND_ADDRESS=0.0.0.0
REGISTRY_BIND_ADDRESS=0.0.0.0
MCP_BIND_ADDRESS=0.0.0.0
`);
  return {
    directory,
    log: join(directory, "docker.log"),
    envLog: join(directory, "docker-env.log"),
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      SKILLHIVE_DEPLOY_SHA: "abc123",
      FAKE_DOCKER_LOG: join(directory, "docker.log"),
      FAKE_DOCKER_ENV_LOG: join(directory, "docker-env.log"),
      FAKE_UP_COUNT: join(directory, "up-count"),
      FAKE_MODE: mode,
    },
  };
}

function run(testFixture) {
  return spawnSync("sh", [resolve("scripts/deploy/remote-deploy.sh")], {
    cwd: testFixture.directory,
    env: testFixture.env,
    encoding: "utf8",
  });
}

describe("remote deployment", () => {
  it("validates and health-switches commit images while retaining rollback tags", async () => {
    const testFixture = await fixture("success");
    const result = run(testFixture);
    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(testFixture.log, "utf8");
    expect(log).toContain("tag skillhive-server:old skillhive-server:rollback");
    expect(log).toContain("run --rm --env-file .env --entrypoint node --env SKILLHIVE_ALLOW_HTTP");
    expect(log).toContain("--env MCP_BIND_ADDRESS skillhive-server:abc123");
    const envLog = await readFile(testFixture.envLog, "utf8");
    expect(envLog).toContain("|127.0.0.1|127.0.0.1|127.0.0.1");
    expect(log).toContain("skillhive-server:abc123|skillhive-console:abc123|compose -f docker-compose.prod.yml up -d --wait --wait-timeout 180");
    expect(log).toContain("image rm skillhive-server:old");
    expect(log).toContain("image prune -f");
  });

  it("restores rollback images when the new services fail health checks", async () => {
    const testFixture = await fixture("failure");
    const result = run(testFixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("开始恢复原应用镜像");
    const log = await readFile(testFixture.log, "utf8");
    expect(log).toContain("skillhive-server:rollback|skillhive-console:rollback|compose -f docker-compose.prod.yml up -d --wait --wait-timeout 180");
    expect(log).toContain("image rm skillhive-server:abc123 skillhive-console:abc123");
  });

  it("removes newly loaded images when production validation fails", async () => {
    const testFixture = await fixture("validation");
    const result = run(testFixture);
    expect(result.status).toBe(1);
    const log = await readFile(testFixture.log, "utf8");
    expect(log).toContain("image rm skillhive-server:abc123 skillhive-console:abc123");
    expect(log).not.toContain("up -d --wait");
  });

  it("does not remove the active commit tag when the same revision is redeployed", async () => {
    const testFixture = await fixture("success");
    testFixture.env.FAKE_PREVIOUS_SERVER = "skillhive-server:abc123";
    testFixture.env.FAKE_PREVIOUS_CONSOLE = "skillhive-console:abc123";
    const result = run(testFixture);
    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(testFixture.log, "utf8");
    expect(log).not.toContain("image rm skillhive-server:abc123\n");
    expect(log).not.toContain("image rm skillhive-console:abc123\n");
  });

  it("refuses a path-like artifact target before invoking Docker", async () => {
    const testFixture = await fixture("success");
    testFixture.env.SKILLHIVE_DEPLOY_ARTIFACT = "../images.tar.gz";
    const result = run(testFixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("当前目录下的文件名");
    await expect(readFile(testFixture.log, "utf8")).rejects.toThrow();
  });
});
