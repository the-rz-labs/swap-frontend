import { describe, it, expect } from "vitest";
import { extractTronParam } from "./tronAdaptedWallet";

// The exact shape Relay's /quote returns for a Tron deposit step (TriggerSmartContract).
const relayStep = {
  parameter: {
    owner_address: "41aee2ccd4ba42003a3307772fd409530c770c7674",
    contract_address: "41f0623e1012177482912fb057e44e1a9769b1f588",
    call_value: 0,
    data: "e8017952000000000000000000000000aee2ccd4ba42003a3307772fd409530c770c7674",
  },
  type: "TriggerSmartContract",
};

describe("extractTronParam", () => {
  it("reads the parameter when the step is the data itself", () => {
    const p = extractTronParam({ data: relayStep });
    expect(p.contract_address).toBe("41f0623e1012177482912fb057e44e1a9769b1f588");
    expect(p.data.startsWith("e8017952")).toBe(true);
  });

  it("reads the parameter when the item carries it directly", () => {
    const p = extractTronParam(relayStep);
    expect(p.owner_address).toBe("41aee2ccd4ba42003a3307772fd409530c770c7674");
  });

  it("reads the parameter when nested under item.data.data", () => {
    const p = extractTronParam({ data: { data: relayStep } });
    expect(p.contract_address).toBe("41f0623e1012177482912fb057e44e1a9769b1f588");
  });

  it("throws on a non-Tron step shape", () => {
    expect(() => extractTronParam({ data: { from: "0x", to: "0x", value: "0" } })).toThrow();
  });
});
