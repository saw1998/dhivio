import { defineConfig } from "tsup";

const isProduction = process.env.VERCEL_ENV === "production";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/razorpay.server.ts", "src/razorpay.client.ts"],
  format: ["cjs", "esm"],
  minify: isProduction,
  sourcemap: !isProduction,
});
