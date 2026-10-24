/**
 * Create an MCP API key with the rate limit disabled (effectively unlimited).
 *
 * Usage:
 *   pnpm --filter @kaneo/api mcp:create-key -- --user me@example.com
 *   pnpm --filter @kaneo/api mcp:create-key -- --user me@example.com --name "MCP-prod"
 *
 * The script prints the raw key once. Store it securely; it is not shown again.
 *
 * Requires DATABASE_URL and AUTH_SECRET to be set (loads from .env via dotenv-mono
 * through the auth module import).
 */
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";
import { auth } from "../src/auth";
import db, { schema } from "../src/database";

const HELP = `Usage: mcp:create-key -- --user <email> [--name "MCP"] [--days 365]`;

function parseCli() {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      name: { type: "string", default: "MCP" },
      days: { type: "string", default: "365" },
    },
    allowPositionals: false,
  });
  if (!values.user) {
    console.error(HELP);
    throw new Error("Missing --user <email>");
  }
  const days = Number.parseInt(values.days, 10);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --days: ${values.days}`);
  }
  return { email: values.user, name: values.name, days };
}

async function findUserByEmail(email: string) {
  const [row] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.email, email))
    .limit(1);
  return row ?? null;
}

async function main() {
  const { email, name, days } = parseCli();

  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error(`No user with email ${email}`);
  }

  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const result = await auth.api.createApiKey({
    body: {
      name,
      userId: user.id,
      expiresAt,
      rateLimitEnabled: false,
      remaining: null,
      metadata: { purpose: "mcp" },
    },
  });

  if (!result || !("key" in result) || !result.key) {
    throw new Error("createApiKey did not return a key");
  }

  // Verify the server honored `rateLimitEnabled: false`. Different
  // better-auth versions may not accept every field; if the key is not
  // unlimited, patch the row directly so callers never hit a 429.
  const [row] = await db
    .select()
    .from(schema.apikeyTable)
    .where(eq(schema.apikeyTable.id, (result as { id: string }).id))
    .limit(1);
  if (row && row.rateLimitEnabled) {
    await db
      .update(schema.apikeyTable)
      .set({ rateLimitEnabled: false, remaining: null })
      .where(eq(schema.apikeyTable.id, row.id));
    console.warn(
      "[mcp:create-key] createApiKey ignored rateLimitEnabled; patched row directly.",
    );
  }

  const raw = (result as { key: string }).key;

  console.log("");
  console.log("MCP API key created. Store this value now; it is not shown again.");
  console.log(`  user:    ${user.email} (${user.id})`);
  console.log(`  name:    ${name}`);
  console.log(`  expires: ${expiresAt.toISOString()}`);
  console.log(`  key:     ${raw}`);
  console.log("");
  console.log("Example MCP client config:");
  console.log(`  Authorization: Bearer ${raw}`);
  console.log(`  POST ${process.env.KANEO_API_URL ?? "https://pl.feg.cn"}/api/mcp`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
