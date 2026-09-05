import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

export const MAX_TRIGGER_PHRASES = 20;
export const MAX_TRIGGER_PHRASE_LENGTH = 64;

/** 保存前统一去空白并按大小写去重，避免相同触发词影响检索权重。 */
export const triggerPhrasesSchema = z.array(
  z.string().trim().min(1, "触发词不能为空").max(
    MAX_TRIGGER_PHRASE_LENGTH,
    `单个触发词不能超过 ${MAX_TRIGGER_PHRASE_LENGTH} 个字符`,
  ),
).max(MAX_TRIGGER_PHRASES, `最多配置 ${MAX_TRIGGER_PHRASES} 个触发词`).transform((phrases) => {
  const seen = new Set<string>();
  return phrases.filter((phrase) => {
    const normalized = phrase.toLocaleLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
});

export const updateTriggerPhrasesSchema = z.object({
  triggerPhrases: triggerPhrasesSchema,
}).strict();

/** 所有触发词写接口统一返回 Console 可直接展示的字符串错误。 */
export const validateTriggerPhrases = zValidator(
  "json",
  updateTriggerPhrasesSchema,
  (result, c) => {
    if (!result.success) {
      return c.json({
        error: result.error.issues[0]?.message ?? "触发词配置无效",
      }, 400);
    }
  },
);
