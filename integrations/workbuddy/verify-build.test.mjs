import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyConnectorArchive } from "./verify-build.mjs";

const created = [];
const digest = (content) => createHash("sha256").update(content).digest("hex");

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture({ extraFile = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "skillhive-connector-verify-"));
  created.push(directory);
  const packageDirectory = join(directory, "package");
  await mkdir(join(packageDirectory, "skills"), { recursive: true });
  const contents = new Map([
    ["connector-meta.json", Buffer.from('{"source":"skillhive"}\n')],
    ["skills/SKILL.md", Buffer.from("---\ndescription: test\n---\n")],
  ]);
  if (extraFile) contents.set("unexpected.txt", Buffer.from("unexpected"));
  for (const [path, content] of contents) await writeFile(join(packageDirectory, path), content);
  const archive = join(directory, "skillhive-1.0.0.zip");
  execFileSync("zip", ["-r", "-q", "-X", archive, ...contents.keys()], { cwd: packageDirectory });
  const expectedFiles = [...contents.entries()]
    .filter(([path]) => path !== "unexpected.txt")
    .map(([path, content]) => ({ path, sha256: digest(content) }));
  return {
    archive,
    manifest: {
      archive: "skillhive-1.0.0.zip",
      archiveSha256: digest(await readFile(archive)),
      files: expectedFiles,
    },
  };
}

describe("WorkBuddy review archive verification", () => {
  it("verifies archive and per-file SHA-256 values", async () => {
    const { archive, manifest } = await fixture();
    await expect(verifyConnectorArchive(archive, manifest)).resolves.toEqual({
      archiveSha256: manifest.archiveSha256,
      fileCount: 2,
    });
  });

  it("rejects an archive changed after its digest was recorded", async () => {
    const { archive, manifest } = await fixture();
    await writeFile(archive, "tampered");
    await expect(verifyConnectorArchive(archive, manifest)).rejects.toThrow(/SHA-256/);
  });

  it("rejects unexpected files even when the archive digest is current", async () => {
    const { archive, manifest } = await fixture({ extraFile: true });
    await expect(verifyConnectorArchive(archive, manifest)).rejects.toThrow(/文件列表/);
  });

  it("rejects unsafe paths in an external manifest", async () => {
    const { archive, manifest } = await fixture();
    manifest.files[0].path = "../secret";
    await expect(verifyConnectorArchive(archive, manifest)).rejects.toThrow(/非法路径/);
  });
});
