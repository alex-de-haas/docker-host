import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Keep old links, including assistant-session continuations, without rendering another app catalog.
export default async function AppsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  const search = query.toString();
  redirect(search ? `/?${search}` : "/");
}
