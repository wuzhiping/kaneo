import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { User } from "better-auth/types";
import db, { schema } from "../database";
import { publishEvent } from "../events";
import { hasInstanceAdminRole } from "./instance-admin-role";
import { isBanActive } from "./user-ban";

const RUN_AS_HEADERS = ["x-run-as", "x-kaneo-run-as"];
const RUN_AS_TARGET_KEY = "runAsTargetId";

export function isRunAsEnabled() {
  return process.env.RUN_AS_ENABLED !== "false";
}

async function resolveTarget(identifier: string) {
  const [byId] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.id, identifier))
    .limit(1);
  if (byId) return byId;

  const [byEmail] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.email, identifier.toLowerCase()))
    .limit(1);
  return byEmail ?? null;
}

/**
 * Act as another user.
 *
 * Only reachable for API-key authenticated requests: the key owner has to be an
 * instance administrator. The key's own permission scope stays in the context,
 * so it keeps acting as a ceiling on what the target may do.
 *
 * Returns the target user id, or null when the request carries no run-as
 * header.
 */
export async function applyRunAs(
  c: Context,
  actor: { actorUserId: string; actorApiKeyId: string },
): Promise<string | null> {
  // The request may resolve the identity twice (the global auth middleware and
  // the asset route resolver). Applying the swap once keeps the trail honest.
  const applied = c.get(RUN_AS_TARGET_KEY) as string | undefined;
  if (applied) return applied;

  const identifier = RUN_AS_HEADERS.map((h) => c.req.header(h)).find((v) =>
    v?.trim(),
  )?.trim();
  if (!identifier) return null;

  if (!isRunAsEnabled()) {
    throw new HTTPException(403, {
      message: "Run-as is not enabled on this instance",
    });
  }

  // The actor's role is read fresh: an administrator can be demoted after the
  // key was issued.
  const [actorRow] = await db
    .select({ id: schema.userTable.id, role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, actor.actorUserId))
    .limit(1);
  if (!actorRow || !hasInstanceAdminRole(actorRow.role)) {
    throw new HTTPException(403, {
      message: "Run-as requires an instance administrator",
    });
  }

  const target = await resolveTarget(identifier);
  if (!target) {
    throw new HTTPException(404, { message: "Run-as target not found" });
  }
  if (isBanActive(target)) {
    throw new HTTPException(403, { message: "Run-as target is banned" });
  }

  // Every downstream permission check reads userId / user, so swapping them
  // here is enough to act as the target.
  c.set("userId", target.id);
  c.set("userEmail", target.email);
  c.set("user", target as User);
  c.set(RUN_AS_TARGET_KEY, target.id);
  c.header("x-kaneo-run-as", target.id);

  // Trail: container log (durable per deployment) plus the realtime event bus.
  console.log(
    `[run-as] actor=${actorRow.id} target=${target.id} method=${c.req.method} path=${c.req.path}`,
  );
  await publishEvent("run_as.used", {
    actorUserId: actorRow.id,
    actorApiKeyId: actor.actorApiKeyId,
    targetUserId: target.id,
    method: c.req.method,
    path: c.req.path,
  });

  return target.id;
}
