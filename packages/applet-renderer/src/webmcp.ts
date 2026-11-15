import { toolName, type AppletDefinition } from '@junction26/applet-format';
import { cancelBranch, coachContext, coachOf, coachStep, completeCurrent, confirmBranch, describeState, hasGuide, setPanel } from '@junction26/applet-runtime';
import { askCoach, repeatStep } from './coach.tsx';
import { taskModule } from './tasks.ts';
import type { AppletSession } from './session.ts';
import { viewLabel } from './AppletScreen.tsx';
import { noteAnchor, viewsWithNotes, type NoteAnchor } from './notes.ts';

/**
 * WebMCP adapter ("Hey Meta, ..."). Registers one tool per applet action plus
 * built-ins while an applet is open; abort the signal to unregister. Only
 * scalar parameters reach Meta AI and schema constraints aren't enforced, so
 * the runtime validates every argument. Contract: docs/glasses-platform.md.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  /** untrustedContentHint: the result carries text we didn't write (the uploaded manual). */
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: ToolDef, options?: { signal?: AbortSignal }): unknown;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

export interface ToolHost {
  session: () => AppletSession;
  /** Show a view (navigation is the host's job). */
  openView: (viewId: string) => void;
  /** Current view, for "next step" on a guide. */
  currentView: () => string | null;
  /** Voice notes (docs/voice-notes.md). Absent where notes can't be recorded (authoring preview). */
  notes?: {
    start(anchor: NoteAnchor): Promise<NoteToolResult>;
    stop(): Promise<NoteToolResult>;
  };
}

export type NoteToolResult = { ok: true; message: string } | { ok: false; code: string; message: string };

const noteResult = (r: NoteToolResult, say: string) =>
  r.ok ? { ok: true, next_action: say } : { error: r.code, message: r.message, next_action: `Tell the user briefly: ${r.message}` };

export function appletTools(def: AppletDefinition, host: ToolHost): ToolDef[] {
  const t = (n: string) => toolName(def.toolPrefix, n);
  const about = def.summary ? ` (${def.title}: ${def.summary})` : ` (${def.title})`;
  const tools: ToolDef[] = def.actions.map((a) => ({
    name: t(a.id),
    description: [a.description + about, a.examples?.length ? `Examples: ${a.examples.map((e) => `"${e}"`).join(', ')}.` : ''].join(' ').slice(0, 1024),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(a.args.map((x) => [x.name, { type: x.type, description: x.description.slice(0, 256) }])),
      required: a.args.filter((x) => x.required && x.default === undefined).map((x) => x.name),
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const r = await host.session().run(a.id, input ?? {});
      return r.ok
        ? { ok: true, summary: r.summary, next_action: `Briefly tell the user: ${r.summary}` }
        : { error: r.code, message: r.message, next_action: `Tell the user briefly: ${r.message}` };
    },
  }));

  tools.push({
    name: t('read_state'),
    description: `Read the current values of the open applet${about}, e.g. to answer "how many ... do I have?".`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true },
    async execute() {
      return { ok: true, values: describeState(def, host.session().state), next_action: 'Answer the user from these values, briefly.' };
    },
  });

  if (def.views.length > 1) {
    const names = def.views.map((v) => viewLabel(def, v));
    tools.push({
      name: t('open_view'),
      description: `Show a page of the open applet${about}. Pages: ${names.join(', ')}.`,
      inputSchema: { type: 'object', properties: { page: { type: 'string', description: `One of: ${names.join(', ')}`.slice(0, 256) } }, required: ['page'] },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const want = String(input?.page ?? '').trim().toLowerCase();
        const v = def.views.find((x) => x.id === want || viewLabel(def, x).toLowerCase() === want) ?? def.views.find((x) => viewLabel(def, x).toLowerCase().includes(want));
        if (!want || !v) return { error: 'no_such_page', message: `Pages are: ${names.join(', ')}`, next_action: 'Ask which page they want.' };
        host.openView(v.id);
        return { ok: true, next_action: `Say you opened ${viewLabel(def, v)}.` };
      },
    });
  }

  const sequences = def.views.filter((v) => v.kind === 'sequence');
  if (sequences.length) {
    const target = () => {
      const cur = host.currentView();
      return sequences.find((v) => v.id === cur) ?? sequences[0]!;
    };
    for (const [n, by] of [['next_step', 1], ['previous_step', -1]] as const) {
      tools.push({
        name: t(n),
        description: `Go to the ${by > 0 ? 'next' : 'previous'} step of the guide${about}.`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: { readOnlyHint: false },
        async execute() {
          const v = target();
          if (host.currentView() !== v.id) host.openView(v.id);
          // A guide made from a manual: Next/Previous follow an active fix first (see coach.ts).
          if (def.guide?.sequence === v.id) await host.session().update((s) => coachStep(def, s, by));
          else await host.session().step(v.id, by);
          const st = describeState(def, host.session().state);
          return { ok: true, position: st, next_action: 'Read the new step to the user only if they asked; otherwise just confirm.' };
        },
      });
    }
  }
  if (hasGuide(def)) tools.push(...coachTools(def, host, t, about));
  const task = taskModule(def);
  if (task?.tools) tools.push(...task.tools(def, host, t, about));
  const notePages = viewsWithNotes(def);
  if (notePages.length) {
    const names = notePages.map((v) => viewLabel(def, v)).join(', ');
    tools.push({
      name: t('start_voice_note'),
      description: `Start recording a voice note about the page that is open now${about}. Use when the user asks to record, take, add or leave a note, memo or remark here. The user's phone records; they finish by saying "stop recording meta". Pages with notes: ${names}.`.slice(0, 1024),
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: false },
      async execute() {
        if (!host.notes) return noteResult({ ok: false, code: 'notes_unavailable', message: 'Voice notes work on the glasses with the phone app open.' }, '');
        const anchor = noteAnchor(def, host.session().state, host.currentView());
        if (!anchor) return noteResult({ ok: false, code: 'no_note_here', message: `This page has no voice notes. Pages with notes: ${names}.` }, '');
        return noteResult(await host.notes.start(anchor), 'Say only: "Recording." Nothing else.');
      },
    });
    tools.push({
      name: t('stop_voice_note'),
      description: `Stop the voice note that is recording now${about}. Use when the user says stop recording, stop the note, or that they are done.`,
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: false },
      async execute() {
        if (!host.notes) return noteResult({ ok: false, code: 'notes_unavailable', message: 'No note is recording.' }, '');
        return noteResult(await host.notes.stop(), 'Say only: "Saved."');
      },
    });
  }
  return tools;
}

/** Registers tools on document.modelContext if present. Returns how many were accepted. */
export function registerAppletTools(def: AppletDefinition, host: ToolHost, signal: AbortSignal, onError: (e: unknown) => void = console.warn): number {
  const mc = typeof document !== 'undefined' ? document.modelContext : undefined;
  if (!mc) return 0;
  let n = 0;
  for (const tool of appletTools(def, host)) {
    try {
      const r = mc.registerTool(tool, { signal });
      // Return value varies by build (promise / handle / undefined).
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, onError);
      n++;
    } catch (e) {
      onError(e);
    }
  }
  return n;
}

/**
 * Development-only stand-in for document.modelContext so tools can be
 * exercised in a normal browser: window.webmcp.list() / .call(name, args).
 * Never installed on the device (it only runs when explicitly requested).
 */
export function installWebMcpStub(): void {
  if (document.modelContext) return;
  const tools = new Map<string, ToolDef>();
  document.modelContext = {
    registerTool(tool, options) {
      if (tools.has(tool.name)) throw new DOMException(`Duplicate tool ${tool.name}`, 'InvalidStateError');
      tools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => tools.get(tool.name) === tool && tools.delete(tool.name), { once: true });
      return undefined;
    },
  };
  (window as unknown as { webmcp: unknown }).webmcp = {
    list: () => [...tools.values()].map((t) => ({ name: t.name, description: t.description, params: t.inputSchema.properties })),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`No tool ${name}`);
      return tool.execute(args, {});
    },
  };
}

// ---------------------------------------------------------------- task coach

const noArgs = { type: 'object' as const, properties: {}, required: [] };
const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return s && Array.from(s).length <= max ? s : null;
};

/**
 * Voice tools for a guide made from a manual. Each one mirrors an item in the
 * coach's More menu (every voice action has a band path). Tools return at
 * once: a question the device can't answer locally starts a background
 * request and the answer appears on the glasses, so no callback waits on a
 * model. Arguments are validated here; state changes are saved before the
 * tool reports success. Meta AI has no access to the manual beyond what these
 * tools return.
 */
function coachTools(def: AppletDefinition, host: ToolHost, t: (n: string) => string, about: string): ToolDef[] {
  const session = () => host.session();
  const seq = def.guide!.sequence;
  const show = () => { if (host.currentView() !== seq) host.openView(seq); };
  const position = () => coachContext(def, session().state);
  const untrusted = { untrustedContentHint: true };
  return [
    {
      name: t('coach_context'),
      description: `Read the current step of the open assembly guide${about}: instruction, parts, caution, the manual's own text for this step and progress. Use to answer questions about what to do now.`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: true, ...untrusted },
      async execute() {
        return { ok: true, context: position(), next_action: 'Answer only from this context and cite the page. If it does not say, tell the user the manual does not say.' };
      },
    },
    {
      name: t('repeat_step'),
      description: `Repeat the current instruction of the guide${about}. Use for "repeat", "say that again", "what do I do now".`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: false },
      async execute() {
        show();
        const st = await repeatStep(session());
        return { ok: true, text: coachOf(st).answer?.text ?? '', next_action: 'Read this text to the user.' };
      },
    },
    {
      name: t('show_parts'),
      description: `Show the parts and hardware the current step uses${about}. Use for "which screws", "what parts do I need", "show parts".`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: false },
      async execute() {
        show();
        const st = await session().update((s) => setPanel(s, 'parts'));
        const ctx = coachContext(def, st);
        return { ok: true, parts: ctx?.parts ?? [], next_action: 'Name the parts briefly; they are on the glasses.' };
      },
    },
    {
      name: t('complete_step'),
      description: `Mark the current step as done and go to the next one; on the last step, complete the guide${about}. Use for "done", "finished this step", "complete".`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: false },
      async execute() {
        show();
        const st = await session().update((s) => completeCurrent(def, s));
        const ctx = coachContext(def, st);
        return { ok: true, finished: ctx?.progress.finished ?? false, now: ctx?.step.number ?? null, next_action: ctx?.progress.finished ? 'Say the guide is complete.' : 'Confirm briefly.' };
      },
    },
    {
      name: t('ask_question'),
      description: `Ask a question about the current step, answered from the uploaded manual${about}. Examples: "which screw goes here", "which way does the arrow face", "can I skip this". The answer appears on the glasses with its page.`,
      inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'The question in the user\'s words.' } }, required: ['question'] },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const q = text(input?.question, 500);
        if (!q) return { error: 'invalid_question', message: 'I need the question in a few words.', next_action: 'Ask the user what they want to know.' };
        show();
        const st = await askCoach(session(), 'question', q);
        const a = coachOf(st).answer;
        if (a?.local) return { ok: true, answer: a.text, sources: a.sources, next_action: 'Read the answer briefly.' };
        return { ok: true, status: 'checking', next_action: 'Say you are checking the manual and the answer will appear on the glasses. Do not answer it yourself.' };
      },
    },
    {
      name: t('report_problem'),
      description: `Report a problem with the assembly, such as "I attached this backwards" or "it doesn't fit"${about}. The coach may ask a follow-up and proposes a fix the user must confirm on the glasses. It cannot see the work.`,
      inputSchema: { type: 'object', properties: { problem: { type: 'string', description: 'What went wrong, in the user\'s words.' } }, required: ['problem'] },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const p = text(input?.problem, 500);
        if (!p) return { error: 'invalid_problem', message: 'I need to know what went wrong.', next_action: 'Ask the user what happened.' };
        show();
        await askCoach(session(), 'problem', p);
        return { ok: true, status: 'checking', next_action: 'Say you are looking for a fix in the manual; it will appear on the glasses for them to confirm.' };
      },
    },
    {
      name: t('choose_option'),
      description: `Answer the follow-up question the coach is showing on the glasses${about}, by choosing one of its options.`,
      inputSchema: { type: 'object', properties: { option: { type: 'string', description: 'The option the user chose, as shown.' } }, required: ['option'] },
      annotations: { readOnlyHint: false },
      async execute(input) {
        const c = coachOf(session().state).clarify;
        if (!c) return { error: 'no_question', message: 'There is no follow-up question on the glasses.', next_action: 'Tell the user briefly.' };
        const want = text(input?.option, 100)?.toLowerCase() ?? '';
        const choice = c.options.find((o) => o.toLowerCase() === want) ?? c.options.find((o) => want && o.toLowerCase().includes(want));
        const req = coachOf(session().state).requests.find((r) => r.id === c.requestId);
        if (!choice || !req) return { error: 'no_such_option', message: `Options: ${c.options.join(', ')}.`, next_action: 'Ask the user to pick one.' };
        await askCoach(session(), req.kind, req.text, [...req.clarifications, choice]);
        return { ok: true, status: 'checking', next_action: 'Say you are checking.' };
      },
    },
    {
      name: t('confirm_fix'),
      description: `Start the proposed fix shown on the glasses${about}. Only when the user clearly accepts it, e.g. "yes, use that fix".`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: false },
      async execute() {
        const b = coachOf(session().state).branch;
        if (b?.status !== 'proposed') return { error: 'no_proposal', message: 'There is no proposed fix to start.', next_action: 'Tell the user briefly.' };
        await session().update((s) => confirmBranch(s, b.id));
        return { ok: true, steps: b.steps.length, next_action: 'Say the fix has started.' };
      },
    },
    {
      name: t('cancel_fix'),
      description: `Decline the proposed fix, or stop the fix in progress, and go back to the guide${about}. Progress is kept.`,
      inputSchema: noArgs,
      annotations: { readOnlyHint: false },
      async execute() {
        if (!coachOf(session().state).branch) return { error: 'no_fix', message: 'There is no fix to cancel.', next_action: 'Tell the user briefly.' };
        await session().update((s) => cancelBranch(def, s));
        return { ok: true, next_action: 'Say you are back on the guide.' };
      },
    },
  ];
}
