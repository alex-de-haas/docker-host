import { renewAppLogin } from "@/app/shell/app-auth-server";

// The shared SDK endpoint preserves Shell's HttpOnly-only credential transport.
export const POST = renewAppLogin;
