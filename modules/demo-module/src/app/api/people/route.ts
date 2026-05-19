import { NextResponse } from "next/server";
import { getDemoPeople } from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    people: getDemoPeople(),
  });
}
