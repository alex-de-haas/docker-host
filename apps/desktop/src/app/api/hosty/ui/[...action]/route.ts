import { createHostyUiRouteHandler } from "@hosty-sdk/app/server";
import { authConfig } from "@/lib/auth";
export const dynamic = "force-dynamic";
const handler = createHostyUiRouteHandler(authConfig);
export { handler as GET, handler as POST };
