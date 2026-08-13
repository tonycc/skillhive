import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { bindPatValidation } from "./authenticated-transport.js";
import type { CallerIdentity } from "./registry.js";

const identity: CallerIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "member@example.com",
  name: "Member",
  role: "member",
  departmentId: null,
  tokenId: "22222222-2222-4222-8222-222222222222",
};

function fakeTransport() {
  const close = vi.fn(async () => {});
  const transport: Transport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close,
  };
  return { transport, close };
}

const listPrompts = {
  jsonrpc: "2.0",
  id: 1,
  method: "prompts/list",
} satisfies JSONRPCMessage;

describe("bindPatValidation", () => {
  it("forwards a message only after the PAT is validated", async () => {
    const { transport } = fakeTransport();
    const validate = vi.fn(async () => true);
    const secured = bindPatValidation(transport, identity, validate);
    const onmessage = vi.fn();
    secured.onmessage = onmessage;

    transport.onmessage?.(listPrompts);
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledWith(listPrompts, undefined));
    expect(validate).toHaveBeenCalledWith(identity);
  });

  it("closes without forwarding prompts/list after revocation", async () => {
    const { transport, close } = fakeTransport();
    const secured = bindPatValidation(transport, identity, async () => false);
    const onmessage = vi.fn();
    secured.onmessage = onmessage;

    transport.onmessage?.(listPrompts);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(onmessage).not.toHaveBeenCalled();
  });

  it("serializes concurrent messages without dropping either one", async () => {
    const { transport } = fakeTransport();
    const validate = vi.fn(async () => true);
    const secured = bindPatValidation(transport, identity, validate);
    const onmessage = vi.fn();
    secured.onmessage = onmessage;
    const second = { ...listPrompts, id: 2 } satisfies JSONRPCMessage;

    transport.onmessage?.(listPrompts);
    transport.onmessage?.(second);

    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(2));
    expect(onmessage.mock.calls.map(([message]) => message.id)).toEqual([1, 2]);
    expect(validate).toHaveBeenCalledTimes(2);
  });
});
