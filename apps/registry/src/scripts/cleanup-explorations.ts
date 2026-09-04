import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  db,
  explorationAuditEvents,
  explorationIdempotency,
  explorationRevisions,
  explorations,
  requirementReviews,
  requirements,
  requirementSubmissions,
} from "@skillhive/db";
import { boundedRetentionDays, parseCleanupOptions } from "./cleanup-options.js";

const options = parseCleanupOptions(process.argv.slice(2));
const draftDays = boundedRetentionDays(process.env.EXPLORATION_DRAFT_RETENTION_DAYS, 90);
const submittedDays = boundedRetentionDays(process.env.EXPLORATION_SUBMITTED_RETENTION_DAYS, 365);
const now = Date.now();
const draftCutoff = new Date(now - draftDays * 86_400_000);
const submittedCutoff = new Date(now - submittedDays * 86_400_000);
const targetHash = options.explorationId
  ? createHash("sha256").update(options.explorationId).digest("hex")
  : null;

let draftRows: { id: string }[];
let submittedRows: { explorationId: string; requirementId: string }[];
if (options.mode === "delete-request") {
  const [target] = await db.select({
    explorationId: explorations.id,
    requirementId: requirements.id,
  }).from(explorations)
    .leftJoin(requirements, eq(explorations.id, requirements.explorationId))
    .where(eq(explorations.id, options.explorationId!));
  if (!target) throw new Error("指定的探索不存在，未执行任何清理");
  draftRows = target.requirementId ? [] : [{ id: target.explorationId }];
  submittedRows = target.requirementId
    ? [{ explorationId: target.explorationId, requirementId: target.requirementId }]
    : [];
} else {
  draftRows = await db.select({ id: explorations.id }).from(explorations)
    .leftJoin(requirements, eq(explorations.id, requirements.explorationId))
    .where(and(isNull(requirements.id), lt(explorations.updatedAt, draftCutoff)));
  submittedRows = await db.select({
    explorationId: explorations.id,
    requirementId: requirements.id,
  }).from(requirements).innerJoin(explorations, eq(requirements.explorationId, explorations.id))
    .where(lt(requirements.updatedAt, submittedCutoff));
}

console.log(JSON.stringify({
  mode: options.mode,
  action: options.execute ? "execute" : "dry-run",
  requestRef: options.requestRef,
  draftRetentionDays: draftDays,
  submittedRetentionDays: submittedDays,
  matchedDrafts: draftRows.length,
  matchedSubmitted: submittedRows.length,
}, null, 2));

if (!options.execute) process.exit(0);

const draftIds = draftRows.map((row) => row.id);
const requirementIds = submittedRows.map((row) => row.requirementId);
const submittedExplorationIds = submittedRows.map((row) => row.explorationId);
await db.transaction(async (tx) => {
  if (requirementIds.length > 0) {
    await tx.delete(requirementReviews).where(inArray(requirementReviews.requirementId, requirementIds));
    await tx.delete(requirementSubmissions).where(inArray(requirementSubmissions.requirementId, requirementIds));
    await tx.delete(requirements).where(inArray(requirements.id, requirementIds));
  }
  const explorationIds = [...draftIds, ...submittedExplorationIds];
  if (explorationIds.length > 0) {
    await tx.delete(explorationIdempotency).where(inArray(explorationIdempotency.explorationId, explorationIds));
    await tx.delete(explorationRevisions).where(inArray(explorationRevisions.explorationId, explorationIds));
    await tx.delete(explorations).where(inArray(explorations.id, explorationIds));
  }
  if (options.mode === "retention") {
    await tx.delete(explorationIdempotency).where(lt(explorationIdempotency.expiresAt, new Date()));
  }
  await tx.insert(explorationAuditEvents).values({
    actorType: "system",
    action: options.mode === "retention" ? "retention.cleanup_executed" : "data_request.cleanup_executed",
    metadata: {
      approvedBy: options.approvedBy,
      requestRef: options.requestRef,
      targetHash,
      draftRetentionDays: draftDays,
      submittedRetentionDays: submittedDays,
      deletedDrafts: draftIds.length,
      deletedSubmitted: submittedExplorationIds.length,
    },
  });
});
console.log(options.mode === "retention"
  ? "保留期清理已完成；仅保留不含正文的审计记录"
  : "删除申请清理已完成；仅保留不含正文的审计记录");
