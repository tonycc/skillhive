/* global process, console */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseMcpUrl } from "./url.mjs";
import { validateBuiltMcp } from "./manifest-validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "skillhive");
const target = join(root, "dist", "skillhive");
const rawUrl = process.argv.slice(2).find((value) => value !== "--");
const execFileAsync = promisify(execFile);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (!rawUrl) throw new Error("缺少企业 MCP 地址；用法：node build.mjs http://服务器地址/mcp");
const url = parseMcpUrl(rawUrl);

await execFileAsync(process.execPath, [join(root, "validate.mjs")]);

const meta = JSON.parse(await readFile(join(source, "connector-meta.json"), "utf8"));
const artifactBase = `${meta.source}-${meta.version}`;
const archive = join(root, "dist", `${artifactBase}.zip`);
const checksumManifest = join(root, "dist", `${artifactBase}.sha256.json`);

await rm(target, { recursive: true, force: true });
await rm(archive, { force: true });
await rm(checksumManifest, { force: true });
await mkdir(target, { recursive: true });
for (const name of ["connector-meta.json", "token-schema.json", "icon.svg", "skills"]) {
  await cp(join(source, name), join(target, name), { recursive: true });
}
const template = await readFile(join(source, "mcp.template.json"), "utf8");
const builtMcp = JSON.parse(template.replace("__SKILLHIVE_MCP_URL__", url.href));
validateBuiltMcp(builtMcp, url.href);
await writeFile(join(target, "mcp.json"), `${JSON.stringify(builtMcp, null, 2)}\n`, "utf8");

try {
  await execFileAsync("zip", [
    "-r",
    "-q",
    "-X",
    archive,
    "connector-meta.json",
    "mcp.json",
    "token-schema.json",
    "icon.svg",
    "skills",
  ], { cwd: target });
} catch (error) {
  throw new Error("无法生成审核 ZIP；请在隔离构建环境安装 zip 命令后重试", { cause: error });
}

const files = await listFiles(target);
const manifest = {
  connector: meta.source,
  version: meta.version,
  archive: `${artifactBase}.zip`,
  archiveSha256: await sha256(archive),
  files: await Promise.all(files.map(async (path) => ({
    path: relative(target, path),
    sha256: await sha256(path),
  }))),
};
await writeFile(checksumManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`已生成 WorkBuddy 连接器目录：${target}`);
console.log(`已生成待审核 ZIP：${archive}`);
console.log(`已生成 SHA-256 清单：${checksumManifest}`);
