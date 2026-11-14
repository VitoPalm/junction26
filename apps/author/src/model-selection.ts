import type { ModelOption } from './api.ts';

export function chooseModel(models: ModelOption[], preferred: string): string {
  return models.find((m) => m.id === preferred && m.available)?.id ?? models.find((m) => m.default && m.available)?.id ?? models.find((m) => m.available)?.id ?? preferred;
}

export function modelSummary(model: ModelOption): string {
  if (!model.available) return model.unavailableReason ?? 'This model is unavailable. Choose another model.';
  if (model.free) return 'Free demo with example solutions. It does not generate new designs.';
  const inputs = model.capabilities?.images ? 'Text and images' : 'Text only';
  return `${inputs}${model.capabilities?.webSearch ? ' · Can search the web' : ''}`;
}
