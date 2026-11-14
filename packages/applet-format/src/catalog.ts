/**
 * The capability catalog: one machine-readable description of what applets can
 * and can't do. It drives the authoring client's first-run explanation AND the
 * model's system prompt, so the assistant can tell users when something is
 * impossible. Keep it in plain words.
 */
export interface Capability {
  id: string;
  title: string;
  /** For people. */
  description: string;
  examples: string[];
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'motion',
    title: 'Looping demonstrations',
    description: 'Short uploaded GIFs play automatically inside a guide step or on their own page. No playback controls; move to the next step when ready.',
    examples: ['Repeat a crochet stitch demonstration', 'Show one dance movement on a loop'],
  },
  {
    id: 'guide',
    title: 'Step-by-step guides',
    description: 'One step per page that remembers where you are. Good for manuals, recipes, patterns and repairs.',
    examples: ['Guide me through this IKEA manual', 'A recipe I can follow while cooking'],
  },
  {
    id: 'tracker',
    title: 'Counters and trackers',
    description: 'Numbers you change with a pinch or by voice: rows, reps, health points, scores.',
    examples: ['A crochet row counter', 'Track my D&D character\'s health and spell slots'],
  },
  {
    id: 'lists',
    title: 'Lists and checklists',
    description: 'Inventories, packing lists and to-dos you can add to, check off and edit by voice.',
    examples: ['A packing checklist for a weekend hike', 'My character\'s inventory'],
  },
  {
    id: 'voice_notes',
    title: 'Voice notes on a page',
    description: 'Say "Hey Meta, record a note" on a page and talk; say "stop recording meta" to finish. Your phone records it and the phone app shows the audio with a transcript, filed under that page or step.',
    examples: ['Let me leave myself notes on each step of this pattern', 'Remember what I changed in the recipe'],
  },
  {
    id: 'notes',
    title: 'Short reference cards',
    description: 'A few short facts or reminders, one per page.',
    examples: ['Conversion cheatsheet for baking'],
  },
];

/** Things we deliberately don't do, with the reason we give the user. */
export const LIMITATIONS: { id: string; description: string }[] = [
  { id: 'private', description: 'Solutions are personal to one wearer: no sharing, multiplayer or syncing with other people.' },
  { id: 'dice', description: 'No dice or random results: a roll only you can see can\'t be checked by the table.' },
  { id: 'external', description: 'A running solution has no connections to services or live data. During authoring, public links and images can be imported as an offline snapshot.' },
  { id: 'sensors', description: 'No camera, background timers in applets, or notifications. Voice notes record through the enabled phone recorder; solutions cannot listen on their own.' },

  { id: 'scroll', description: 'Every page must fit the display without scrolling, so long content is split into pages.' },
  { id: 'code', description: 'Solutions are built from fixed building blocks, not custom code.' },
];
