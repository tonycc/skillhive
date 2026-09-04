/* global console, process */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function unzip(args, archive) {
  const result = spawnSync("unzip", args, { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new Error("无法调用 unzip 校验审核包", { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`审核 ZIP 无法读取：${Buffer.from(result.stderr ?? "").toString("utf8").trim() || archive}`);
  }
  return result.stdout;
}

export async function verifyConnectorArchive(archive, manifest) {
  if (manifest?.archive !== basename(archive) || !SHA256.test(manifest?.archiveSha256 ?? "")) {
    throw new Error("SHA-256 清单中的归档名称或摘要格式无效");
  }
  const archiveContent = await readFile(archive);
  if (sha256(archiveContent) !== manifest.archiveSha256) throw new Error("审核 ZIP 的 SHA-256 与清单不一致");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("SHA-256 清单没有包内文件");

  const expected = new Map();
  for (const item of manifest.files) {
    if (typeof item?.path !== "string" || !item.path || item.path.startsWith("/")
      || item.path.includes("\\") || item.path.split("/").includes("..") || !SHA256.test(item.sha256 ?? "")) {
      throw new Error("SHA-256 清单包含非法路径或文件摘要");
    }
    if (expected.has(item.path)) throw new Error(`SHA-256 清单包含重复路径：${item.path}`);
    expected.set(item.path, item.sha256);
  }

  const listed = Buffer.from(unzip(["-Z1", archive], archive)).toString("utf8")
    .split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/")).sort();
  const expectedPaths = [...expected.keys()].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expectedPaths)) {
    throw new Error("审核 ZIP 的文件列表与 SHA-256 清单不一致");
  }

  for (const path of expectedPaths) {
    const content = unzip(["-p", archive, path], archive);
    if (sha256(content) !== expected.get(path)) throw new Error(`审核 ZIP 内文件摘要不一致：${path}`);
    const text = Buffer.from(content).toString("utf8");
    if (/\bsk-[a-f0-9]{48}\b/i.test(text)
      || text.includes("SKILLHIVE_INTERNAL_TOKEN")
      || text.includes("DATABASE_URL=")) {
      throw new Error(`审核 ZIP 疑似包含凭据或服务端秘密配置：${path}`);
    }
  }
  return { archiveSha256: manifest.archiveSha256, fileCount: expectedPaths.length };
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  if (args.length > 2 || (args.length > 0 && args[0] !== "--dist") || (args[0] === "--dist" && !args[1])) {
    throw new Error("用法：connector:verify -- [--dist <构建产物目录>]");
  }
  const dist = resolve(args[1] ?? join(root, "dist"));
  const meta = JSON.parse(await readFile(join(root, "skillhive", "connector-meta.json"), "utf8"));
  const artifactBase = `${meta.source}-${meta.version}`;
  const archive = join(dist, `${artifactBase}.zip`);
  const manifest = JSON.parse(await readFile(join(dist, `${artifactBase}.sha256.json`), "utf8"));
  if (manifest.connector !== meta.source || manifest.version !== meta.version) {
    throw new Error("审核包清单与连接器 source/version 不一致");
  }
  const result = await verifyConnectorArchive(archive, manifest);
  console.log(`WorkBuddy 审核包校验通过：${result.fileCount} 个文件，SHA-256 ${result.archiveSha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
