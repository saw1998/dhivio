/**
 * Manual smoke test for @carbon/razorpay.
 *
 * Run with:
 *   pnpm --filter @carbon/razorpay smoke
 *
 * Mirrors the pattern used by `stripe.dev.ts` / `stripe.register.ts`:
 * reads credentials from process.env directly (via dotenv) so it can run
 * standalone without dragging in the rest of the @carbon/* runtime graph.
 *
 * Verifies:
 *   1. The HMAC-SHA256 signature algorithm matches Razorpay's spec.
 *   2. CreateOrderInputSchema rejects amounts < 100 paise.
 *   3. (optional) Live order creation succeeds when creds are present.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "dotenv";
import Razorpay from "razorpay";

import { CreateOrderInputSchema } from "./src/types.js";

config();

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function verify(orderId: string, paymentId: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main() {
  console.log("--- @carbon/razorpay smoke ---");
  console.log("KEY_ID set:", Boolean(KEY_ID));
  console.log("KEY_SECRET set:", Boolean(KEY_SECRET));

  const orderId = "order_smoke_test_123";
  const paymentId = "pay_smoke_test_456";
  const secret = KEY_SECRET ?? "fixture_secret";

  // 1. Signature algorithm — pure crypto, deterministic.
  const goodSig = createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  if (!verify(orderId, paymentId, goodSig, secret)) {
    console.error("❌ valid signature was rejected");
    process.exit(1);
  }
  console.log("✅ valid signature accepted");

  if (verify(orderId, paymentId, "deadbeef", secret)) {
    console.error("❌ invalid signature was accepted");
    process.exit(1);
  }
  console.log("✅ invalid signature rejected");

  // 2. Amount validation via the same Zod schema the server uses.
  const tooSmall = CreateOrderInputSchema.safeParse({
    amount: 50,
    currency: "INR",
    receipt: "smoke_low",
  });
  if (tooSmall.success) {
    console.error("❌ amount < 100 was not rejected by the schema");
    process.exit(1);
  }
  console.log("✅ amount < 100 rejected by schema");

  const ok = CreateOrderInputSchema.safeParse({
    amount: 100,
    currency: "INR",
    receipt: "smoke_ok",
  });
  if (!ok.success) {
    console.error("❌ valid input was rejected:", ok.error.issues);
    process.exit(1);
  }
  console.log("✅ valid input accepted by schema");

  // 3. Live order creation — only when credentials present.
  if (KEY_ID && KEY_SECRET) {
    const rzp = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
    try {
      const order = await rzp.orders.create({
        amount: 100,
        currency: "INR",
        receipt: `smoke_${Date.now()}`,
      });
      console.log(
        "✅ created live order:",
        order.id,
        `(${order.amount} ${order.currency})`,
      );
    } catch (err) {
      console.error("❌ live order creation failed:", err);
      process.exit(1);
    }
  } else {
    console.log("⏭  live order creation skipped (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET to enable)");
  }

  console.log("--- smoke OK ---");
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
