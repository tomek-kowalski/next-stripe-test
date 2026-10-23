import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { listLabAccounts } from "@/lib/lab/connect/account";
import { PHASE_2_SCENARIOS, runConnectScenario } from "@/lib/lab/connect/scenarios";
import { getStripe } from "@/lib/stripe/client";

// Runs against the real Stripe Sandbox on the single connected account tagged
// metadata.lab = stripe-connect-lab (or LAB_CONNECTED_ACCOUNT_ID). Never creates accounts.
const hasSandboxKey = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "");

describe.skipIf(!hasSandboxKey)("Phase 2 Connect scenarios against Stripe Sandbox", () => {
  let accountId: string;

  beforeAll(async () => {
    const configured = process.env.LAB_CONNECTED_ACCOUNT_ID;
    if (configured) {
      accountId = configured;
      return;
    }
    const labAccounts = await listLabAccounts(getStripe());
    if (labAccounts.length !== 1) throw new Error(`Expected exactly one lab account, found ${labAccounts.length}; set LAB_CONNECTED_ACCOUNT_ID.`);
    accountId = labAccounts[0].id;
  }, 60_000);

  for (const scenario of PHASE_2_SCENARIOS) {
    it(scenario.id, async () => {
      const run = await runConnectScenario(getStripe(), scenario.id, accountId);
      mkdirSync("test-results/sandbox", { recursive: true });
      writeFileSync(`test-results/sandbox/phase2-${scenario.id}.json`, JSON.stringify(run, null, 2));
      expect(run.error).toBeNull();
      expect(run.checks.filter((c) => !c.pass)).toEqual([]);
    }, 120_000);
  }
});
