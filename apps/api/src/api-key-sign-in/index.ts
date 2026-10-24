import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { hasInstanceAdminRole } from "../utils/instance-admin-role";
import { verifyApiKey } from "../utils/verify-api-key";

const DEFAULT_REDIRECT = "/dashboard";

/**
 * Only same-site absolute paths may be used as the redirect target, so a
 * crafted `?redirect=` value cannot bounce a freshly signed-in browser to
 * another origin.
 */
export function safeRedirectPath(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("//")
    ? value
    : DEFAULT_REDIRECT;
}

function isEnabled(name: string) {
  return process.env[name] === "true";
}

/**
 * Sign in with an API key carried in a link:
 * `GET /api/auth/api-key/sign-in?key=<API_KEY>&redirect=/dashboard`.
 *
 * Operator opt-in (`API_KEY_SIGN_IN=true`) because the endpoint trades a
 * long-lived API key for a full user session — more than an API key can do on
 * its own, since session-only routes reject API keys (`requireUserSession`).
 */
export const apiKeySignIn = () => ({
  id: "api-key-sign-in",
  endpoints: {
    signInWithApiKey: createAuthEndpoint(
      "/api-key/sign-in",
      {
        method: "GET",
        query: z.object({
          key: z.string().min(1),
          redirect: z.string().optional(),
        }),
      },
      async (ctx) => {
        if (!isEnabled("API_KEY_SIGN_IN")) {
          throw new APIError("NOT_FOUND");
        }

        // Reuses the ordinary API key checks: enabled, not expired, owner not
        // banned, plus rate limit/quota accounting.
        const result = await verifyApiKey(ctx.query.key);
        if (result?.status !== "valid") {
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_API_KEY",
            message: "Invalid API key",
          });
        }

        // A scoped key grants less than a session; never let one mint a session.
        if (result.key.permissions) {
          throw new APIError("FORBIDDEN", {
            code: "SCOPED_API_KEY_NOT_ALLOWED",
            message: "A key without permission scopes is required",
          });
        }

        const user = await ctx.context.internalAdapter.findUserById(
          result.key.userId,
        );
        if (!user) {
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_API_KEY",
            message: "Invalid API key",
          });
        }

        if (
          isEnabled("API_KEY_SIGN_IN_ADMIN_ONLY") &&
          !hasInstanceAdminRole(user.role)
        ) {
          throw new APIError("FORBIDDEN", {
            code: "INSTANCE_ADMIN_REQUIRED",
            message: "Only instance administrators may use sign-in links",
          });
        }

        // `dontRememberMe` keeps this to a browser-session cookie: a link is a
        // convenience, not a permanent login.
        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          true,
        );
        await setSessionCookie(ctx, { session, user }, true);

        const clientUrl = (process.env.KANEO_CLIENT_URL || "").replace(
          /\/$/,
          "",
        );
        ctx.setHeader("Referrer-Policy", "no-referrer");
        ctx.setHeader("Cache-Control", "no-store");
        throw ctx.redirect(
          `${clientUrl}${safeRedirectPath(ctx.query.redirect)}`,
        );
      },
    ),
  },
  rateLimit: [
    {
      pathMatcher: (path: string) => path.startsWith("/api-key/sign-in"),
      window: 60,
      max: 10,
    },
  ],
});
