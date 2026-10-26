import { requireAdministrator, errorResponse, config, DocumentsError } from '@/lib/auth';
import { getAppId, getCoreOrigin } from '@hosty-sdk/app/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const credential = await requireAdministrator(request.headers);
    const origin = getCoreOrigin(), service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
    if (!origin || !service) throw new DocumentsError('Core source access is not configured.',503);
    const url = new URL(`/api/internal/apps/${encodeURIComponent(getAppId(config))}/source-documents/events`, origin);
    const repository = new URL(request.url).searchParams.get('repository');
    if (repository) url.searchParams.set('repositoryId',repository);
    const response = await fetch(url, { headers: { Authorization:`Bearer ${service}`, 'X-Hosty-User-Token':credential, Accept:'text/event-stream' }, signal:request.signal, redirect:'error', cache:'no-store' });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return Response.json({message:'Live source updates are unavailable. Refresh sources explicitly.'},{status:response.status===404?501:response.status===200?502:response.status});
    return new Response(response.body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
  } catch(error) { return errorResponse(error); }
}
