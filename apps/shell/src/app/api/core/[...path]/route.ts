import { proxyCore } from "../../../shell/app-auth-server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxyCore(request, (await context.params).path);
}
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
