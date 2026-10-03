import { NextResponse, type NextRequest } from "next/server";

// Canonicalize only ordinary entry navigation. API calls, form bodies and code-bearing links
// stay on their requested origin; Core creates fresh authorization links on the canonical host.
export function proxy(request: NextRequest) {
  const configured = process.env.HOSTY_PUBLIC_ORIGIN_WEB?.trim();
  if (!configured || request.method !== "GET" || request.nextUrl.search ||
      request.headers.get("sec-fetch-mode") !== "navigate" ||
      request.headers.get("sec-fetch-dest") !== "document") return NextResponse.next();

  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return NextResponse.next();
  const target = new URL(configured);
  if (target.host.toLowerCase() === host.toLowerCase()) return NextResponse.next();
  target.pathname = request.nextUrl.pathname;
  const response = NextResponse.redirect(target, 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = { matcher: ["/", "/dashboard", "/apps/:path*", "/settings/:path*", "/users", "/installed-apps", "/system-apps/:path*", "/workspace"] };
