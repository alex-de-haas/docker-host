import { NextResponse } from "next/server";
import { moduleIdentityCookieName } from "@/lib/host-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const token = body && typeof body === "object" && "token" in body
    ? (body as { token?: unknown }).token
    : null;

  if (typeof token !== "string" || !token.trim()) {
    return NextResponse.json({
      error: {
        code: "module_identity_token_required",
        message: "A Docker Host module identity token is required.",
      },
    }, { status: 422 });
  }

  const response = NextResponse.json({
    ok: true,
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
  response.cookies.set(moduleIdentityCookieName, token.trim(), {
    httpOnly: true,
    sameSite: "lax",
    secure: request.url.startsWith("https://"),
    path: "/",
    maxAge: 5 * 60,
  });

  return response;
}
