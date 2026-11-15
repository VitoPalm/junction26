import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  buildPlan, CARE_KEYS, confirmAll, correctField, FIELD_NAMES, fieldText, garmentName, parseLaundry, unconfirmedFields,
  type CareKey, type CareLabel, type ColorClass, type FieldStatus, type Garment, type LaundryData,
} from '@junction26/laundry';
import { useApp } from './App.tsx';
import { waitForJob, type Project } from './api.ts';

/**
 * Laundry on the phone (docs/laundry.md): add garments with a label photo,
 * review every instruction the reader found (confirm or correct it), answer
 * missing details, preview the rule-based plan, and send it to the glasses.
 * Nothing unconfirmed is used: unconfirmed garments go to "check first" and
 * sending is blocked until every label is confirmed. The draft is saved as a
 * revision after each change, so it survives closing the app.
 */

type Thumbs = Record<string, { mediaType: string; data: string }>;
interface Pending { key: string; name: string; status: 'uploading' | 'reading' | 'failed'; message?: string; retry?: () => void }

const slug = (name: string, taken: Set<string>) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'g_$1').slice(0, 32) || 'garment';
  let id = /^[a-z]/.test(base) ? base : `g_${base}`;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 30)}_${i}`;
  return id;
};

const STATUS_TEXT: Record<FieldStatus, string> = { present: 'Read from label', not_present: 'Not on label', unreadable: 'Unreadable' };
const TEMPS = [20, 30, 40, 50, 60, 70, 95];

function definitionFor(title: string, data: LaundryData, thumbs: Thumbs) {
  const assets = data.garments.filter((g) => g.thumbnail && thumbs[g.id]).map((g) => ({ id: g.thumbnail!, mediaType: thumbs[g.id]!.mediaType as 'image/webp', data: thumbs[g.id]!.data }));
  return {
    formatVersion: 1, title: title.slice(0, 32) || 'Laundry', toolPrefix: 'laundry', summary: 'Sorting plan and washing steps from confirmed care labels.',
    state: [], actions: [], views: [{ id: 'plan', kind: 'text', text: 'Open this on your glasses to follow the laundry plan.' }], assets,
    task: { kind: 'laundry', version: 1, data },
  };
}

function FieldEditor({ g, k, onSave, onCancel }: { g: Garment; k: CareKey; onSave: (status: FieldStatus, value: CareLabel[CareKey]['value']) => void; onCancel: () => void }) {
  const f = g.label[k];
  const [status, setStatus] = useState<FieldStatus>(f.status);
  const [v, setV] = useState<any>(f.value ?? (k === 'wash' ? { method: 'machine', maxTempC: 30, cycle: 'normal' } : k === 'dry' ? { method: 'line', heat: null } : k === 'bleach' ? 'do_not_bleach' : k === 'iron' ? 'low' : 'do_not_dry_clean'));
  const sel = (value: string, options: [string, string][], onChange: (x: string) => void, label: string) => (
    <label className="field">{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([o, t]) => <option key={o} value={o}>{t}</option>)}</select></label>
  );
  return (
    <div className="stack laundry-edit">
      {sel(status, [['present', 'On the label'], ['not_present', 'Not on the label'], ['unreadable', 'Unreadable']], (x) => setStatus(x as FieldStatus), 'What the label shows')}
      {status === 'present' && k === 'wash' && <>
        {sel(v.method, [['machine', 'Machine wash'], ['hand', 'Hand wash'], ['do_not_wash', 'Do not wash']], (x) => setV({ ...v, method: x, ...(x === 'do_not_wash' ? { maxTempC: null, cycle: null } : {}) }), 'Method')}
        {v.method !== 'do_not_wash' && sel(String(v.maxTempC ?? ''), [['', 'No temperature shown'], ...TEMPS.map((t) => [String(t), `Up to ${t}°C`] as [string, string])], (x) => setV({ ...v, maxTempC: x ? Number(x) : null }), 'Max temperature')}
        {v.method === 'machine' && sel(v.cycle ?? 'normal', [['normal', 'Normal'], ['permanent_press', 'Permanent press (1 bar)'], ['delicate', 'Gentle / delicate (2 bars)']], (x) => setV({ ...v, cycle: x }), 'Cycle')}
      </>}
      {status === 'present' && k === 'dry' && <>
        {sel(v.method, [['tumble', 'Tumble dry'], ['do_not_tumble', 'Do not tumble dry'], ['line', 'Line dry'], ['dry_flat', 'Dry flat'], ['drip_dry', 'Drip dry']], (x) => setV({ method: x, heat: x === 'tumble' ? 'low' : null }), 'Method')}
        {v.method === 'tumble' && sel(v.heat ?? '', [['', 'Heat not shown'], ['no_heat', 'No heat'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (x) => setV({ ...v, heat: x || null }), 'Heat')}
      </>}
      {status === 'present' && k === 'bleach' && sel(v, [['any', 'Any bleach'], ['non_chlorine_only', 'Non-chlorine only'], ['do_not_bleach', 'Do not bleach']], setV, 'Bleach')}
      {status === 'present' && k === 'iron' && sel(v, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['do_not_iron', 'Do not iron']], setV, 'Iron')}
      {status === 'present' && k === 'professional' && sel(v, [['dry_clean', 'Can be dry cleaned'], ['dry_clean_only', 'Dry clean only'], ['do_not_dry_clean', 'Do not dry clean'], ['wet_clean', 'Professional wet clean']], setV, 'Professional cleaning')}
      <div className="row"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onSave(status, status === 'present' ? v : null)}>Save correction</button></div>
    </div>
  );
}

function GarmentCard({ g, thumb, onChange, onRemove }: { g: Garment; thumb?: { mediaType: string; data: string }; onChange: (g: Garment) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<CareKey | null>(null);
  const open = unconfirmedFields(g);
  const confirmField = (k: CareKey) => onChange({ ...g, label: { ...g.label, [k]: { ...g.label[k], confirmed: true } } });
  const info = (patch: Partial<Garment['info']>) => onChange({ ...g, info: { ...g.info, ...patch } });
  const tri = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');
  const fromTri = (x: string) => (x === '' ? null : x === 'yes');
  return (
    <article className="laundry-card" data-garment={g.id}>
      <header className="row">
        {thumb && <img className="laundry-thumb" src={`data:${thumb.mediaType};base64,${thumb.data}`} alt={`${g.name} label`} />}
        <div className="grow"><h3>{g.name}</h3><span className={open.length ? 'chip warn' : 'chip ok'}>{open.length ? `${open.length} to confirm` : 'Label confirmed'}</span></div>
        <button className="text-btn" onClick={onRemove}>Remove</button>
      </header>
      {g.label.wash.status !== 'present' && <p className="error">The washing instruction isn’t clear. Retake a closer photo, or enter it below from the label.</p>}
      <ul className="laundry-fields">
        {CARE_KEYS.map((k) => {
          const f = g.label[k];
          return (
            <li key={k}>
              <div className="grow">
                <b>{FIELD_NAMES[k]}</b>: {fieldText(g.label, k)}
                <div className="muted tiny">{STATUS_TEXT[f.status]}{f.source ? ` · label shows “${f.source}”` : ''}{f.corrected ? ' · you corrected this' : ''}</div>
              </div>
              {f.confirmed ? <span className="chip ok">Confirmed</span> : <button className="secondary" onClick={() => confirmField(k)} aria-label={`Confirm ${FIELD_NAMES[k]}`}>Confirm</button>}
              <button className="text-btn" onClick={() => setEditing(k)} aria-label={`Correct ${FIELD_NAMES[k]}`}>Correct</button>
              {editing === k && <FieldEditor g={g} k={k} onCancel={() => setEditing(null)} onSave={(st, v) => { onChange(correctField(g, k, st, v as never)); setEditing(null); }} />}
            </li>
          );
        })}
      </ul>
      {open.length > 0 && <button className="primary" onClick={() => onChange(confirmAll(g))}>Confirm all as shown</button>}
      <p className="muted tiny">Fibres (from the label, separate from care): {g.info.fibers?.length ? g.info.fibers.map((f) => `${f.percent ?? '?'}% ${f.fiber}`).join(', ') : 'not read'}</p>
      <div className="laundry-info">
        <label className="field">Colour<select value={g.info.color} onChange={(e) => info({ color: e.target.value as ColorClass })}>{(['unknown', 'white', 'light', 'bright', 'dark'] as const).map((c) => <option key={c} value={c}>{c === 'unknown' ? 'Not set' : c}</option>)}</select></label>
        <label className="field">New (never washed)?<select value={tri(g.info.isNew)} onChange={(e) => info({ isNew: fromTri(e.target.value) })}><option value="">Not sure</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label className="field">Colourfast?<select value={tri(g.info.colorfast)} onChange={(e) => info({ colorfast: fromTri(e.target.value) })}><option value="">Unknown</option><option value="yes">Yes</option><option value="no">No, it bleeds</option></select></label>
        <label className="check"><input type="checkbox" checked={g.info.stained} onChange={(e) => info({ stained: e.target.checked })} /> Stained (set aside to review)</label>
      </div>
    </article>
  );
}

export function LaundryScreen() {
  const { projectId = '' } = useParams();
  const { api } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [data, setData] = useState<LaundryData>({ region: 'us', garments: [] });
  const [thumbs, setThumbs] = useState<Thumbs>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const saveTimer = useRef<number>(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  // Resume the saved draft.
  useEffect(() => {
    void (async () => {
      try {
        setProject((await api.project(projectId)).project);
        const revs = (await api.revisions(projectId)).revisions;
        const latest = [...revs].sort((a, b) => b.number - a.number)[0];
        if (latest) {
          const def = (await api.revision(projectId, latest.id)).revision.definition as { task?: { data?: unknown }; assets?: { id: string; mediaType: string; data?: string }[] };
          const parsed = parseLaundry(def.task?.data);
          if (parsed.ok) {
            setData(parsed.data);
            const t: Thumbs = {};
            for (const g of parsed.data.garments) {
              const a = def.assets?.find((x) => x.id === g.thumbnail && x.data);
              if (a) t[g.id] = { mediaType: a.mediaType, data: a.data! };
            }
            setThumbs(t);
          }
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        loaded.current = true;
      }
    })();
  }, [api, projectId]);

  const save = useCallback(async (next: LaundryData, t: Thumbs) => {
    if (!next.garments.length) return null;
    const r = await api.saveRevision(projectId, definitionFor(project?.title ?? 'Laundry', next, t));
    return r.revision;
  }, [api, projectId, project]);

  const update = (next: LaundryData, t = thumbsRef.current) => {
    setData(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void save(next, t).then(() => setStatus('Draft saved'), (e: Error) => setError(`Couldn’t save: ${e.message}`)); }, 600);
  };

  const plan = useMemo(() => buildPlan(data.garments), [data]);
  const unconfirmed = data.garments.filter((g) => unconfirmedFields(g).length);

  async function addGarment(file: File, garmentName: string, key = crypto.randomUUID()) {
    const setP = (p: Partial<Pending>) => setPending((all) => [...all.filter((x) => x.key !== key), { key, name: garmentName, status: 'uploading', ...all.find((x) => x.key === key), ...p }]);
    setP({ status: 'uploading', message: undefined });
    try {
      const { upload } = await api.upload(file, projectId);
      setP({ status: 'reading' });
      const { job } = await api.readLabel(upload.id, data.region);
      const done = await waitForJob(api, job.id, () => {});
      if (done.status !== 'succeeded') throw new Error(done.error?.message ?? 'The label couldn’t be read');
      const ex = done.result.extraction as { label: CareLabel; fibers: Garment['info']['fibers']; note: string };
      const cur = dataRef.current;
      const id = slug(garmentName, new Set(cur.garments.map((g) => g.id)));
      const g: Garment = { id, name: garmentName.slice(0, 28), labelUploadId: upload.id, thumbnail: `thumb_${id}`, label: ex.label, info: { fibers: ex.fibers, color: 'unknown', isNew: null, colorfast: null, stained: false } };
      const t = { ...thumbsRef.current, [id]: done.result.thumbnail };
      setThumbs(t);
      update({ ...cur, garments: [...cur.garments, g] }, t);
      setPending((all) => all.filter((x) => x.key !== key));
      if (ex.note) setStatus(ex.note);
    } catch (e) {
      setP({ status: 'failed', message: (e as Error).message, retry: () => void addGarment(file, garmentName, key) });
    }
  }

  async function send() {
    setError(null);
    setStatus('Sending to your glasses…');
    try {
      clearTimeout(saveTimer.current);
      const rev = await save(data, thumbs);
      if (!rev) return;
      const fresh = (await api.project(projectId)).project;
      const { job } = await api.publish(projectId, rev.id, fresh.currentReleaseId);
      const done = await waitForJob(api, job.id, () => {});
      setStatus(done.status === 'succeeded' ? 'Sent. Choose Sync on your glasses.' : 'Sending failed. Try again.');
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  return (
    <main className="page narrow laundry">
      <header className="topbar"><Link to="/" className="text-btn">← Solutions</Link><span className="grow" /><span className="muted tiny">{status}</span></header>
      <h1 className="display sm">{project?.title ?? 'Laundry'}</h1>
      <p className="lede">Photograph each care label. Check what was read, then send the plan to your glasses.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="laundry-add stack">
        <label className="field">Garment name<input value={name} maxLength={28} placeholder="Blue sweater" onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Care label photo<input ref={fileRef} type="file" accept="image/*" capture="environment" aria-label="Care label photo" /></label>
        <button className="primary" disabled={!name.trim()} onClick={() => {
          const f = fileRef.current?.files?.[0];
          if (!f) return setError('Choose a label photo first.');
          setError(null);
          void addGarment(f, name.trim());
          setName('');
          if (fileRef.current) fileRef.current.value = '';
        }}>Add garment</button>
        {pending.map((p) => (
          <div key={p.key} className="row" role="status">
            {p.status !== 'failed' && <span className="spinner xs" />}
            <span className="grow">{p.name}: {p.status === 'uploading' ? 'uploading…' : p.status === 'reading' ? 'reading the label…' : `couldn’t read (${p.message})`}</span>
            {p.status === 'failed' && p.retry && <button className="secondary" onClick={p.retry}>Retry</button>}
            {p.status === 'failed' && <button className="text-btn" onClick={() => setPending((all) => all.filter((x) => x.key !== p.key))}>Cancel</button>}
          </div>
        ))}
      </section>

      <section className="stack">
        {data.garments.map((g) => (
          <GarmentCard key={g.id} g={g} thumb={thumbs[g.id]} onChange={(n) => update({ ...data, garments: data.garments.map((x) => (x.id === g.id ? n : x)) })}
            onRemove={() => update({ ...data, garments: data.garments.filter((x) => x.id !== g.id) })} />
        ))}
      </section>

      {data.garments.length > 0 && (
        <section className="laundry-plan stack" aria-label="Sorting plan">
          <h2>Sorting plan</h2>
          <p className="muted tiny">Grouped by rules from confirmed labels: same cycle, same temperature, same colour. Settings are suggestions to match on your washer.</p>
          {plan.questions.length > 0 && <ul className="laundry-questions">{plan.questions.map((q) => <li key={q.garmentId + q.ask}>{q.question}</li>)}</ul>}
          {plan.washGroups.map((w) => (
            <div key={w.id} className="laundry-group"><b>Group {w.number}{w.alone ? ' (alone)' : ''}</b>: {w.garmentIds.map((id) => garmentName(data.garments, id)).join(', ')}<div className="muted tiny">{w.settings}</div></div>
          ))}
          {plan.hand.length > 0 && <div className="laundry-group"><b>Hand wash</b>: {plan.hand.map((id) => garmentName(data.garments, id)).join(', ')}</div>}
          {plan.professional.length > 0 && <div className="laundry-group"><b>Professional cleaning</b>: {plan.professional.map((id) => garmentName(data.garments, id)).join(', ')}</div>}
          {plan.doNotWash.length > 0 && <div className="laundry-group"><b>Do not wash</b>: {plan.doNotWash.map((id) => garmentName(data.garments, id)).join(', ')}</div>}
          {plan.review.map((r) => <div key={r.garmentId} className="laundry-group warn"><b>Check first: {garmentName(data.garments, r.garmentId)}</b><div className="muted tiny">{r.reason}</div></div>)}
          {plan.dryGroups.map((d) => <div key={d.id} className="laundry-group"><b>Dry</b>: {d.text}: {d.garmentIds.map((id) => garmentName(data.garments, id)).join(', ')}</div>)}
          <button className="primary lg" disabled={unconfirmed.length > 0} onClick={() => void send()}>Send to glasses</button>
          {unconfirmed.length > 0 && <p className="muted tiny">Confirm every label first: {unconfirmed.map((g) => g.name).join(', ')}.</p>}
          <p className="muted tiny">Following a plan can’t guarantee no shrinkage, dye transfer or damage. The garment’s own label always comes first.</p>
        </section>
      )}
    </main>
  );
}
