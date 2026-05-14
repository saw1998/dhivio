import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const companyId = "********************";
const apiKey = "crbn_******************";
const publicApiKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxb2ppamlpamtuaGJneW9nbWx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjM2MDU0MzksImV4cCI6MjAzOTE4MTQzOX0.JMzLs9Y4Y4kQ-jhQHrSqgNyHSZgrkwzBd1PwPbVPtbQ";

const carbon = createClient("https://api.dhivio.com", publicApiKey, {
  global: {
    headers: {
      "carbon-key": apiKey,
    },
  },
});

(async () => {
  const { data, error } = await carbon
    .from("salesInvoice")
    .select(
      "*, salesInvoiceLine(*), salesInvoiceShipment(*), customer!salesInvoice_customerId_fkey(name, tags)"
    )
    .eq("companyId", companyId)
    .limit(1000)
    .order("createdAt", { ascending: false });

  if (data) {
    fs.writeFileSync(
      "sales-invoice-report.json",
      JSON.stringify(data, null, 2)
    );
  }

  if (error) {
    console.error(error);
  }
})();
