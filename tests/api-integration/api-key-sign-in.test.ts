import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

async function seedApiKey(
  userId: string,
  overrides: Partial<{
    enabled: boolean;
    expiresAt: Date | null;
    permissions: Record<string, string[]> | null;
  }> = {},
) {
  const key = `api-key-sign-in-${randomUUID()}`.padEnd(64, "x");
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: createHash("sha256").update(key).digest("base64url"),
    enabled: overrides.enabled ?? true,
    expiresAt: overrides.expiresAt ?? null,
    permissions: overrides.permissions
      ? JSON.stringify(overrides.permissions)
      : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return key;
}

function signInLink(key: string, redirect?: string) {
  const params = new URLSearchParams({ key });
  if (redirect !== undefined) {
    params.set("redirect", redirect);
  }
  return `/api/auth/api-key/sign-in?${params.toString()}`;
}

function requestCookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function signIn(key: string, redirect?: string) {
  return createApp().app.request(signInLink(key, redirect));
}

describe("API integration: API key sign-in link", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays hidden until the operator opts in", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);

    const response = await signIn(key);

    expect(response.status).toBe(404);
  });

  it("rejects an unknown key without creating a session", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    await createWorkspaceMember();

    const response = await signIn("not-a-real-key".padEnd(64, "x"));

    expect(response.status).toBe(401);
    expect(await db.select().from(schema.sessionTable)).toHaveLength(0);
  });

  it("rejects a disabled or expired key", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    const member = await createWorkspaceMember();
    const disabled = await seedApiKey(member.user.id, { enabled: false });
    const expired = await seedApiKey(member.user.id, {
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await signIn(disabled)).status).toBe(401);
    expect((await signIn(expired)).status).toBe(401);
  });

  it("refuses a scoped key, which grants less than a session", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id, {
      permissions: { task: ["read"] },
    });

    const response = await signIn(key);

    expect(response.status).toBe(403);
    expect(await db.select().from(schema.sessionTable)).toHaveLength(0);
  });

  it("signs the key owner in and redirects into the web app", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);
    const { app } = createApp();

    const response = await app.request(signInLink(key));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost:5173/dashboard",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const sessionResponse = await app.request("/api/auth/get-session", {
      headers: { cookie: requestCookieHeader(response) },
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      user: { id: string };
    } | null;
    expect(session?.user.id).toBe(member.user.id);
  });

  it("keeps the session cookie to the browser session", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);

    const response = await signIn(key);

    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("session_token"));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).not.toMatch(/Max-Age=\d/i);
  });

  it("only honors a same-site redirect target", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);

    const offSite = await signIn(key, "//evil.example.com");
    expect(offSite.headers.get("location")).toBe(
      "http://localhost:5173/dashboard",
    );

    const inApp = await signIn(key, "/settings/account");
    expect(inApp.headers.get("location")).toBe(
      "http://localhost:5173/settings/account",
    );
  });

  it("can be limited to instance administrators", async () => {
    vi.stubEnv("API_KEY_SIGN_IN", "true");
    vi.stubEnv("API_KEY_SIGN_IN_ADMIN_ONLY", "true");
    const member = await createWorkspaceMember();
    const memberKey = await seedApiKey(member.user.id);

    expect((await signIn(memberKey)).status).toBe(403);

    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, member.user.id));
    const adminKey = await seedApiKey(member.user.id);

    expect((await signIn(adminKey)).status).toBe(302);
  });
});
