import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { diffDefinitions, validateDefinition, type AppletDefinition, type ChangeFinding } from '@junction26/applet-format';
import { ApiError, waitForJob, type Job, type Message, type ModelOption, type Project, type Release, type RevisionSummary, type Upload } from './api.ts';
import { useApp } from './App.tsx';
import { GlassesPreview } from './GlassesPreview.tsx';

const STAGES: Record<string, string> = { preparing: 'Reading your files…', generating: 'Designing your applet…', repairing: 'Fixing a few details…' };

export function ProjectScreen() {
  const { projectId = '' } = useParams();
  const { api } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<'chat' | 'preview'>('chat');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [p, m, r, rel] = await Promise.all([api.project(projectId), api.messages(projectId), api.revisions(projectId), api.releases(projectId)]);
    setProject(p.project);
    setMessages(m.messages);
    setRevisions(r.revisions);
    setReleases(rel.releases);
    return r.revisions;
  }, [api, projectId]);

  useEffect(() => {
    refresh().then(
      (revs) => setSelected((s) => s ?? revs.find((x) => x.validationStatus === 'valid')?.id ?? null),
      (e: Error) => setError(e.message),
    );
  }, [refresh]);

  const loadDefinition = useCallback(
    async (id: string) => {
      if (definitions[id] !== undefined) return definitions[id];
      const { revision } = await api.revision(projectId, id);
      setDefinitions((d) => ({ ...d, [id]: revision.definition }));
      return revision.definition;
    },
    [api, projectId, definitions],
  );

  useEffect(() => {
    if (selected) void loadDefinition(selected);
    const live = project?.currentRelease?.revisionId ?? releases.find((r) => r.id === project?.currentReleaseId)?.revisionId;
    if (live) void loadDefinition(live);
  }, [selected, project, releases, loadDefinition]);

  const onGenerated = async (job: Job) => {
    const revs = await refresh();
    if (job.status === 'succeeded' && job.result?.revisionId) {
      setSelected(job.result.revisionId);
      setTab('preview');
    } else if (!selected) setSelected(revs[0]?.id ?? null);
  };

  if (error) return <main className="page"><p className="error">{error}</p><Link to="/">Back</Link></main>;
  return (
    <main className="page project">
      <header className="bar">
        <Link to="/" className="ghost" aria-label="Back to library">‹</Link>
        <h1 className="grow">{project?.title ?? '…'}</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
        </div>
      </header>
      <div className="split" data-tab={tab}>
        <Chat projectId={projectId} messages={messages} onSent={refresh} onDone={onGenerated} />
        <PreviewPanel
          projectId={projectId}
          project={project}
          revisions={revisions}
          releases={releases}
          selected={selected}
          onSelect={setSelected}
          definitions={definitions}
          onPublished={refresh}
        />
      </div>
    </main>
  );
}

function Chat({ projectId, messages, onSent, onDone }: { projectId: string; messages: Message[]; onSent: () => Promise<unknown>; onDone: (j: Job) => void }) {
  const { api } = useApp();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ file: File; upload?: Upload; error?: string }[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.models().then((r) => {
      setModels(r.models);
      setModel((m) => m || r.default);
    }, () => {});
  }, [api]);
  useEffect(() => {
    void end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, job?.status]);

  // Resume progress if a generation is still running (e.g. after reopening the screen).
  useEffect(() => {
    const pending = [...messages].reverse().find((m) => m.role === 'user' && m.jobId && !messages.some((a) => a.role === 'assistant' && a.jobId === m.jobId));
    if (!pending?.jobId || job) return;
    const ac = new AbortController();
    void waitForJob(api, pending.jobId, setJob, ac.signal).then((j) => {
      if (ac.signal.aborted) return;
      setJob(null);
      onDone(j);
    }, () => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const attach = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list)) {
      setFiles((f) => [...f, { file }]);
      try {
        const { upload } = await api.upload(file, projectId);
        setFiles((f) => f.map((x) => (x.file === file ? { ...x, upload } : x)));
      } catch (e) {
        setFiles((f) => f.map((x) => (x.file === file ? { ...x, error: (e as Error).message } : x)));
      }
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body || job || files.some((f) => !f.upload && !f.error)) return;
    setError(null);
    try {
      const ids = files.flatMap((f) => (f.upload ? [f.upload.id] : []));
      const r = await api.send(projectId, body, ids, model || undefined);
      setText('');
      setFiles([]);
      setJob(r.job);
      await onSent();
      const done = await waitForJob(api, r.job.id, setJob);
      setJob(null);
      onDone(done);
    } catch (e) {
      setJob(null);
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const running = job && (job.status === 'queued' || job.status === 'running');
  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <p>Describe the tool you need. You can attach a manual, recipe or pattern (PDF, photo or text).</p>
            <div className="suggestions">
              {['A row counter for crochet', 'Track my D&D character: health, spell slots and inventory', 'A packing checklist for a weekend hike'].map((s) => (
                <button key={s} className="chip" onClick={() => setText(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.body}
            {m.attachmentIds.length > 0 && <span className="tiny muted"> · {m.attachmentIds.length} file(s)</span>}
          </div>
        ))}
        {running && (
          <div className="bubble assistant pending">
            <span className="spinner" /> {STAGES[job.progress?.stage ?? ''] ?? 'Queued…'}
            <button className="link" onClick={() => void api.cancelJob(job.id)}>Stop</button>
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="composer card">
        {files.length > 0 && (
          <div className="files">
            {files.map((f, i) => (
              <span key={i} className={f.error ? 'chip bad' : 'chip'} title={f.error}>
                {f.file.name} {f.error ? '⚠' : f.upload ? '✓' : '…'}
                <button className="link" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label="Remove">×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          rows={2}
          value={text}
          placeholder={messages.length ? 'Ask for a change…' : 'What do you need?'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <div className="row">
          <button className="ghost" onClick={() => fileInput.current?.click()} aria-label="Attach files">📎</button>
          <input ref={fileInput} type="file" hidden multiple accept="application/pdf,image/gif,.gif,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,text/html,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.md,.txt,.csv,.json,.html,.docx" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
          {models.length > 1 && (
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
          <span className="grow" />
          <button className="primary" disabled={!text.trim() || !!running} onClick={() => void send()}>Send</button>
        </div>
      </div>
    </section>
  );
}

function PreviewPanel(props: {
  projectId: string;
  project: Project | null;
  revisions: RevisionSummary[];
  releases: Release[];
  selected: string | null;
  onSelect: (id: string) => void;
  definitions: Record<string, unknown>;
  onPublished: () => Promise<unknown>;
}) {
  const { api } = useApp();
  const { project, revisions, releases, selected, definitions } = props;
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const liveRelease = releases.find((r) => r.id === project?.currentReleaseId) ?? null;
  const liveRevisionId = liveRelease?.revisionId ?? null;
  const raw = selected ? definitions[selected] : undefined;
  const parsed = useMemo(() => (raw === undefined ? null : validateDefinition(raw)), [raw]);
  const def: AppletDefinition | null = parsed?.ok ? parsed.definition : null;

  // Program-detected changes vs. what's on the glasses now.
  const findings: ChangeFinding[] = useMemo(() => {
    if (!def || !liveRevisionId || liveRevisionId === selected) return [];
    const base = validateDefinition(definitions[liveRevisionId]);
    return base.ok ? diffDefinitions(base.definition, def) : [];
  }, [def, liveRevisionId, selected, definitions]);
  const losses = findings.filter((f) => f.severity === 'data_loss');
  useEffect(() => setAccepted(false), [selected]);

  const publish = async () => {
    if (!selected) return;
    setError(null);
    setPublishing('Publishing…');
    try {
      const r = await api.publish(props.projectId, selected, project?.currentReleaseId ?? null);
      const job = await waitForJob(api, r.job.id, () => {});
      if (job.status === 'succeeded' && job.result?.status === 'ready') setPublishing('Sent! On your glasses choose Sync.');
      else if (job.result?.status === 'superseded') setPublishing('Someone published first. Reload and try again.');
      else {
        setPublishing(null);
        setError(job.error?.message ?? 'Publishing failed.');
      }
      await props.onPublished();
    } catch (e) {
      setPublishing(null);
      setError((e as Error).message);
    }
  };

  if (!revisions.length) {
    return (
      <section className="preview">
        <p className="muted">Your applet shows up here once the assistant has made it.</p>
      </section>
    );
  }
  const isLive = selected !== null && selected === liveRevisionId;
  return (
    <section className="preview">
      <div className="row">
        <select value={selected ?? ''} onChange={(e) => props.onSelect(e.target.value)} aria-label="Version">
          {revisions.map((r) => (
            <option key={r.id} value={r.id} disabled={r.validationStatus !== 'valid'}>
              Version {r.number}{r.id === liveRevisionId ? ' (on glasses)' : ''}{r.validationStatus !== 'valid' ? ' (invalid)' : ''}
            </option>
          ))}
        </select>
      </div>
      {parsed && !parsed.ok && (
        <div className="card warn">
          <b>This version can’t run on the glasses.</b>
          <ul>{parsed.issues.slice(0, 5).map((i, n) => <li key={n}><code>{i.path}</code> {i.message}</li>)}</ul>
        </div>
      )}
      {def && <GlassesPreview definition={def} resetKey={selected ?? ''} />}
      {findings.length > 0 && (
        <div className={losses.length ? 'card warn' : 'card'}>
          <b>{losses.length ? 'This change would lose information' : 'Changes'}</b>
          <ul>{findings.map((f) => <li key={f.kind + f.ref}>{f.message}</li>)}</ul>
          {losses.length > 0 && (
            <>
              <label className="check">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> That’s what I want
              </label>
              <p className="tiny muted">Not what you meant? Say in the chat what to keep and why.</p>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={!def || isLive || (losses.length > 0 && !accepted) || publishing === 'Publishing…'} onClick={() => void publish()}>
        {isLive ? 'On your glasses' : 'Send to glasses'}
      </button>
      {publishing && <p className="muted center">{publishing}</p>}
    </section>
  );
}
