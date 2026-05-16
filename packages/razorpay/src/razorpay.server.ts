import { createHmac, timingSafeEqual } from "node:crypto";

import { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } from "@carbon/env";
import Razorpay from "razorpay";

import {
  type CreatedOrder,
  type CreateOrderInput,
  CreateOrderInputSchema,
  type RazorpayErrorCode,
  type RazorpayResult,
  type VerifySignatureInput,
  VerifySignatureInputSchema
} from "./types.js";

/**
 * Singleton Razorpay client. `null` when credentials are not configured
 * (mirrors the `@carbon/stripe` pattern where the SDK can be absent).
 */
export const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET
      })
    : null;

/** True when both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. */
export function isRazorpayConfigured(): boolean {
  return razorpay !== null;
}

/**
 * Returns the public key id for use by the frontend. Safe to expose.
 * Throws if Razorpay is not configured.
 */
export function getRazorpayKeyId(): string {
  if (!RAZORPAY_KEY_ID) {
    throw new Error("RAZORPAY_KEY_ID is not configured");
  }
  return RAZORPAY_KEY_ID;
}

/**
 * Create a Razorpay order. The returned `orderId` is what the frontend
 * passes to the Razorpay Checkout modal.
 *
 * Errors are returned as `{ success: false, error }` so route handlers can
 * map them to the correct HTTP status without try/catch boilerplate.
 */
export async function createRazorpayOrder(
  input: CreateOrderInput
): Promise<RazorpayResult<CreatedOrder>> {
  if (!razorpay) {
    return {
      success: false,
      error: {
        code: "not_initialized",
        message: "Razorpay is not configured on the server"
      }
    };
  }

  const parsed = CreateOrderInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      success: false,
      error: {
        code: first?.path[0] === "amount" ? "invalid_amount" : "missing_fields",
        message: first?.message ?? "Invalid order input"
      }
    };
  }

  const { amount, currency, receipt, notes } = parsed.data;

  try {
    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt,
      notes
    });

    return {
      success: true,
      data: {
        orderId: order.id,
        amount:
          typeof order.amount === "string"
            ? Number.parseInt(order.amount, 10)
            : order.amount,
        currency: order.currency,
        receipt: order.receipt ?? receipt,
        keyId: getRazorpayKeyId()
      }
    };
  } catch (err) {
    const error = err as {
      statusCode?: number;
      error?: { description?: string };
      message?: string;
    };
    const isAuth = error.statusCode === 401;
    return {
      success: false,
      error: {
        code: isAuth ? "auth_failed" : "razorpay_api_error",
        message:
          error.error?.description ??
          error.message ??
          "Failed to create Razorpay order"
      }
    };
  }
}

/**
 * Verify a Razorpay payment signature using HMAC-SHA256.
 *
 * Algorithm (per Razorpay docs):
 *   expected = HMAC_SHA256(`${orderId}|${paymentId}`, KEY_SECRET)
 *
 * The comparison is constant-time to prevent timing attacks.
 */
export function verifyRazorpaySignature(
  input: VerifySignatureInput
): RazorpayResult<{ verified: true }> {
  if (!RAZORPAY_KEY_SECRET) {
    return {
      success: false,
      error: {
        code: "not_initialized",
        message: "Razorpay is not configured on the server"
      }
    };
  }

  const parsed = VerifySignatureInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: "missing_fields",
        message: "orderId, paymentId and signature are all required"
      }
    };
  }

  const { orderId, paymentId, signature } = parsed.data;

  const expected = createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  // timingSafeEqual requires equal-length buffers; bail early if not.
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signature, "utf8");

  const matches =
    expectedBuf.length === providedBuf.length &&
    timingSafeEqual(expectedBuf, providedBuf);

  if (!matches) {
    return {
      success: false,
      error: {
        code: "signature_mismatch",
        message: "Razorpay signature verification failed"
      }
    };
  }

  return { success: true, data: { verified: true } };
}

/**
 * Fetch a payment by id. Useful for double-checking status after
 * signature verification (e.g. confirm `status === "captured"`).
 */
export async function getRazorpayPayment(paymentId: string) {
  if (!razorpay) {
    return {
      success: false as const,
      error: {
        code: "not_initialized" as const,
        message: "Razorpay is not configured on the server"
      }
    };
  }

  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return { success: true as const, data: payment };
  } catch (err) {
    const error = err as {
      statusCode?: number;
      error?: { description?: string };
      message?: string;
    };
    const code: RazorpayErrorCode =
      error.statusCode === 401 ? "auth_failed" : "razorpay_api_error";
    return {
      success: false as const,
      error: {
        code,
        message:
          error.error?.description ?? error.message ?? "Failed to fetch payment"
      }
    };
  }
}

export type {
  CreatedOrder,
  CreateOrderInput,
  RazorpayErrorCode,
  RazorpayResult,
  VerifySignatureInput
} from "./types.js";

("./types.js");
