import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createModelRegistry, extractJson, type CompletionRequest } from '@junction26/model';

/** All video benchmarks share the owner's $3 authorization and durable receipts. Run serially. */
export async function videoTestRun(name: string, model = 'openai/gpt-6.1-sol') {
  assert.ok(process.argv.includes('--paid'), 'Requires --paid; spends OpenRouter credit');
  assert.ok(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY required');
  const root = resolve('.data/video-testing/paid');
  await mkdir(root, { recursive: true });
  const receipts = await Promise.all((await readdir(root)).filter(f => /^receipt-.*\.json$/.test(f)).map(async f => JSON.parse(await readFile(join(root, f), 'utf8'))));
  assert.ok(receipts.every(r => typeof r.costUsd === 'number' || Number.isFinite(r.reservation)), 'Unknown cost without a reservation; stop');
  let knownSpent = receipts.reduce((n, r) => n + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
  const held = receipts.reduce((n, r) => n + (typeof r.costUsd === 'number' ? 0 : r.reservation), 0);
  let spent = knownSpent + held;
  const resume = process.argv.find(x => x.startsWith('--resume='))?.slice(9);
  const run = resume ? resolve(resume) : join(root, `${name}-${Date.now()}`);
  assert.ok(run.startsWith(`${root}/`), 'Resume must be inside the video evidence directory');
  if (!resume) await mkdir(run);
  const provider = createModelRegistry({ openRouter: { apiKey: process.env.OPENROUTER_API_KEY, baseUrl: 'https://openrouter.ai/api/v1' } }).resolve(model).provider;
  const res = await fetch('https://openrouter.ai/api/v1/models'); assert.ok(res.ok);
  const entry = (await res.json() as any).data.find((m: any) => m.id === model); assert.ok(entry);
  await writeFile(join(run, 'pricing.json'), JSON.stringify({ model, pricing: entry.pricing }, null, 2));
  const rates = [entry.pricing, ...(entry.pricing.overrides ?? [])];
  const prompt = Math.max(...rates.map((p: any) => Number(p.prompt)));
  const output = Math.max(...rates.map((p: any) => Number(p.completion)));
  const files = await readdir(run);
  let serial = Math.max(0, ...files.map(f => Number(/^(\d+)-/.exec(f)?.[1] ?? 0)));
  return {
    run, model, spent: () => knownSpent, reserved: () => held, accounted: () => spent,
    async call(label: string, req: Omit<CompletionRequest, 'model'>): Promise<any> {
      const cached = resume && files.find(f => new RegExp(`^\\d+-${label}\\.json$`).test(f));
      if (cached) {
        const result = JSON.parse(await readFile(join(run, cached), 'utf8'));
        assert.equal(result.model, model);
        console.log(`Reusing recorded ${label}; no paid call`);
        return extractJson(result.text);
      }
      const parts = req.messages.flatMap(m => m.content);
      assert.ok(parts.every(p => p.type === 'image' || p.type === 'text'));
      const tokens = Buffer.byteLength(req.system) + parts.reduce((n, p) => n + (p.type === 'image' ? 16384 : p.type === 'text' ? Buffer.byteLength(p.text) : 0), 0);
      const reservation = tokens * prompt + req.maxOutputTokens * output;
      assert.ok(Number.isFinite(reservation) && spent + reservation <= 3, 'Remaining $3 budget cannot cover this request');
      const stamp = `${Date.now()}-${++serial}`;
      const receipt = join(root, `receipt-${stamp}.json`);
      await writeFile(receipt, JSON.stringify({ label, model, costUsd: null, reservation }), { flag: 'wx' });
      const result = await provider.complete({ ...req, model });
      await writeFile(join(run, `${serial}-${label}.json`), JSON.stringify(result, null, 2));
      await writeFile(receipt, JSON.stringify({ label, model, requestId: result.requestId, ...result.usage }));
      assert.equal(typeof result.usage.costUsd, 'number', 'Unknown cost; stop');
      spent += result.usage.costUsd!;
      knownSpent += result.usage.costUsd!;
      console.log(JSON.stringify({ label, ...result.usage, reportedVideoSpend: knownSpent, unreconciledReserve: held, accountedVideoBudget: spent }));
      assert.equal(result.finishReason, 'stop', 'Truncated model output');
      const parsed = extractJson(result.text); assert.ok(parsed, 'Invalid JSON response');
      return parsed;
    },
  };
}
