import { toolName, type AppletDefinition } from '@junction26/applet-format';
import { describeState } from '@junction26/applet-runtime';
import type { AppletSession } from './session.ts';
import { viewLabel } from './AppletScreen.tsx';

/**
 * WebMCP adapter ("Hey Meta, ..."). Registers one tool per applet action plus
 * built-ins while an applet is open; abort the signal to unregister. Only
 * scalar parameters reach Meta AI and schema constraints aren't enforced, so
 * the runtime validates every argument. Contract: docs/glasses-platform.md.
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  annotations?: { readOnlyHint?: boolean };
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
}

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
          await host.session().step(v.id, by);
          const st = describeState(def, host.session().state);
          return { ok: true, position: st, next_action: 'Read the new step to the user only if they asked; otherwise just confirm.' };
        },
      });
    }
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
