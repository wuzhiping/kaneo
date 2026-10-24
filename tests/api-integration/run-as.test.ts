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
import { signUpWithSession } from "./helpers/auth-session";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const validTask = {
  title: "Run-as probe",
  description: "",
  priority: "low",
  status: "to-do",
};

async function seedApiKey(
  userId: string,
  permissions: Record<string, string[]> | null = null,
) {
  const key = `run-as-${randomUUID()}`.padEnd(64, "x");
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: createHash("sha256").update(key).digest("base64url"),
    enabled: true,
    // Unlimited, so the quota does not interfere with the assertions.
    rateLimitEnabled: false,
    permissions: permissions ? JSON.stringify(permissions) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return key;
}

async function createPlainUser(name = "Target User") {
  const userId = `user-${randomUUID()}`;
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      name,
    })
    .returning();
  return user;
}

async function setup() {
  const admin = await createWorkspaceMember({ role: "owner" });
  await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, admin.user.id));
  const adminKey = await seedApiKey(admin.user.id);
  const target = await createPlainUser();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: admin.workspace.id,
    userId: target.id,
    role: "member",
    joinedAt: new Date(),
  });
  const project = await createProjectFixture({
    workspaceId: admin.workspace.id,
  });
  return { admin, adminKey, target, project };
}

function getMe(headers: Record<string, string>) {
  return createApp().app.request("/api/user/me", { headers });
}

describe("API integration: run-as another user", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects run-as for a key that is not an instance administrator", async () => {
    const member = await createWorkspaceMember();
    const key = await seedApiKey(member.user.id);
    const target = await createPlainUser();

    const response = await getMe({
      authorization: `Bearer ${key}`,
      "x-run-as": target.email,
    });

    expect(response.status).toBe(403);
  });

  it("acts as the target user when the header names an email", async () => {
    const { adminKey, target } = await setup();

    const response = await getMe({
      authorization: `Bearer ${adminKey}`,
      "x-run-as": target.email,
    });

    expect(response.status).toBe(200);
    const me = (await response.json()) as { id: string; email: string };
    expect(me.id).toBe(target.id);
    expect(me.email).toBe(target.email);
    expect(response.headers.get("x-kaneo-run-as")).toBe(target.id);
  });

  it("acts as the target user when the header names a user id", async () => {
    const { adminKey, target } = await setup();

    const response = await getMe({
      authorization: `Bearer ${adminKey}`,
      "x-run-as": target.id,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe(target.id);
  });

  it("rejects an unknown target", async () => {
    const { adminKey } = await setup();

    const response = await getMe({
      authorization: `Bearer ${adminKey}`,
      "x-run-as": "nobody@example.com",
    });

    expect(response.status).toBe(404);
  });

  it("rejects a banned target", async () => {
    const { adminKey, target } = await setup();
    await db
      .update(schema.userTable)
      .set({ banned: true, banExpires: null })
      .where(eq(schema.userTable.id, target.id));

    const response = await getMe({
      authorization: `Bearer ${adminKey}`,
      "x-run-as": target.id,
    });

    expect(response.status).toBe(403);
  });

  it("ignores the header for session authenticated requests", async () => {
    vi.stubEnv("DISABLE_REGISTRATION", "false");
    const { app } = createApp();
    const { userId, cookies } = await signUpWithSession(app, {
      email: `session-${randomUUID()}@example.com`,
      name: "Session User",
    });
    const target = await createPlainUser();

    const response = await app.request("/api/user/me", {
      headers: { cookie: cookies, "x-run-as": target.email },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe(userId);
  });

  it("keeps the key scope as a ceiling on what the target may do", async () => {
    const admin = await createWorkspaceMember({ role: "owner" });
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, admin.user.id));
    const scopedKey = await seedApiKey(admin.user.id, { task: ["read"] });
    const target = await createPlainUser();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: admin.workspace.id,
      userId: target.id,
      role: "member",
      joinedAt: new Date(),
    });
    const project = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });

    const response = await createApp().app.request(
      `/api/task/${project.project.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${scopedKey}`,
          "x-run-as": target.id,
        },
        body: JSON.stringify(validTask),
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("API_KEY_SCOPE");
  });

  it("gives the target the target's own workspace access", async () => {
    const { adminKey, admin, project } = await setup();
    const outsider = await createPlainUser();

    // The acting administrator is a member of the workspace, the target is not.
    const response = await createApp().app.request(
      `/api/project/${project.project.id}`,
      {
        headers: {
          authorization: `Bearer ${adminKey}`,
          "x-run-as": outsider.id,
        },
      },
    );

    expect(response.status).toBe(404);

    // Without run-as the same key still reaches the project.
    const asAdmin = await createApp().app.request(
      `/api/project/${project.project.id}`,
      { headers: { authorization: `Bearer ${adminKey}` } },
    );
    expect(asAdmin.status).toBe(200);
    expect(admin.workspace.id).toBe(project.project.workspaceId);
  });
});
