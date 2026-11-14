# Model provider setup

All credentials and endpoints are server configuration, shared by API and worker.
The phone/web app selects allowed model IDs; it never receives provider keys.
Nothing in this setup makes a model call. Restart API and worker after changing it.

## Native and existing providers

| Prefix | Credentials | Endpoint default |
| --- | --- | --- |
| `openrouter:` (also bare model names) | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `openai:` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `anthropic:` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| `gemini:` | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| `fake:demo` | None | Local deterministic examples |

Each remote provider has a matching `<PREFIX>_BASE_URL` override. Use the API
root including `/v1` or `/v1beta`, without the operation suffix. Set actual
provider model IDs, for example in a git-ignored `.env.backend.local`:

```dotenv
AUTHORING_MODEL=anthropic:your-claude-model-id
AUTHORING_MODELS=gemini:your-gemini-model-id,openai:your-openai-model-id,fake:demo
ANTHROPIC_API_KEY=replace-in-your-local-file
GEMINI_API_KEY=replace-in-your-local-file
OPENAI_API_KEY=replace-in-your-local-file
```

The default always joins the allowlist. A model with missing credentials appears
unavailable; this does not verify whether a present key works or has credit.
Unknown prefixes fail instead of silently routing to OpenRouter. Bare routed
names containing a slash, including `vendor/model:free`, still mean OpenRouter.

`openai:` defaults to `OPENAI_TOKEN_PARAMETER=max_completion_tokens`. For an
older compatible endpoint use `max_tokens`. `OPENAI_RESPONSE_FORMAT` accepts
`json_schema` (default), `json_object` or `prompt`. More independent endpoints
can coexist through the configuration below.

## Other hosted providers and local servers

`MODEL_PROVIDERS` is a JSON array. Give each endpoint a unique lowercase ID;
reference secrets by environment-variable name using `apiKeyEnv`. This works
for services implementing OpenAI Chat Completions (potentially Groq, Together,
Mistral, DeepSeek, xAI, Featherless, vLLM, Ollama or LM Studio); support depends
on the selected endpoint/model and has not been live-verified for these services.

```dotenv
MODEL_PROVIDERS='[{"id":"hosted","baseUrl":"https://your-provider.example/v1","apiKeyEnv":"HOSTED_MODEL_KEY","responseFormat":"json_object","capabilities":{"tools":true}},{"id":"local","baseUrl":"http://127.0.0.1:11434/v1","auth":"none","responseFormat":"prompt","capabilities":{"tools":false},"modelCapabilities":{"your-vision-model":{"images":true}}}]'
HOSTED_MODEL_KEY=replace-in-your-local-file
AUTHORING_MODELS=hosted:your-model,local:your-local-model,fake:demo
```

Within a container, a local URL refers to that container, so use an address
reachable by both API and worker. Credentials are required by default;
`auth: "none"` explicitly permits local servers that do not use API keys.
This setting means only "no authentication", not "free inference".

Supported endpoint fields:

- `id`, `baseUrl`, optional `apiKeyEnv`, `auth` (`bearer` or `none`).
- `responseFormat`: `prompt` (default), `json_object`, or `json_schema`.
- `tokenParameter`: `max_tokens` (default) or `max_completion_tokens`.
- `capabilities`: booleans `images`, `files` (PDF wire input), `audio`,
  `structuredOutput`, `tools`. All default false except `structuredOutput`,
  which follows the selected output format. `webSearch` may only be false.
- `modelCapabilities`: model-ID keyed overrides for those capabilities. Setting
  `structuredOutput: false` forces schema guidance in the prompt.

IDs cannot replace the built-in providers. Invalid JSON, unknown fields and
repeated IDs fail startup. API keys are resolved from the server environment;
putting `apiKey` directly inside the JSON is rejected.

Opt into modalities and tools only when the selected endpoint/model accepts
those wire formats. A provider configured without tools still generates applets
from the prompt and prepared document text, but cannot run source tools. A model
without image input cannot interpret diagrams. Native Anthropic supports text,
images and PDFs; native Gemini supports those plus audio. Native schemas are
prompt guidance with local validation, allowing the applet schema to remain
provider-neutral. Reasoning effort currently forwards only to OpenRouter and
OpenAI; native providers use their model defaults. Search currently remains an
OpenRouter feature. Bedrock, Vertex IAM and Azure-specific authentication are
not implemented by these adapters.

## Verification without credits

Run `npm test -w @junction26/model -w @junction26/server-common -w @junction26/author`
and `npm test -w @junction26/api -w @junction26/worker`. Model contract tests
inject mocked HTTP responses and make no paid calls. Backend integration tests
use throwaway databases when `TEST_DATABASE_URL` is configured.

Fixtures cover native requests, images/PDF/audio translation, parallel tool-call
round trips, Gemini thought signatures, output modes, token parameters, usage,
missing keys, malformed replies, rate limits, budget failures, cancellation and
body-read timeouts. These are local compatibility checks, not proof of provider
access, schema adherence, model quality or on-device behavior. Existing real
OpenRouter pipeline evidence is separate in [model-pipeline.md](model-pipeline.md).

Protocol references: [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
and [Gemini generateContent](https://ai.google.dev/api/generate-content).
