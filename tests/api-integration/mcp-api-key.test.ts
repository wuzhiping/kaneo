import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const MCP_PATH = "/api/mcp";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-api-key-test", version: "0" },
  },
});

function postMcp(headers: Record<string, string>) {
  return createApp().app.request(MCP_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: INIT_BODY,
  });
}

async function seedApiKey(
  userId: string,
  overrides: Partial<{
    enabled: boolean;
    expiresAt: Date | null;
    permissions: Record<string, string[]> | null;
    rateLimitEnabled: boolean;
  }> = {},
) {
  const key = `mcp-api-key-${userId}-${Math.random().toString(36).slice(2)}`;
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: createHash("sha256").update(key).digest("base64url"),
    enabled: overrides.enabled ?? true,
    expiresAt: overrides.expiresAt ?? null,
    permissions: overrides.permissions
      ? JSON.stringify(overrides.permissions)
      : null,
    // Mirrors the production "create-mcp-api-key" script: unlimited.
    rateLimitEnabled: overrides.rateLimitEnabled ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return key;
}

function mockSessionForToken(token: string, user: typeof schema.userTable.$inferSelect) {
  return vi
    .spyOn(auth.api, "getSession")
    .mockImplementation(async (input: { headers?: Headers } | undefined) => {
      const authHeader = input?.headers?.get("authorization") ?? "";
      if (authHeader === `Bearer ${token}`) {
        return {
          session: {
            id: `session-${user.id}`,
            token,
            userId: user.id,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            createdAt: new Date(),
            updatedAt: new Date(),
            ipAddress: null,
            userAgent: null,
          },
          user,
        };
      }
      return null;
    });
}

describe("API integration: MCP accepts API key as Bearer (plan A)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts a valid API key as Bearer and returns 200 from /api/mcp", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);

    const response = await postMcp({ authorization: `Bearer ${key}` });

    expect(response.status).toBe(200);
  });

  it("returns 401 when MCP_ALLOW_API_KEY is explicitly false", async () => {
    vi.stubEnv("MCP_ALLOW_API_KEY", "false");
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);

    const response = await postMcp({ authorization: `Bearer ${key}` });

    expect(response.status).toBe(401);
  });

  it("regression: OAuth session tokens still work (Bearer session)", async () => {
    const member = await createWorkspaceMember();
    const fakeToken = "oauth-session-token-regression";
    mockSessionForToken(fakeToken, member.user);

    const response = await postMcp({ authorization: `Bearer ${fakeToken}` });

    expect(response.status).toBe(200);
  });

  it("returns 401 for an unknown Bearer value", async () => {
    const response = await postMcp({ authorization: "Bearer not-a-real-key" });
    expect(response.status).toBe(401);
  });

  it("returns 401 when the key has been disabled", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id, { enabled: false });

    const response = await postMcp({ authorization: `Bearer ${key}` });

    expect(response.status).toBe(401);
  });

  it("returns 401 when the key has expired", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await postMcp({ authorization: `Bearer ${key}` });

    expect(response.status).toBe(401);
  });

  it("returns 401 when the key owner is banned", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);
    await db
      .update(schema.userTable)
      .set({ banned: true, banExpires: null })
      .where(eq(schema.userTable.id, member.user.id));

    const response = await postMcp({ authorization: `Bearer ${key}` });

    expect(response.status).toBe(401);
  });

  it("accepts a scoped API key at the MCP layer (downstream enforces scope)", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id, {
      permissions: { task: ["read"] },
    });

    const response = await postMcp({ authorization: `Bearer ${key}` });

    // MCP transport does not inspect key scopes; downstream REST does.
    // This test confirms the shortcut itself is scope-agnostic at the edge.
    expect(response.status).toBe(200);
  });
});
