import { z } from 'zod';
import type { AppletDefinition, Issue } from '@junction26/applet-format';
import type { ModelTool, Part } from '@junction26/model';
import {
  cropImage,
  fetchPublic,
  readUrl,
  SOURCE_LIMITS,
  sourceParts,
  type PreparedSource,
  type SourceImage,
} from './sources.ts';

const urlArgs = z.object({ url: z.string().url() }).strict();
const searchArgs = z.object({ query: z.string().min(3).max(200) }).strict();
const cropArgs = z
  .object({
    ref: z.string(),
    left: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict();
const tool = (name: string, description: string, schema: z.ZodType): ModelTool => ({
  name,
  description,
  parameters: z.toJSONSchema(schema) as Record<string, unknown>,
});
export const SOURCE_TOOLS: ModelTool[] = [
  tool(
    'read_url',
    'Read a public source URL (HTML, PDF or image). Returns text, source image refs and image URLs. Fetch a useful image URL with this same tool before using it. Never send private or credentialed URLs.',
    urlArgs,
  ),
  tool(
    'search_web',
    'Find source material on the public web. Returns cited source facts and links. Read relevant result URLs before relying on detailed instructions or importing their images.',
    searchArgs,
  ),
  tool(
    'search_images',
    'Find reusable images on Wikimedia Commons. Use a short subject phrase such as "bowline knot"; omit words like Wikimedia, reusable, image, photo or license. Returns image URLs, descriptions and attribution links. Read the selected URL to inspect and import the image; never use search thumbnails as unverified instructions.',
    searchArgs,
  ),
  tool(
    'crop_image',
    'Create a focused image from a provided image ref using normalized coordinates (0..1). Preserve orientation, labels and warnings; retain an overview when context is needed.',
    cropArgs,
  ),
];
export class AuthoringSources {
  readonly images = new Map<string, SourceImage>();
  readonly sources: PreparedSource[] = [];
  readonly fetched = new Set<string>();
  readonly attributions = new Map<string, string>();
  readonly vision: boolean;
  readonly signal: AbortSignal;
  readonly search?: (query: string) => Promise<string>;
  constructor(vision: boolean, signal: AbortSignal, search?: (query: string) => Promise<string>) {
    this.vision = vision;
    this.signal = signal;
    this.search = search;
  }
  add(source: PreparedSource): Part[] {
    if (this.images.size + source.images.filter((i) => !this.images.has(i.ref)).length > SOURCE_LIMITS.images)
      throw new Error('Too many source images. Use a smaller excerpt.');
    for (const i of source.images) this.images.set(i.ref, i);
    this.sources.push(source);
    return sourceParts(source, this.vision);
  }
  async read(url: string): Promise<Part[]> {
    if (this.fetched.has(url)) return [{ type: 'text', text: 'Already read this URL; use its existing source refs.' }];
    if (this.fetched.size >= 8) throw new Error('URL budget reached (8 per generation).');
    this.fetched.add(url);
    const source = await readUrl(url, this.signal);
    for (const image of source.images) image.attribution = this.attributions.get(url);
    return this.add(source);
  }
  async run(name: string, args: string): Promise<Part[]> {
    this.signal.throwIfAborted();
    try {
      const value = JSON.parse(args);
      if (name === 'read_url') return await this.read(urlArgs.parse(value).url);
      if (name === 'crop_image') {
        const { ref, ...box } = cropArgs.parse(value);
        const source = this.images.get(ref);
        if (!source) throw new Error('Unknown image ref');
        return this.add({
          version: 1,
          source: source.source,
          text: '',
          images: [await cropImage(source, box)],
          warnings: [],
        });
      }
      if (name === 'search_web') {
        if (!this.search)
          throw new Error('Web search is unavailable for this model provider; ask for a URL or upload.');
        return [{ type: 'text', text: await this.search(searchArgs.parse(value).query) }];
      }
      if (name === 'search_images') {
        const { query } = searchArgs.parse(value);
        const api = new URL('https://commons.wikimedia.org/w/api.php');
        api.search = new URLSearchParams({
          action: 'query',
          format: 'json',
          generator: 'search',
          gsrsearch:
            query
              .replace(/\b(wikimedia|commons|reusable|illustration|diagram|photo|image|public domain|license)\b/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim() || query,
          gsrnamespace: '6',
          gsrlimit: '5',
          prop: 'imageinfo',
          iiprop: 'url|extmetadata',
          iiurlwidth: '1000',
        }).toString();
        const response = await fetchPublic(api.href, this.signal);
        const json = JSON.parse(response.bytes.toString());
        const images = Object.values(json.query?.pages ?? {}).map((p: any) => ({
          title: p.title,
          url: p.imageinfo?.[0]?.url,
          preview: p.imageinfo?.[0]?.thumburl,
          attribution: p.imageinfo?.[0]?.descriptionurl,
          license: p.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value,
          description: String(p.imageinfo?.[0]?.extmetadata?.ImageDescription?.value ?? '')
            .replace(/<[^>]*>/g, '')
            .slice(0, 1000),
        }));
        for (const i of images) {
          if (i.attribution) {
            if (i.url) this.attributions.set(i.url, `${i.attribution} (${i.license ?? 'check source license'})`);
            if (i.preview)
              this.attributions.set(i.preview, `${i.attribution} (${i.license ?? 'check source license'})`);
          }
        }
        return [
          {
            type: 'text',
            text: JSON.stringify({
              images,
              next: images.length
                ? 'Read a relevant image URL to inspect and import it.'
                : 'No matches. Retry with a shorter subject phrase, or use search_web.',
            }),
          },
        ];
      }
      throw new Error('Unknown source tool');
    } catch (e) {
      this.signal.throwIfAborted();
      return [
        {
          type: 'text',
          text: JSON.stringify({
            error: (e as Error).message,
            next: 'Do not invent missing source facts. Try a different public source or ask for an upload.',
          }),
        },
      ];
    }
  }
  /** Models reference only supplied images. Hydrate locally; never trust generated base64 or arbitrary upload IDs. */
  resolve(def: AppletDefinition, base: AppletDefinition | null): Issue[] {
    const issues: Issue[] = [];
    for (const [index, a] of def.assets.entries()) {
      const found = a.uploadId ? this.images.get(a.uploadId) : undefined;
      const prior = base?.assets?.find((b) => b.id === a.id && b.uploadId === a.uploadId && b.data);
      if (found) {
        a.data = found.animation?.data ?? found.data;
        a.mediaType = found.animation?.mediaType ?? found.mediaType;
        a.source = found.source;
        a.attribution = found.attribution;
      } else if (prior) {
        a.data = prior.data;
        a.mediaType = prior.mediaType;
        a.source = prior.source;
        a.attribution = prior.attribution;
      } else
        issues.push({
          path: `definition.assets[${index}]`,
          code: 'source_reference',
          message:
            'Use uploadId equal to an exact supplied source image ref, or keep an existing asset unchanged. Never invent image data or refs.',
        });
    }
    const motionBytes = def.assets.filter((a) => a.mediaType === 'image/gif')
      .reduce((total, a) => total + Buffer.byteLength(a.data?.replace(/^data:[^,]+,/, '') ?? '', 'base64'), 0);
    if (motionBytes > 2 * 1024 * 1024)
      issues.push({ path: 'definition.assets', code: 'motion_budget', message: 'Looping GIFs exceed the 2 MiB motion budget. Use fewer or shorter excerpts.' });
    if (def.assets.some((a) => a.mediaType === 'image/gif') && /^0\.[01]\./.test(def.minimumRuntimeVersion))
      issues.push({ path: 'definition.minimumRuntimeVersion', code: 'runtime_version', message: 'Looping GIFs require minimumRuntimeVersion 0.2.0.' });
    return issues;
  }
}
