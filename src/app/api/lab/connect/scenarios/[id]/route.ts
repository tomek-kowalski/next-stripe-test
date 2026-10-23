import { z } from "zod";
import { retrieveLabAccount } from "@/lib/lab/connect/account";
import { handleConnect } from "@/lib/lab/connect/route";
import { PHASE_2_SCENARIOS, runConnectScenario } from "@/lib/lab/connect/scenarios";
import { ConnectedAccountIdSchema } from "@/lib/lab/schemas";

const BodySchema = z.strictObject({ accountId: ConnectedAccountIdSchema });
const ScenarioIdSchema = z.enum(PHASE_2_SCENARIOS.map((s) => s.id) as [string, ...string[]]);

export async function POST(request: Request, ctx: RouteContext<"/api/lab/connect/scenarios/[id]">) {
  const { id } = await ctx.params;
  return handleConnect(request, BodySchema, async (stripe, body) => {
    const scenarioId = ScenarioIdSchema.parse(id);
    // Money only moves to accounts this lab created.
    await retrieveLabAccount(stripe, body.accountId);
    return { ok: true, run: await runConnectScenario(stripe, scenarioId, body.accountId) };
  });
}
