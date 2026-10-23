import type Stripe from "stripe";
import { isLabAccount, LAB_ACCOUNT_TAG } from "./connect/account";
import {
  chargeModelOf,
  isLabObject,
  LabRuleError,
  refundableOf,
  requireLabChargeOf,
  requireLabPaymentIntent,
  requireReadyLabAccount,
  sellerAccountOf,
} from "./rules";
import type { ApplicationFeeRefundBody, RefundBody, ReversalBody, TransferBody } from "./schemas";

// Refunds, transfers, transfer reversals and application fee refunds. Every function
// re-reads the current Stripe state and refuses (LabRuleError, nothing sent to Stripe)
// when the object is not the lab's, the account is not the lab account, or the amount
// exceeds what the current state allows.

export type MoneyResult = {
  ok: true;
  operation: "refund" | "transfer" | "transfer_reversal" | "application_fee_refund";
  requestId: string | null;
  idempotencyKey: string;
  objectId: string;
  amount: number;
  status: string | null;
  raw: unknown;
};

const TAG = { lab: LAB_ACCOUNT_TAG.lab };
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

async function requireLabAccount(stripe: Stripe, accountId: string) {
  if (!isLabAccount(await stripe.accounts.retrieve(accountId))) {
    throw new LabRuleError(`Konto ${accountId} nie jest kontem laboratorium; operacja jest zablokowana.`, 403);
  }
}

/** The lab PaymentIntent behind a platform charge, or a rule error. */
async function requireLabPaymentIntentOfCharge(stripe: Stripe, chargeId: string | null) {
  if (!chargeId) throw new LabRuleError("Obiekt nie jest powiązany z obciążeniem laboratorium.", 403);
  const charge = await stripe.charges.retrieve(chargeId);
  const piId = idOf(charge.payment_intent);
  if (!piId) throw new LabRuleError("Obciążenie nie ma PaymentIntent; operacja jest zablokowana.", 403);
  return requireLabPaymentIntent(stripe, piId);
}

export async function refundPayment(stripe: Stripe, paymentIntentId: string, body: RefundBody): Promise<MoneyResult> {
  const pi = await requireLabPaymentIntent(stripe, paymentIntentId);
  if (pi.status !== "succeeded") {
    throw new LabRuleError(`Zwrot wymaga przechwyconej płatności (status succeeded; obecnie: ${pi.status}). Nieprzechwyconą autoryzację należy anulować.`);
  }
  const charge = await requireLabChargeOf(stripe, pi);
  const refundable = refundableOf(charge);
  if (refundable <= 0) throw new LabRuleError("Ta płatność została już w całości zwrócona.");
  const amount = body.amount ?? refundable;
  if (amount > refundable) throw new LabRuleError(`Kwota zwrotu ${amount} przekracza kwotę możliwą do zwrotu (${refundable}).`, 422);

  if ((body.reverseTransfer || body.refundApplicationFee) && chargeModelOf(pi) !== "destination") {
    throw new LabRuleError("reverse_transfer i refund_application_fee dotyczą tylko Destination Charge. W modelu Separate Charges and Transfers cofnij przelew osobno.", 422);
  }
  const seller = sellerAccountOf(pi);
  if (body.reverseTransfer && seller) await requireLabAccount(stripe, seller);

  const refund = await stripe.refunds.create(
    {
      payment_intent: pi.id,
      amount,
      ...(body.reverseTransfer && { reverse_transfer: true }),
      ...(body.refundApplicationFee && { refund_application_fee: true }),
      metadata: TAG,
    },
    { idempotencyKey: body.idempotencyKey },
  );
  return {
    ok: true,
    operation: "refund",
    requestId: refund.lastResponse?.requestId ?? null,
    idempotencyKey: body.idempotencyKey,
    objectId: refund.id,
    amount: refund.amount,
    status: refund.status ?? null,
    raw: refund,
  };
}

/** Net amount already transferred for a Separate Charges and Transfers payment. */
export async function transferredForGroup(stripe: Stripe, transferGroup: string) {
  let net = 0;
  for await (const t of stripe.transfers.list({ transfer_group: transferGroup, limit: 100 })) net += t.amount - t.amount_reversed;
  return net;
}

export async function createTransfer(stripe: Stripe, body: TransferBody): Promise<MoneyResult> {
  const pi = await requireLabPaymentIntent(stripe, body.paymentIntentId);
  if (chargeModelOf(pi) !== "separate" || !pi.transfer_group) {
    throw new LabRuleError("Ręczny przelew dotyczy tylko modelu Separate Charges and Transfers. W Destination Charge przelew tworzy Stripe przy przechwyceniu.", 422);
  }
  if (pi.status !== "succeeded") throw new LabRuleError(`Przelew wymaga przechwyconej płatności (obecnie: ${pi.status}).`);
  const seller = sellerAccountOf(pi);
  if (!seller) throw new LabRuleError("PaymentIntent nie wskazuje konta sprzedawcy (metadata.lab_destination).", 422);
  await requireReadyLabAccount(stripe, seller);

  const charge = await requireLabChargeOf(stripe, pi);
  const transferable = refundableOf(charge) - (await transferredForGroup(stripe, pi.transfer_group));
  if (transferable <= 0) throw new LabRuleError("Brak środków z tej płatności do przekazania (zwrócone lub już przekazane).");
  if (body.amount > transferable) {
    throw new LabRuleError(`Kwota przelewu ${body.amount} przekracza środki z tej płatności możliwe do przekazania (${transferable}).`, 422);
  }

  const transfer = await stripe.transfers.create(
    {
      amount: body.amount,
      currency: "pln",
      destination: seller,
      // Funds the transfer from this charge, not from the platform's available balance.
      source_transaction: charge.id,
      transfer_group: pi.transfer_group,
      metadata: { ...TAG, payment_intent: pi.id, ...(pi.metadata?.booking_id && { booking_id: pi.metadata.booking_id }) },
    },
    { idempotencyKey: body.idempotencyKey },
  );
  return {
    ok: true,
    operation: "transfer",
    requestId: transfer.lastResponse?.requestId ?? null,
    idempotencyKey: body.idempotencyKey,
    objectId: transfer.id,
    amount: transfer.amount,
    status: null,
    raw: transfer,
  };
}

export async function reverseTransfer(stripe: Stripe, transferId: string, body: ReversalBody): Promise<MoneyResult> {
  const transfer = await stripe.transfers.retrieve(transferId);
  // Lab transfers are tagged; Destination Charge transfers are created by Stripe and are
  // owned through their source charge's lab PaymentIntent.
  if (!isLabObject(transfer)) await requireLabPaymentIntentOfCharge(stripe, idOf(transfer.source_transaction));
  const destination = idOf(transfer.destination);
  if (!destination) throw new LabRuleError("Przelew nie ma konta docelowego.", 422);
  await requireLabAccount(stripe, destination);

  const remaining = transfer.amount - transfer.amount_reversed;
  if (remaining <= 0) throw new LabRuleError("Ten przelew został już w całości cofnięty.");
  const amount = body.amount ?? remaining;
  if (amount > remaining) throw new LabRuleError(`Kwota cofnięcia ${amount} przekracza nie cofniętą część przelewu (${remaining}).`, 422);

  const reversal = await stripe.transfers.createReversal(transferId, { amount, metadata: TAG }, { idempotencyKey: body.idempotencyKey });
  return {
    ok: true,
    operation: "transfer_reversal",
    requestId: reversal.lastResponse?.requestId ?? null,
    idempotencyKey: body.idempotencyKey,
    objectId: reversal.id,
    amount: reversal.amount,
    status: null,
    raw: reversal,
  };
}

export async function refundApplicationFee(stripe: Stripe, feeId: string, body: ApplicationFeeRefundBody): Promise<MoneyResult> {
  const fee = await stripe.applicationFees.retrieve(feeId);
  // fee.charge is the seller-side payment (py_… on the connected account); the platform
  // charge that carries the lab PaymentIntent is originating_transaction.
  await requireLabPaymentIntentOfCharge(stripe, idOf(fee.originating_transaction));
  await requireLabAccount(stripe, idOf(fee.account)!);
  const remaining = fee.amount - fee.amount_refunded;
  if (remaining <= 0) throw new LabRuleError("Prowizja została już w całości zwrócona sprzedawcy.");
  const amount = body.amount ?? remaining;
  if (amount > remaining) throw new LabRuleError(`Kwota zwrotu prowizji ${amount} przekracza nie zwróconą część (${remaining}).`, 422);

  const refund = await stripe.applicationFees.createRefund(feeId, { amount, metadata: TAG }, { idempotencyKey: body.idempotencyKey });
  return {
    ok: true,
    operation: "application_fee_refund",
    requestId: refund.lastResponse?.requestId ?? null,
    idempotencyKey: body.idempotencyKey,
    objectId: refund.id,
    amount: refund.amount,
    status: null,
    raw: refund,
  };
}
