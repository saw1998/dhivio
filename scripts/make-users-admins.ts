// import type { User } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config();

console.log(process.env.PROD_SUPABASE_URL);

const supabaseAdmin = createClient(
  process.env.PROD_SUPABASE_URL!,
  process.env.PROD_SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

(async () => {
  const { data: users } = await supabaseAdmin
    .from("user")
    .select("id, email")
    .ilike("email", "%@dhivio.com");

  if (!users) throw new Error("No users found");

  const userIds = users.map((user) => user.id);
  const commaSeparatedIds = userIds.join(", ");

  console.log("User IDs:", commaSeparatedIds);

  // Save to file
  const fs = require("fs");
  fs.writeFileSync("user-ids.txt", commaSeparatedIds);
  console.log("User IDs saved to user-ids.txt");
})();
