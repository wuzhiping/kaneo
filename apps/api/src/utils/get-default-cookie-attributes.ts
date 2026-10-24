type CookieAttributeUrls = {
  apiUrl: string;
  clientUrl: string;
  cookieDomain?: string;
};

// `KANEO_COOKIE_SAMESITE=none` forces the session/cookie attributes to the
// cross-site-safe shape (SameSite=None; Secure; Partitioned), so that a
// browser can store and send the cookie from a third-party iframe (CHIPS).
// Without `Secure`, browsers reject `SameSite=None` outright, so warn when
// the operator enables this on a plain-HTTP deployment.
const forceCrossSite = process.env.KANEO_COOKIE_SAMESITE === "none";

export function getDefaultCookieAttributes({
  apiUrl,
  clientUrl,
  cookieDomain,
}: CookieAttributeUrls) {
  const parsedApiUrl = (() => {
    try {
      return new URL(apiUrl);
    } catch {
      return undefined;
    }
  })();
  const isHttps = parsedApiUrl?.protocol === "https:";
  const isCrossSubdomain = (() => {
    try {
      const apiHost = parsedApiUrl?.hostname;
      const clientHost = new URL(clientUrl).hostname;
      return (
        apiHost !== undefined &&
        apiHost !== clientHost &&
        apiHost !== "localhost" &&
        clientHost !== "localhost"
      );
    } catch {
      return false;
    }
  })();

  if (forceCrossSite && !isHttps) {
    console.warn(
      "[cookies] KANEO_COOKIE_SAMESITE=none is set but the API is not served over HTTPS. SameSite=None requires Secure; browsers will reject the cookie. Use HTTPS or unset the env var.",
    );
  }

  return {
    sameSite: forceCrossSite
      ? ("none" as const)
      : isCrossSubdomain && isHttps
        ? ("none" as const)
        : ("lax" as const),
    secure: forceCrossSite ? true : isHttps,
    partitioned: forceCrossSite
      ? true
      : isCrossSubdomain && isHttps,
    domain: cookieDomain || undefined,
  };
}
