import { getIdentity } from "@/lib/auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const identity = await getIdentity(request.headers);
  return Response.json(identity.status === "active" && identity.hostRole !== "host.admin" ? {
    ...identity, status: "forbidden", error: { status: 403, code: "administrator_required", message: "Plans is available only to Hosty administrators." },
  } : identity, { headers: { "Cache-Control": "no-store" } });
}
