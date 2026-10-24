import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { hasInstanceAdminRole } from "./instance-admin-role";

type ValidateWorkspaceAccessOptions = {
  notFoundMessage?: string;
};

export async function validateWorkspaceAccess(
  userId: string,
  workspaceId: string,
  apiKeyId?: string,
  options: ValidateWorkspaceAccessOptions = {},
): Promise<void> {
  if (apiKeyId) {
    // The key was already verified during authentication (enabled, not expired,
    // owner not banned). Its owner is deliberately not compared to the
    // effective user: with run-as the effective user is the target while the
    // key belongs to the acting administrator.
    const [apiKey] = await db
      .select({ id: schema.apikeyTable.id })
      .from(schema.apikeyTable)
      .where(
        and(
          eq(schema.apikeyTable.id, apiKeyId),
          eq(schema.apikeyTable.enabled, true),
        ),
      )
      .limit(1);

    if (!apiKey) {
      throw new HTTPException(403, {
        message: "Invalid API key for this workspace",
      });
    }
  }

  const notFound = () =>
    new HTTPException(404, {
      message: options.notFoundMessage ?? "Workspace not found",
    });

  const [user] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (hasInstanceAdminRole(user?.role)) {
    const [workspace] = await db
      .select({ id: schema.workspaceTable.id })
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, workspaceId))
      .limit(1);

    if (!workspace) {
      throw notFound();
    }
    return;
  }

  const membership = await db
    .select()
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.userId, userId),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    throw notFound();
  }
}
