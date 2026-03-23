import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/** Convert a markdown string to HTML. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
