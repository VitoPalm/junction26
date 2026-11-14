import { Component, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@wearables-ui-toolkit/mrbd';
import { ChecklistScreen, ChoiceScreen, ContentScreen, Diagram, GifScreen, TextBlock, ValueReadout, VoiceNoteBar, type GlassesAction } from '@junction26/glasses-ui';
import { anchorKey, noteAnchor, type NotesBinding } from './notes.ts';
import type { AppletDefinition, Asset, ListItem, View } from '@junction26/applet-format';
import { formatScalar, formatValue } from '@junction26/applet-runtime';
import type { AppletSession } from './session.ts';

/** What the host should show: the applet's view menu, or one view. */
export type Screen = { kind: 'menu' } | { kind: 'view'; viewId: string };

export function viewLabel(def: AppletDefinition, v: View): string {
  if (v.title) return v.title;
  if (v.kind === 'value' || v.kind === 'list') return def.state.find((f) => f.id === v.field)?.label ?? v.id;
  return def.title;
}

export function hasMenu(def: AppletDefinition): boolean {
  return def.views.length > 1;
}

/**
 * Renders one screen of an applet with the glasses-ui components. Router
 * agnostic: the host maps `onOpen` to its navigation (routes on the glasses,
 * local state in the authoring preview).
 */
export function AppletScreen({ session, screen, onOpen, notes }: { session: AppletSession; screen: Screen; onOpen: (s: Screen) => void; notes?: NotesBinding }) {
  const def = session.definition;
  if (screen.kind === 'menu') {
    return (
      <Guard key="menu">
        <ChoiceScreen
          title={def.title}
          items={def.views.map((v) => ({ id: v.id, label: viewLabel(def, v) }))}
          onChoose={(id) => onOpen({ kind: 'view', viewId: id })}
        />
      </Guard>
    );
  }
  const view = def.views.find((v) => v.id === screen.viewId) ?? def.views[0]!;
  return (
    <Guard key={view.id}>
      <ViewScreen session={session} view={view} footer={view.voiceNote ? <NoteFooter session={session} view={view} notes={notes} /> : undefined} />
    </Guard>
  );
}

function docked(session: AppletSession, view: View): GlassesAction[] {
  return (view.actions ?? []).flatMap((id) => {
    const a = session.definition.actions.find((x) => x.id === id);
    return a ? [{ id: `action.${a.id}`, label: a.label, onActivate: () => void session.run(a.id) }] : [];
  });
}

/** The voice note component for the page as it is now (current step on a guide). */
function NoteFooter({ session, view, notes }: { session: AppletSession; view: View; notes?: NotesBinding }) {
  const anchor = noteAnchor(session.definition, session.state, view.id);
  const active = anchor && notes?.active?.key === anchorKey(anchor) ? notes.active : null;
  const [now, setNow] = useState(() => Date.now());
  const ticking = active?.status === 'recording' && active.startedAt !== null;
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!anchor) return null;
  return (
    <VoiceNoteBar
      status={active?.status ?? 'idle'}
      elapsedMs={active?.startedAt ? now - active.startedAt : 0}
      count={notes?.counts[anchorKey(anchor)] ?? 0}
      message={active?.message}
      onActivate={notes ? () => notes.toggle(anchor) : undefined}
    />
  );
}

function ViewScreen({ session, view, footer }: { session: AppletSession; view: View; footer?: ReactNode }) {
  const { definition: def, state } = session;
  const hint = session.notice ?? undefined;
  switch (view.kind) {
    case 'text':
      return (
        <ContentScreen title={view.title} actions={docked(session, view)} footer={footer}>
          <TextBlock label={view.label} text={view.text} hint={hint ? clip(hint) : view.hint} />
        </ContentScreen>
      );
    case 'value': {
      const field = def.state.find((f) => f.id === view.field);
      return (
        <ContentScreen title={view.title} actions={docked(session, view)} footer={footer}>
          <ValueReadout label={view.label ?? field?.label ?? view.field} value={formatValue(view, state)} hint={hint ? clip(hint) : view.hint} />
        </ContentScreen>
      );
    }
    case 'list': {
      const items = (state.values[view.field] as ListItem[] | undefined) ?? [];
      const select = (id: string) => {
        const item = items.find((i) => i.id === id);
        if (item && view.onSelect) void session.run(view.onSelect.action, { [view.onSelect.arg]: item[view.display] });
      };
      const detail = (it: ListItem) => {
        if (!view.detail) return undefined;
        const v = it[view.detail];
        return typeof v === 'number' ? `×${formatScalar(v)}` : v === undefined || v === '' ? undefined : formatScalar(v);
      };
      const title = view.title ?? viewLabel(def, view);
      if (view.check) {
        const check = view.check;
        return (
          <ChecklistScreen
            title={title}
            emptyText={view.emptyText}
            items={items.map((it) => ({ id: it.id, label: String(it[view.display] ?? ''), checked: it[check] === true }))}
            onToggle={(id) => select(id)}
            footer={footer}
          />
        );
      }
      return (
        <ChoiceScreen
          title={title}
          emptyText={view.emptyText}
          items={items.map((it) => ({ id: it.id, label: String(it[view.display] ?? ''), hint: detail(it), disabled: !view.onSelect }))}
          onChoose={select}
          footer={footer}
        />
      );
    }
    case 'sequence': {
      const index = Math.min((state.values[view.cursor] as number | undefined) ?? 0, view.steps.length - 1);
      const s = view.steps[index]!;
      const total = view.steps.length;
      const actions: GlassesAction[] = [
        { id: 'sequence.previous', label: 'Previous', disabled: index === 0, onActivate: () => void session.step(view.id, -1) },
        { id: 'sequence.next', label: 'Next', disabled: index === total - 1, onActivate: () => void session.step(view.id, 1) },
      ];
      const asset = s.image ? def.assets.find((a) => a.id === s.image) : undefined;
      if (asset?.data && asset.mediaType === 'image/gif')
        return <GifScreen key={s.id} title={s.title ?? view.title} src={assetUrl(asset.mediaType, asset.data)}
          alt={s.alt ?? `Step ${index + 1}`} instruction={s.text} hint={s.hint} actions={actions} footer={footer} />;
      return (
        <ContentScreen key={s.id} title={s.title ?? view.title} actions={actions} footer={footer}>
          {asset?.data ? (
            <AssetImage asset={asset} alt={s.alt ?? `Step ${index + 1}`} />
          ) : (
            <TextBlock label={`Step ${index + 1} of ${total}`} text={s.text ?? 'This step has no content.'} hint={s.hint} />
          )}
        </ContentScreen>
      );
    }
    case 'image': {
      const asset = def.assets.find((a) => a.id === view.asset);
      if (asset?.data && asset.mediaType === 'image/gif')
        return <GifScreen title={view.title} src={assetUrl(asset.mediaType, asset.data)} alt={view.alt} actions={docked(session, view)} footer={footer} />;
      return (
        <ContentScreen title={view.title} actions={docked(session, view)} footer={footer}>
          {asset?.data ? <AssetImage asset={asset} alt={view.alt} /> : <TextBlock text="This picture isn't downloaded yet." />}
        </ContentScreen>
      );
    }
  }
}

function AssetImage({ asset, alt }: { asset: Asset; alt: string }) {
  const src = assetUrl(asset.mediaType, asset.data!);
  return <Diagram src={src} alt={alt} />;
}

const assetUrl = (type: string, data: string) => (data.startsWith('data:') ? data : `data:${type};base64,${data}`);
const clip = (s: string) => (Array.from(s).length > 48 ? Array.from(s).slice(0, 47).join('') + '…' : s);

/**
 * A view that throws (e.g. a value grew past its copy budget) must not take
 * the whole app down: show a fixed page that says so instead.
 */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ContentScreen title="Can't show this page">
        <TextBlock text="Something on this page doesn't fit the display. Ask for a fix in the phone app." />
      </ContentScreen>
    );
  }
}

/** Plain list of buttons in the glasses style, for host screens (home, pairing). */
export function ButtonList({ items }: { items: { id: string; label: string; hint?: string; onActivate: () => void }[] }) {
  return (
    <div data-g-fit-content className="g-choices">
      {items.map((i) => (
        <Button key={i.id} title={i.label} subtitle={i.hint} alwaysShowText onClick={i.onActivate} />
      ))}
    </div>
  );
}
