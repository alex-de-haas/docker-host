import { notFound } from "next/navigation";
import { DOCUMENT_VIEWS, isDocumentView } from "@/lib/navigation";
import DocumentsPage from "../page";

export function generateStaticParams() {
  return DOCUMENT_VIEWS.filter(([view]) => view !== "home").map(([view]) => ({ view }));
}
export const dynamicParams = false;
export default async function Page({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params;
  if (!isDocumentView(view) || view === "home") notFound();
  return <DocumentsPage />;
}
