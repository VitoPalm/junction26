import { Page, VerticalList, ListItem } from '@wearables-ui-toolkit/mrbd';
import { assertContent, checkCopy, checkIds, COPY_LIMITS } from './constraints.js';
import { ContentScreen, TextBlock } from './content.js';

export interface Choice {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

function validateChoices(title: string, items: readonly Choice[]) {
  assertContent([
    ...checkCopy('title', title, COPY_LIMITS.title), ...checkIds(items),
    ...(items.length > COPY_LIMITS.items ? [{ path: 'items', message: 'Split collections larger than 20 items into separate screens.' }] : []),
    ...items.flatMap(i => [
      ...checkCopy(`items.${i.id}.label`, i.label, COPY_LIMITS.label),
      ...(i.hint === undefined ? [] : checkCopy(`items.${i.id}.hint`, i.hint, COPY_LIMITS.hint)),
    ]),
  ]);
}

/** A full list route, never nested in ContentScreen. Selection is controlled. */
export function ChoiceScreen({ title, items, onChoose, selectedId, emptyText = 'Nothing here yet.' }: {
  title: string; items: readonly Choice[]; onChoose: (id: string) => void;
  selectedId?: string; emptyText?: string;
}) {
  validateChoices(title, items);
  if (!items.length) return <ContentScreen title={title}><TextBlock text={emptyText} /></ContentScreen>;
  return <Page headerText={title} enableSystemBarInset={false}>
    <VerticalList insetForHeader ariaLabel={title}>
      {items.map(i => <ListItem key={i.id} title={i.label} subtitle={i.hint} disabled={i.disabled}
        showRadioButton={selectedId !== undefined} checked={i.id === selectedId} onClick={() => onChoose(i.id)} />)}
    </VerticalList>
  </Page>;
}

export interface ChecklistItem extends Choice { checked: boolean }

/** One row = one action; the toolkit owns its integrated switch semantics. */
export function ChecklistScreen({ title, items, onToggle, emptyText = 'All clear.' }: {
  title: string; items: readonly ChecklistItem[]; onToggle: (id: string, checked: boolean) => void; emptyText?: string;
}) {
  validateChoices(title, items);
  if (!items.length) return <ContentScreen title={title}><TextBlock text={emptyText} /></ContentScreen>;
  return <Page headerText={title} enableSystemBarInset={false}>
    <VerticalList insetForHeader ariaLabel={title}>
      {items.map(i => <ListItem key={i.id} title={i.label} subtitle={i.hint} disabled={i.disabled}
        showSwitch checked={i.checked} onClick={() => onToggle(i.id, !i.checked)} />)}
    </VerticalList>
  </Page>;
}

