import { chooseModel, modelSummary } from './model-selection.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { diffDefinitions, validateDefinition, type AppletDefinition, type ChangeFinding } from '@junction26/applet-format';
import { ApiError, waitForJob, type Job, type Message, type ModelOption, type Project, type Release, type RevisionSummary, type Upload } from './api.ts';
import { useApp, useAutosize } from './App.tsx';
import { GlassesPreview } from './GlassesPreview.tsx';
import { BrandMark, IconArrowRight, IconArrowUp, IconBack, IconCheck, IconClip, IconClose, IconFile, IconGlasses, IconWarn } from './icons.tsx';
import { FILE_ACCEPT, SUGGESTIONS, takeStartRequest } from './ui.ts';

const STAGES = [
  { id: 'preparing', label: 'Reading your files…' },
  { id: 'generating', label: 'Designing your solution…' },
  { id: 'repairing', label: 'Polishing the details…' },
];
const PROVIDER_LABELS: Record<string, string> = { openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', gemini: 'Google Gemini', fake: 'Demo' };

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

  if (error)
    return (
      <main className="page narrow">
        <div className="empty-note">
          <p className="error">{error}</p>
          <Link className="secondary" to="/">Back to your solutions</Link>
        </div>
      </main>
    );
  const hasPreview = revisions.some((r) => r.validationStatus === 'valid');
  return (
    <main className="page project">
      <header className="topbar sticky">
        <Link to="/" className="icon-btn" aria-label="Back to library"><IconBack size={22} /></Link>
        <EditableTitle project={project} onRenamed={setProject} />
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
            Preview{hasPreview && tab !== 'preview' && <span className="tab-dot" />}
          </button>
        </div>
      </header>
      <div className="split" data-tab={tab}>
        <Chat projectId={projectId} messages={messages} onSent={refresh} onDone={onGenerated} hasPreview={hasPreview} onShowPreview={() => setTab('preview')} />
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

/** Tap the title to rename the solution. */
function EditableTitle({ project, onRenamed }: { project: Project | null; onRenamed: (p: Project) => void }) {
  const { api } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = async () => {
    setEditing(false);
    const title = value.trim().slice(0, 80);
    if (!project || !title || title === project.title) return;
    onRenamed({ ...project, title });
    try {
      onRenamed((await api.renameProject(project.id, title)).project);
    } catch {
      onRenamed(project);
    }
  };
  if (editing)
    return (
      <input
        className="title-input grow"
        value={value}
        maxLength={80}
        autoFocus
        aria-label="Solution name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  return (
    <button className="title-btn grow" disabled={!project} onClick={() => { setValue(project?.title ?? ''); setEditing(true); }} title="Rename">
      <h1>{project?.title ?? '…'}</h1>
    </button>
  );
}

function Chat({ projectId, messages, onSent, onDone, hasPreview, onShowPreview }: { projectId: string; messages: Message[]; onSent: () => Promise<unknown>; onDone: (j: Job) => void; hasPreview: boolean; onShowPreview: () => void }) {
  const { api } = useApp();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ file: File; upload?: Upload; error?: string }[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelReload, setModelReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useAutosize(text);
  /** Set when the library composer handed over a request to send on arrival. */
  const autoSend = useRef(false);

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    setModelsError(null);
    api.models().then((r) => {
      if (!active) return;
      setModels(r.models);
      setModel((m) => chooseModel(r.models, m || r.default));
    }, () => { if (active) setModelsError('Couldn’t load models. Try again.'); })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [api, modelReload]);
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

  const attach = async (list: FileList | File[] | null) => {
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

  // Pick up a request started from the library composer.
  useEffect(() => {
    const r = takeStartRequest(projectId);
    if (!r) return;
    setText(r.text);
    autoSend.current = true;
    if (r.files.length) void attach(r.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const send = async () => {
    const body = text.trim();
    if (!models.find((m) => m.id === model)?.available || modelsLoading || modelsError) return;
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

  // Send the handed-over request once its uploads and the model list are ready.
  // A failed upload or unavailable model leaves it in the composer for the user.
  useEffect(() => {
    if (!autoSend.current || modelsLoading || job) return;
    if (files.some((f) => !f.upload && !f.error)) return;
    if (files.some((f) => f.error) || modelsError || !models.find((m) => m.id === model)?.available) {
      autoSend.current = false;
      return;
    }
    if (!text.trim()) return;
    autoSend.current = false;
    void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoading, modelsError, files, text, model, models, job]);

  const selectedModel = models.find((m) => m.id === model);
  const providerGroups = [...new Set(models.map((m) => m.provider))];
  const running = job && (job.status === 'queued' || job.status === 'running');
  const stage = job?.progress?.stage;
  const stageIndex = STAGES.findIndex((s) => s.id === stage);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const canSend = !!text.trim() && !running && !modelsLoading && !modelsError && !!selectedModel?.available;

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && !running && (
          <div className="chat-empty">
            <BrandMark size={52} />
            <h2 className="display sm">What should we make?</h2>
            <p className="muted">Describe the tool you need. You can attach a manual, recipe or pattern as a PDF, photo or text.</p>
            <div className="ideas center">
              {SUGGESTIONS.slice(0, 3).map((s) => (
                <button key={s.label} className="idea" onClick={() => { setText(s.text); area.current?.focus(); }}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role !== 'user' && <span className="msg-avatar"><BrandMark size={28} /></span>}
            <div className="msg-body">
              <div className="bubble">
                {m.body}
                {m.attachmentIds.length > 0 && (
                  <span className="bubble-files"><IconFile size={14} /> {m.attachmentIds.length} file{m.attachmentIds.length > 1 ? 's' : ''}</span>
                )}
              </div>
              {m.id === lastAssistant && hasPreview && !running && (
                <button className="see-preview" onClick={onShowPreview}>
                  See it on the glasses <IconArrowRight size={16} />
                </button>
              )}
            </div>
          </div>
        ))}
        {running && (
          <div className="msg assistant">
            <span className="msg-avatar thinking"><BrandMark size={28} /></span>
            <div className="msg-body">
              <div className="bubble working">
                <span className="shimmer">{STAGES[stageIndex]?.label ?? 'Getting started…'}</span>
                <span className="progress-steps" aria-hidden>
                  {STAGES.map((s, i) => <span key={s.id} className={i < stageIndex ? 'done' : i === stageIndex ? 'now' : ''} />)}
                </span>
                <button className="text-btn" onClick={() => void api.cancelJob(job.id)}>Stop</button>
              </div>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="composer-dock">
        <div className="composer">
          {files.length > 0 && (
            <div className="files">
              {files.map((f, i) => (
                <span key={i} className={f.error ? 'file-chip bad' : 'file-chip'} title={f.error}>
                  {f.error ? <IconWarn size={14} /> : f.upload ? <IconCheck size={14} /> : <span className="spinner xs" />}
                  <span className="file-name">{f.file.name}</span>
                  <button className="chip-x" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.file.name}`}><IconClose size={14} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={messages.length ? 'Ask for a change…' : 'What do you need?'}
            aria-label="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              const desktop = window.matchMedia('(hover: hover)').matches;
              if (e.metaKey || e.ctrlKey || (desktop && !e.shiftKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-row">
            <button className="icon-btn soft" onClick={() => fileInput.current?.click()} aria-label="Attach files"><IconClip size={20} /></button>
            <input ref={fileInput} type="file" hidden multiple accept={FILE_ACCEPT} onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
            {models.length > 0 && (
              <label className="model-chip" title={selectedModel ? modelSummary(selectedModel) : undefined}>
                <span className="sr-only">Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" aria-describedby="model-help" disabled={!!running || modelsLoading}>
                  {providerGroups.map((provider) => (
                    <optgroup key={provider} label={PROVIDER_LABELS[provider] ?? provider}>
                      {models.filter((m) => m.provider === provider).map((m) => (
                        <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{m.default ? ' · Default' : ''}{!m.available ? ' · Unavailable' : ''}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
            <span className="grow" />
            <button className="send-btn" disabled={!canSend} onClick={() => void send()} aria-label="Send">
              <IconArrowUp size={20} />
            </button>
          </div>
        </div>
        <p id="model-help" className="composer-note" role="status">
          {modelsLoading ? 'Loading models…' : modelsError ? modelsError : selectedModel ? modelSummary(selectedModel) : 'No models are available on this server.'}
          {modelsError && <button className="text-btn" onClick={() => setModelReload((n) => n + 1)}>Retry</button>}
        </p>
        {files.length > 0 && selectedModel?.capabilities?.images === false && <p className="composer-note">This model cannot see images. Extracted document text can still be used.</p>}
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
  useEffect(() => setPublishing(null), [selected]);

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
        <div className="lens-placeholder">
          <div className="lens-empty">
            <IconGlasses size={34} />
            <p>Your solution appears here, exactly as it looks on your glasses.</p>
          </div>
        </div>
      </section>
    );
  }
  const isLive = selected !== null && selected === liveRevisionId;
  const selectedNumber = revisions.find((r) => r.id === selected)?.number;
  const sending = publishing === 'Publishing…';
  return (
    <section className="preview">
      <div className="preview-head">
        <div>
          <p className="eyebrow">Glasses view</p>
          <p className="preview-sub">{isLive ? 'On your glasses' : liveRevisionId ? 'Not sent yet' : 'Try it here first'}</p>
        </div>
        <label className="version-chip">
          {isLive && <span className="live-dot" />}
          <select value={selected ?? ''} onChange={(e) => props.onSelect(e.target.value)} aria-label="Version">
            {revisions.map((r) => (
              <option key={r.id} value={r.id} disabled={r.validationStatus !== 'valid'}>
                Version {r.number}{r.id === liveRevisionId ? ' · on glasses' : ''}{r.validationStatus !== 'valid' ? ' · invalid' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {parsed && !parsed.ok && (
        <div className="notice warn">
          <IconWarn size={20} />
          <div>
            <b>This version can’t run on the glasses.</b>
            <ul>{parsed.issues.slice(0, 5).map((i, n) => <li key={n}><code>{i.path}</code> {i.message}</li>)}</ul>
          </div>
        </div>
      )}
      {def && <GlassesPreview definition={def} resetKey={selected ?? ''} />}
      {findings.length > 0 && (
        <div className={losses.length ? 'notice warn' : 'notice'}>
          {losses.length ? <IconWarn size={20} /> : <IconCheck size={20} />}
          <div>
            <b>{losses.length ? 'This change would lose information' : `What changes from the version on your glasses`}</b>
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
        </div>
      )}
      <div className="publish-bar">
        {error && <p className="error">{error}</p>}
        <button className={isLive ? 'primary lg wide is-live' : 'primary lg wide'} disabled={!def || isLive || (losses.length > 0 && !accepted) || sending} onClick={() => void publish()}>
          {sending ? <><span className="spinner" /> Sending…</> : isLive ? <><IconCheck size={20} /> On your glasses</> : <><IconGlasses size={22} /> Send {selectedNumber ? `version ${selectedNumber} ` : ''}to glasses</>}
        </button>
        {publishing && !sending && <p className="publish-note">{publishing}</p>}
      </div>
    </section>
  );
}
