import { useState } from 'react';
import { Button } from '@wearables-ui-toolkit/mrbd';
import { assertContent, checkCopy, checkIds, COPY_LIMITS, pageItems } from './constraints.js';
import { ContentScreen, TextBlock } from './content.js';

export interface Choice { id: string; label: string; hint?: string; disabled?: boolean }
export interface ChecklistItem extends Choice { checked: boolean }
function CollectionScreen({ title, items, activate, selected, emptyText }: {
  title: string; items: readonly Choice[]; activate: (id: string) => void;
  selected: (id: string) => boolean | undefined; emptyText: string;
}) {
  assertContent([
    ...checkCopy('title', title, COPY_LIMITS.title), ...checkIds(items),
    ...items.flatMap(i => [
      ...checkCopy(`items.${i.id}.label`, i.label, COPY_LIMITS.label),
      ...(i.hint === undefined ? [] : checkCopy(`items.${i.id}.hint`, i.hint, COPY_LIMITS.hint)),
    ]),
  ]);
  const [requestedPage, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(items.length / 3));
  const page = Math.min(requestedPage, count - 1);
  const visible = pageItems(items, page);
  return <ContentScreen title={title} actions={count > 1 ? [
    { id: 'collection.previous', label: 'Previous page', disabled: page === 0, onActivate: () => setPage(page - 1) },
    { id: 'collection.next', label: 'Next page', disabled: page === count - 1, onActivate: () => setPage(page + 1) },
  ] : []}>
    {!visible.length ? <TextBlock text={emptyText} /> : <div data-g-fit-content className="g-choices" aria-label={`${title}, page ${page + 1} of ${count}`}>
      {visible.map(i => <Button key={i.id} title={i.label} subtitle={selected(i.id) === true ? 'Selected' : i.hint}
        aria-pressed={selected(i.id)} alwaysShowText disabled={i.disabled} onClick={() => activate(i.id)} />)}
    </div>}
  </ContentScreen>;
}

/** Up to three choices per discrete page; no scrolling list. */
export function ChoiceScreen({ title, items, onChoose, selectedId, emptyText = 'Nothing here yet.' }: {
  title: string; items: readonly Choice[]; onChoose: (id: string) => void; selectedId?: string; emptyText?: string;
}) {
  return <CollectionScreen title={title} items={items} activate={onChoose}
    selected={id => selectedId === undefined ? undefined : id === selectedId} emptyText={emptyText} />;
}

/** Controlled checklist, paged rather than scrolled. Each item is one toggle. */
export function ChecklistScreen({ title, items, onToggle, emptyText = 'All clear.' }: {
  title: string; items: readonly ChecklistItem[]; onToggle: (id: string, checked: boolean) => void; emptyText?: string;
}) {
  return <CollectionScreen title={title} items={items} emptyText={emptyText}
    selected={id => items.find(i => i.id === id)?.checked}
    activate={id => { const item = items.find(i => i.id === id); if (item) onToggle(id, !item.checked); }} />;
}
