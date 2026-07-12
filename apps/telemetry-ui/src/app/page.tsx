import { redirect } from "next/navigation";

// The manifest entrypoint is /metrics; a bare "/" (e.g. hand-typed) lands on Metrics too.
export default function Home() {
  redirect("/metrics");
}
