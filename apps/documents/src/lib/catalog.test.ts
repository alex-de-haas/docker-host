import { describe,it,expect } from 'vitest';
import { parseSourceDocument } from './parser';
import { enrichDocuments, attentionReasons } from './catalog';
const feature='---\ncreated: 2026-10-25\nupdated: 2026-10-26\nsummary: Current behavior.\n---\n# Feature\n## Behavior\nWorks.\n## Testing Expectations\nTests.';
describe('current documentation graph',()=>{
 it('resolves anchors and backlinks only within the supplied version',()=>{
  const a=parseSourceDocument('docs/features/a/feature.md',feature+'\n[other](../b/feature.md#behavior)');
  const b=parseSourceDocument('docs/features/b/feature.md',feature);
  const target=enrichDocuments([a,b]);expect(target[0].errors).toEqual([]);expect(target[1].backlinks).toEqual([{path:a.path,title:'Feature',anchor:'behavior'}]);
  const changed=parseSourceDocument(b.path,feature.replace('## Behavior','## Changed'));
  expect(enrichDocuments([a,changed])[0].errors.join(' ')).toContain('missing anchor');
  expect(enrichDocuments([a])[0].errors).toEqual([]);
 });
 it('reads ideas as optional documentation and excludes them from plan progress',()=>{
  const doc=parseSourceDocument('docs/ideas.md','---\ncreated: 2026-10-25\nupdated: 2026-10-26\n---\n# Ideas\n<!-- idea-id-high-water: 4 -->\n## I4. Possible work\nText.');
  expect(doc.kind).toBe('ideas');expect(doc.progress).toBeNull();expect(doc.ideas?.[0].ideaId).toBe('I4');expect(doc.errors).toEqual([]);
 });
 it('surfaces authored questions and invalid structure without claiming live agent activity',()=>{
  const doc=parseSourceDocument('docs/features/a/plan.md','---\nstatus: Draft\ncreated: 2026-10-25\nupdated: 2026-10-26\nsummary: Proposed work.\n---\n# Plan\n## Open Questions\nWhich scope?\n## Deliverables\n- [ ] D1. Build');
  expect(attentionReasons(doc)).toEqual(['Questions to discuss']);expect(doc.progress).toEqual({done:0,total:1});
 });
 it('reports stale generated overview while refusing to infer staleness from a partial index',()=>{
  const root=parseSourceDocument('docs/root.md','# Docs\n<!-- docs-index:begin -->\nold\n<!-- docs-index:end -->');
  expect(enrichDocuments([root])[0].errors).toContain('Generated index is stale or missing. Run node scripts/docs-index.mjs --fix.');
  expect(enrichDocuments([root],false)[0].errors).toEqual([]);
 });
});
