import type Stripe from "stripe";
import { checkAccountReadiness, isLabAccount, LAB_ACCOUNT_TAG } from "./connect/account";
import type { ChargeModel } from "./schemas";

/** A business rule refused the operation before anything was sent to Stripe. */
export class LabRuleError extends Error {
  readonly name = "LabRuleError";
  constructor(
    message: string,
    readonly status: 403 | 409 | 422 = 409,
  ) {
    super(message);
  }
}

export const isLabObject = (o: { metadata?: Stripe.Metadata | null }) => o.metadata?.lab === LAB_ACCOUNT_TAG.lab;

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

export function chargeModelOf(pi: Stripe.PaymentIntent): ChargeModel {
  if (pi.transfer_data?.destination) return "destination";
  if (pi.metadata?.charge_model === "separate" || pi.transfer_group) return "separate";
  return "platform";
}

/** The connected account a lab PaymentIntent pays out to, if any. */
export function sellerAccountOf(pi: Stripe.PaymentIntent): string | null {
  return idOf(pi.transfer_data?.destination) ?? pi.metadata?.lab_destination ?? null;
}

/** Only PaymentIntents created by this lab (metadata.lab) may be inspected in detail or mutated. */
export async function requireLabPaymentIntent(stripe: Stripe, id: string, expand?: string[]) {
  const pi = await stripe.paymentIntents.retrieve(id, expand ? { expand } : undefined);
  if (!isLabObject(pi)) {
    throw new LabRuleError("Ten PaymentIntent nie został utworzony przez laboratorium. Szczegóły i operacje finansowe są niedostępne.", 403);
  }
  return pi;
}

/** Money may only move to the tagged lab account, and only when Stripe reports it ready (Accounts v2). */
export async function requireReadyLabAccount(stripe: Stripe, accountId: string) {
  const account = await stripe.accounts.retrieve(accountId);
  if (!isLabAccount(account)) {
    throw new LabRuleError(`Konto ${accountId} nie jest kontem laboratorium. Może być tylko wyświetlane; nie może otrzymywać płatności, przelewów ani cofnięć.`, 403);
  }
  const readiness = await checkAccountReadiness(stripe, accountId);
  if (!readiness.ready) throw new LabRuleError(`Konto laboratorium nie jest gotowe: ${readiness.reasons.join("; ")}`);
  return readiness;
}

export async function requireLabChargeOf(stripe: Stripe, pi: Stripe.PaymentIntent) {
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId) throw new LabRuleError("PaymentIntent nie ma jeszcze obciążenia (Charge).");
  return stripe.charges.retrieve(chargeId);
}

const CANCELABLE = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"]);
const CONFIRMABLE = new Set(["requires_payment_method", "requires_confirmation"]);

export function assertConfirmable(pi: Stripe.PaymentIntent) {
  if (!CONFIRMABLE.has(pi.status)) throw new LabRuleError(`Autoryzacja wymaga statusu requires_payment_method (obecnie: ${pi.status}).`);
}

export function assertCancelable(pi: Stripe.PaymentIntent) {
  if (!CANCELABLE.has(pi.status)) {
    throw new LabRuleError(`Anulować można tylko nieprzechwyconą płatność (obecnie: ${pi.status}). Po przechwyceniu użyj zwrotu.`);
  }
}

export function assertCapturable(pi: Stripe.PaymentIntent, amountToCapture: number | undefined, applicationFeeAmount: number | undefined) {
  if (pi.status !== "requires_capture") throw new LabRuleError(`Przechwycenie wymaga statusu requires_capture (obecnie: ${pi.status}).`);
  const amount = amountToCapture ?? pi.amount_capturable;
  if (amount > pi.amount_capturable) {
    throw new LabRuleError(`Kwota przechwycenia ${amount} przekracza amount_capturable (${pi.amount_capturable}).`, 422);
  }
  if (applicationFeeAmount !== undefined) {
    if (chargeModelOf(pi) !== "destination") throw new LabRuleError("Prowizję przy przechwyceniu można ustawić tylko dla Destination Charge.", 422);
    if (applicationFeeAmount >= amount) throw new LabRuleError("Prowizja platformy musi być mniejsza od przechwytywanej kwoty.", 422);
  }
}

/** Amount still refundable on the charge (captured minus already refunded). */
export const refundableOf = (charge: Stripe.Charge) => charge.amount_captured - charge.amount_refunded;
