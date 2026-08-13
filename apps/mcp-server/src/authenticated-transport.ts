import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallerIdentity } from "./registry.js";
import { validatePatSession } from "./registry.js";

/**
 * 在传输边界验证每条入站 MCP 消息。这样 SDK 本地处理的 tools/list、prompts/list
 * 也无法在 PAT 撤销后继续泄露缓存元数据。
 */
export function bindPatValidation(
  transport: Transport,
  identity: CallerIdentity,
  validate: (identity: CallerIdentity) => Promise<boolean> = validatePatSession,
): Transport {
  let downstream: Transport["onmessage"];
  let queue = Promise.resolve();
  let closed = false;

  transport.onmessage = (message, extra) => {
    queue = queue
      .then(async () => {
        if (closed) return;
        const valid = await validate(identity);
        if (!valid) {
          closed = true;
          transport.onerror?.(new Error("接入令牌已失效，已关闭 stdio MCP 连接"));
          await transport.close();
          return;
        }
        downstream?.(message, extra);
      })
      .catch(async (error: unknown) => {
        if (closed) return;
        closed = true;
        transport.onerror?.(
          error instanceof Error ? error : new Error("接入令牌校验失败"),
        );
        await transport.close();
      });
  };

  return {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
    get sessionId() {
      return transport.sessionId;
    },
    setProtocolVersion: transport.setProtocolVersion
      ? (version) => transport.setProtocolVersion?.(version)
      : undefined,
    get onclose() {
      return transport.onclose;
    },
    set onclose(handler) {
      transport.onclose = handler;
    },
    get onerror() {
      return transport.onerror;
    },
    set onerror(handler) {
      transport.onerror = handler;
    },
    get onmessage() {
      return downstream;
    },
    set onmessage(handler) {
      downstream = handler as (<T extends JSONRPCMessage>(
        message: T,
        extra?: MessageExtraInfo,
      ) => void) | undefined;
    },
  };
}
