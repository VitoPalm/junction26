import {
  AUTHORING_POLICY, CAPABILITIES, FORMAT_GUIDE, FORMAT_VERSION, LIMITATIONS, LIMITS,
  RUNTIME_VERSION, definitionJsonSchema, validateDefinition, type Issue,
} from '@junction26/applet-format';

/** Shared by discovery, validation and submission; no second applet schema. */
export function assistantCapabilities(maxDefinitionBytes: number) {
  return {
    contractVersion: 1,
    formatVersion: FORMAT_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schema: definitionJsonSchema(),
    capabilities: CAPABILITIES,
    limitations: LIMITATIONS,
    copyLimits: LIMITS,
    maxDefinitionBytes,
    policy: AUTHORING_POLICY,
    formatGuide: FORMAT_GUIDE,
    externalAuthoring: [
      'Author the complete definition yourself using only the relevant context the user authorized.',
      'This integration currently supports text-only applets. Assets, upload refs and remote file URLs are not accepted.',
      'Source ingestion tools mentioned in the format guide belong to managed authoring and are not available here.',
      'Preserve existing state, view and action IDs when revising. Never write live wearer state.',
      'Use one stable operationId for retries of the exact same submission; use a new one after editing content.',
      'Open the returned preview link. Structural validation is not measured fit or hardware verification.',
      'Publishing and glasses sync are separate explicit steps; these tools only save drafts.',
    ],
    measuredFit: 'not_checked',
    publishing: 'preview_ui_only',
  };
}

export function validateAssistantDefinition(input: unknown, maxBytes: number) {
  const bytes = Buffer.byteLength(JSON.stringify(input) ?? 'null');
  if (bytes > maxBytes) return { ok: false as const, issues: [{ path: '$', code: 'too_large', message: `Definition exceeds ${maxBytes} bytes` }] };
  const result = validateDefinition(input);
  if (!result.ok) return result;
  if (result.definition.assets.length) {
    return { ok: false as const, issues: [{ path: 'assets', code: 'external_assets_unsupported', message: 'External assistant drafts currently support text only; omit assets.' }] satisfies Issue[] };
  }
  return result;
}
