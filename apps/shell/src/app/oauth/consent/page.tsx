import { redirect } from "next/navigation";
import { getCoreOrigin } from "../../shell/server-env";

export const dynamic = "force-dynamic";

// Existing bookmarks continue on Core's consent surface. Only the request identifier is forwarded.
export default async function ConsentRoute({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const query = await searchParams;
  redirect(`${getCoreOrigin()}/oauth/consent?request=${encodeURIComponent(typeof query.request === "string" ? query.request : "")}`);
}
