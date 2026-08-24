// Which of an app's tools it declares read-only.
//
// Only asked for apps the operator has opted into (settings.mcpAutoAllow), because the answer is only
// ever used to skip an approval card for those. An app nobody trusted costs nothing here.
//
// The protocol lifecycle lives in upstream.ts, shared with the facade's catalog. What stays here is
// the part that is *not* shared: this function produces a permission answer, so any doubt refuses
// the whole thing. The facade, building a catalog, keeps what it managed to read — the opposite
// policy, and correct for what it produces.

import { listTools, openSession } from "./upstream.js";

/**
 * Cap on `tools/list` pages followed. Generous for any real app, and finite because the cursor comes
 * from the app: a buggy one that always returns a cursor must not spin here forever.
 */
const MAX_PAGES = 20;

/**
 * The tool names this app declares `readOnlyHint: true`, or **null** when that could not be
 * established — unreachable, refused, or an answer of the wrong shape.
 *
 * Null and an empty set are deliberately different, and the caller must treat them differently: an
 * empty set means "this app offers nothing read-only", while null means "we do not know", and only
 * one of those may ever lead to skipping an approval.
 */
export async function readOnlyToolNames(url: string, token: string): Promise<Set<string> | null> {
  const session = await openSession(url, token);
  if (!session) {
    return null;
  }

  const names = new Set<string>();
  let cursor: string | undefined;

  // Paginated, because `tools/list` is. Reading only the first page would silently leave later
  // read-only tools asking for approval on an app the operator had explicitly vouched for — the
  // failure is conservative, but it is still the setting not doing what it says.
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await listTools(url, token, session, cursor);
    if (!listed) {
      // A page that cannot be read makes the whole answer unusable rather than partial: a truncated
      // grant is indistinguishable from a complete one at the point it is consulted.
      return null;
    }

    for (const tool of listed.tools) {
      if (
        // Fail-closed on the individual tool too: only a literal `true` counts. `false`, absent, a
        // string, or the hint at the wrong nesting all mean "we do not know what this does".
        tool.annotations?.readOnlyHint === true
      ) {
        names.add(tool.name);
      }
    }

    if (!listed.nextCursor) {
      return names;
    }
    cursor = listed.nextCursor;
  }

  // Ran out of pages. Refusing beats returning a partial set for the reason above.
  return null;
}
