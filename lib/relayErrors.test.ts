import { describe, it, expect } from "vitest";
import { friendlyRelayError } from "./relayErrors";

describe("friendlyRelayError wallet RPC", () => {
  it("explains MetaMask Ethereum Unauthorized / JSON-RPC protocol errors", () => {
    const msg = friendlyRelayError(
      new Error(
        "Version of JSON-RPC protocol is not supported. Details: RPC 0x1 Custom eth_getBlockByNumber: Unauthorized.",
      ),
    );
    expect(msg).toMatch(/Ethereum RPC/i);
    expect(msg).toMatch(/publicnode/i);
  });
});
