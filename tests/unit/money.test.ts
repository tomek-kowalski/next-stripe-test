import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PaymentDetails } from "@/lib/lab/details";
import { moneyStory, readMoney } from "@/app/_components/money";
import { formatZl, parseZl } from "@/app/_components/zl-input";

describe("złoty input", () => {
  it("parses złoty to integer grosze", () => {
    expect(parseZl("50")).toBe(5000);
    expect(parseZl("50,00")).toBe(5000);
    expect(parseZl("12,5")).toBe(1250);
    expect(parseZl("0.01")).toBe(1);
    expect(parseZl(" 1 000,99 ")).toBe(100099);
  });

  it("rejects invalid amounts", () => {
    for (const bad of ["", "0", "0,00", "-5", "1,234", "abc", "5zł"]) expect(parseZl(bad), bad).toBeNull();
  });

  it("formats grosze with a Polish decimal comma", () => {
    expect(formatZl(5000)).toBe("50,00");
    expect(formatZl(1)).toBe("0,01");
  });
});

// Real Sandbox evidence from tests/integration/phase3.sandbox.test.ts, when it has been run locally.
const evidence = (name: string) => `test-results/sandbox/phase3-${name}-details.json`;
const load = (name: string) => JSON.parse(readFileSync(evidence(name), "utf8")) as PaymentDetails;

describe.skipIf(!existsSync(evidence("destination")))("money reading on real Sandbox payments", () => {
  it("destination: partial capture, partial refund, fee refund, manual reversal", () => {
    const m = readMoney(load("destination"));
    expect(m).toMatchObject({ captured: 3000, released: 2000, refunded: 1000, stripeFee: 198, transfersGross: 3000, reversals: 1500, commissionGross: 300, commissionRefunded: 200, sellerNet: 1400, platformNet: 402 });
  });

  it("separate: everything refunded and reversed", () => {
    const m = readMoney(load("separate"));
    expect(m).toMatchObject({ captured: 5000, refunded: 5000, transfersGross: 4500, reversals: 4500, sellerNet: 0, platformNet: -263, transferable: 0, reversibleTransferId: null });
    expect(moneyStory(load("separate")).join(" ")).toContain("nie zwraca jej przy zwrocie");
  });

  it("cancelled hold: released, nothing paid, no money flows", () => {
    const d = load("cancel");
    expect(readMoney(d)).toMatchObject({ captured: 0, released: 5000, stripeFee: 0, platformNet: 0 });
    expect(moneyStory(d)[0]).toContain("zwolniona");
  });
});
