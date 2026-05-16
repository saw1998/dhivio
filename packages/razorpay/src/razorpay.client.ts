/**
 * Browser-only Razorpay Standard Checkout helpers.
 *
 * IMPORTANT: This file MUST NOT import anything from `razorpay.server.ts`,
 * `@carbon/env`, or anything that touches `KEY_SECRET`. Only the public
 * `KEY_ID` is allowed in client bundles.
 */

import type {
  RazorpayCheckoutOptions,
  RazorpayPaymentFailedEvent,
  RazorpayPaymentResponse
} from "./types.js";

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

type RazorpayCtor = new (
  options: RazorpayCheckoutOptions
) => {
  open: () => void;
  on: (
    event: "payment.failed",
    handler: (event: RazorpayPaymentFailedEvent) => void
  ) => void;
  close: () => void;
};

declare global {
  interface Window {
    Razorpay?: RazorpayCtor;
  }
}

let scriptPromise: Promise<void> | null = null;

/**
 * Inject the Razorpay Checkout script into the document. Idempotent —
 * subsequent calls return the same promise.
 */
export function loadRazorpayCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("loadRazorpayCheckoutScript can only run in the browser")
    );
  }

  if (window.Razorpay) {
    return Promise.resolve();
  }

  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHECKOUT_SCRIPT_SRC}"]`
    );

    const onLoad = () => {
      if (window.Razorpay) {
        resolve();
      } else {
        reject(new Error("Razorpay script loaded but window.Razorpay missing"));
      }
    };
    const onError = () =>
      reject(new Error("Failed to load Razorpay Checkout script"));

    if (existing) {
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export type OpenRazorpayCheckoutArgs = Omit<
  RazorpayCheckoutOptions,
  "handler"
> & {
  onSuccess: (response: RazorpayPaymentResponse) => void;
  onDismiss?: () => void;
  onFailure?: (event: RazorpayPaymentFailedEvent) => void;
};

/**
 * Load the script (if needed) and open the Razorpay Checkout modal.
 *
 * Wires up:
 *   - `handler`         -> `onSuccess`
 *   - `modal.ondismiss` -> `onDismiss`
 *   - `payment.failed`  -> `onFailure`
 */
export async function openRazorpayCheckout(
  args: OpenRazorpayCheckoutArgs
): Promise<void> {
  await loadRazorpayCheckoutScript();

  const Ctor = window.Razorpay;
  if (!Ctor) {
    throw new Error("Razorpay Checkout is unavailable");
  }

  const { onSuccess, onDismiss, onFailure, modal, ...rest } = args;

  const options: RazorpayCheckoutOptions = {
    ...rest,
    handler: onSuccess,
    modal: {
      ...modal,
      ondismiss: () => {
        modal?.ondismiss?.();
        onDismiss?.();
      }
    }
  };

  const instance = new Ctor(options);

  if (onFailure) {
    instance.on("payment.failed", onFailure);
  }

  instance.open();
}

export type {
  RazorpayCheckoutOptions,
  RazorpayPaymentFailedEvent,
  RazorpayPaymentResponse
} from "./types.js";
