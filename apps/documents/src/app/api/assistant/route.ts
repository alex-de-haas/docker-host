import { createDiscussion, discussionOptions } from "@/lib/discussion-server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = discussionOptions;
export const POST = createDiscussion;
