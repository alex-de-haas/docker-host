"use client";

import type { Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Markdown } from "@/components/markdown";

// GitHub bodies commonly mix Markdown with HTML disclosures. Parse first, then sanitize the
// entire tree before React renders it. Keep the shared URL policy and image-as-link renderer.
const htmlPlugins: Options["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, {
  ...defaultSchema,
  // No media sources alongside the shared renderer's deliberately inert image links.
  tagNames: defaultSchema.tagNames?.filter(tag => tag !== "picture" && tag !== "source"),
  strip: [...(defaultSchema.strip ?? []), "style", "iframe", "object", "embed", "svg", "math", "form"],
  attributes: {
    ...defaultSchema.attributes,
    "*": defaultSchema.attributes?.["*"]?.filter(attribute => attribute !== "accessKey" && attribute !== "tabIndex"),
  },
}]];

export function PullRequestMarkdown({ text }: { text: string }) {
  return <Markdown text={text} rehypePlugins={htmlPlugins} className={[
    "[&_details]:my-3 [&_details]:min-w-0 [&_details]:rounded-md [&_details]:border [&_details]:px-3 [&_details]:py-2",
    "[&_summary]:list-item [&_summary]:cursor-pointer [&_summary]:font-medium",
    "[&_summary]:rounded-sm [&_summary:focus-visible]:outline-2 [&_summary:focus-visible]:outline-offset-2 [&_summary:focus-visible]:outline-ring",
  ].join(" ")} />;
}
