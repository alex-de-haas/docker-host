import metadata from "../../../package.json";
export function GET() { return Response.json({ status: "ok", app: "hosty.desktop", version: metadata.version }); }
