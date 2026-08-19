import { describe, it, expect } from "vitest";
import { encodeTrc20Approve } from "./tronGrid";

describe("encodeTrc20Approve", () => {
  it("encodes approve selector and pads spender", () => {
    const data = encodeTrc20Approve("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 1000n);
    expect(data.startsWith("095ea7b3")).toBe(true);
    expect(data.length).toBe(8 + 64 + 64);
    expect(data.endsWith(1000n.toString(16).padStart(64, "0"))).toBe(true);
  });
});
