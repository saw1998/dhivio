import { z } from "zod";

/**
 * Server-side error returned by all @carbon/razorpay server functions.
 * `code` maps cleanly onto an HTTP status in route handlers:
 *   - "invalid_amount"        -> 400
 *   - "missing_fields"        -> 400
 *   - "signature_mismatch"    -> 400
 *   - "not_initialized"       -> 500
 *   - "auth_failed"           -> 401
 *   - "razorpay_api_error"    -> 500
 */
export type RazorpayErrorCode =
  | "invalid_amount"
  | "missing_fields"
  | "signature_mismatch"
  | "not_initialized"
  | "auth_failed"
  | "razorpay_api_error";

export type RazorpayResult<T> =
  | { success: true; data: T; error?: undefined }
  | {
      success: false;
      data?: undefined;
      error: { code: RazorpayErrorCode; message: string };
    };

export const CreateOrderInputSchema = z.object({
  /** Amount in the smallest currency unit (paise for INR). Minimum 100. */
  amount: z.number().int().min(100, "amount must be >= 100 paise"),
  /** ISO 4217 currency code. Defaults to INR. */
  currency: z.string().min(3).max(3).default("INR"),
  /** Your internal receipt id (max 40 chars per Razorpay). */
  receipt: z.string().min(1).max(40),
  /** Optional key-value notes attached to the order. */
  notes: z.record(z.string(), z.string()).optional()
});

export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

export type CreatedOrder = {
  orderId: string;
  amount: number;
  currency: string;
  receipt: string;
  /** Public key id, safe to expose to the frontend. */
  keyId: string;
};

export const VerifySignatureInputSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1)
});

export type VerifySignatureInput = z.infer<typeof VerifySignatureInputSchema>;

/**
 * The payload Razorpay Checkout posts to your `handler` callback on success.
 * Forward all three fields to your verify endpoint.
 */
export type RazorpayPaymentResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

/**
 * Subset of options accepted by `Razorpay.open(...)`.
 * See https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
 */
export type RazorpayCheckoutOptions = {
  /** Public key id (`rzp_test_...` / `rzp_live_...`). */
  key: string;
  /** Amount in paise. */
  amount: number;
  currency: string;
  /** Order id returned by the create-order endpoint. */
  order_id: string;
  name?: string;
  description?: string;
  image?: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: RazorpayPaymentResponse) => void;
  modal?: {
    ondismiss?: () => void;
    escape?: boolean;
    backdropclose?: boolean;
  };
};

export type RazorpayPaymentFailedEvent = {
  error: {
    code: string;
    description: string;
    source: string;
    step: string;
    reason: string;
    metadata?: {
      order_id?: string;
      payment_id?: string;
    };
  };
};
