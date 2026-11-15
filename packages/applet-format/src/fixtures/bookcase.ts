/**
 * Task-coach fixture: the coach definition for manuals/two-shelf-bookcase.md
 * (an original manual written for tests). Every step cites its page and
 * step label, uses part IDs from `guide.parts`, and keeps the manual's
 * cautions. Step 8 carries an `unreadable` flag and step 9 an `ambiguous` one,
 * because the manual doesn't say which wall screws to use. Each step has an
 * original diagram, so the glasses show it image-first.
 */
import type { z } from 'zod';
import type { AppletDefinition } from '../schema.ts';
import { BOOKCASE_DIAGRAMS } from './bookcase-diagrams.ts';

type Input = z.input<typeof AppletDefinition>;

export const BOOKCASE_SOURCE_TITLE = 'Two-shelf bookcase: assembly instructions';

export const bookcaseGuide: Input = {
  formatVersion: 1,
  title: 'Two-shelf bookcase',
  toolPrefix: 'shelf',
  summary: 'Step-by-step assembly coach for the two-shelf bookcase manual.',
  state: [{ id: 'step', type: 'cursor', label: 'Step', over: 'assembly', default: 0 }],
  actions: [],
  views: [
    {
      id: 'assembly',
      kind: 'sequence',
      title: 'Bookcase',
      cursor: 'step',
      steps: [
        { id: 'check_parts', title: 'Check the parts', image: 'd_check_parts', alt: 'Lay out every part and count it against the parts list.', hint: 'Missing part? Stop and ask the retailer.', source: { page: 2, section: 'Step 1' }, parts: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
        { id: 'cam_bolts', title: 'Cam bolts', image: 'd_cam_bolts', alt: 'Screw the 4 cam bolts into the small holes on the inside of both side panels.', hint: 'Hand-tight until the collar touches.', source: { page: 2, section: 'Step 2' }, parts: ['a', 'g'], warning: 'Do not overtighten.' },
        { id: 'dowels', title: 'Dowels', image: 'd_dowels', alt: 'Push 2 dowels into the end holes of each shelf.', hint: 'Tap gently with the hammer if needed.', source: { page: 3, section: 'Step 3' }, parts: ['b', 'h'] },
        { id: 'left_side', title: 'Left side', image: 'd_left_side', alt: 'Fit the left side panel onto both shelves so the cam bolts enter the large holes.', hint: 'Finished shelf edges face the front.', source: { page: 3, section: 'Step 4' }, parts: ['g', 'h'] },
        { id: 'cam_locks', title: 'Cam locks', image: 'd_cam_locks', alt: 'Put cam locks in the large holes under the shelves, arrow toward the bolt. Turn clockwise half a turn.', source: { page: 3, section: 'Step 5' }, parts: ['c'] },
        { id: 'right_side', title: 'Right side', image: 'd_right_side', alt: 'Attach the right side panel the same way as the left: bolts into shelves, then cam locks.', source: { page: 4, section: 'Step 6' }, parts: ['g', 'c'] },
        { id: 'back_panel', title: 'Back panel', image: 'd_back_panel', alt: 'Slide the back panel into the grooves at the back of the side panels, smooth side forward.', source: { page: 4, section: 'Step 7' }, parts: ['e'], warning: 'The back panel keeps it square. Never skip it.' },
        { id: 'nails', title: 'Nail the back', image: 'd_nails', alt: 'Nail the back panel to the shelves with the small nails.', source: { page: 5, section: 'Step 8' }, parts: ['f', 'e'], flag: 'unreadable', flagNote: 'Nail spacing figure is unreadable.' },
        { id: 'wall_fix', title: 'Fix to the wall', image: 'd_wall_fix', alt: 'Fix the bookcase to the wall with the wall bracket.', source: { page: 5, section: 'Step 9' }, parts: ['d'], warning: 'It can tip over if not fixed to the wall.', flag: 'ambiguous', flagNote: 'Wall screws not included or named.' },
      ],
    },
  ],
  // Original step diagrams (scripts/coach/make-bookcase-diagrams.ts).
  assets: Object.entries(BOOKCASE_DIAGRAMS).map(([id, data]) => ({ id: `d_${id}`, mediaType: 'image/png' as const, data })),
  guide: {
    sequence: 'assembly',
    sourceTitle: BOOKCASE_SOURCE_TITLE,
    parts: [
      { id: 'a', label: 'Cam bolt (A)', quantity: 4, detail: '34 mm, silver', source: { page: 2 } },
      { id: 'b', label: 'Wooden dowel (B)', quantity: 8, detail: '30 mm', source: { page: 2 } },
      { id: 'c', label: 'Cam lock (C)', quantity: 4, detail: 'Round, with an arrow', source: { page: 2 } },
      { id: 'd', label: 'Wall bracket (D)', quantity: 1, detail: 'White plastic', source: { page: 2 } },
      { id: 'e', label: 'Back panel (E)', quantity: 1, detail: 'Thin hardboard', source: { page: 2 } },
      { id: 'f', label: 'Small nail (F)', quantity: 16, detail: '20 mm', source: { page: 2 } },
      { id: 'g', label: 'Side panel (G)', quantity: 2, source: { page: 2 } },
      { id: 'h', label: 'Shelf (H)', quantity: 2, source: { page: 2 } },
    ],
    excerpts: [
      { text: 'You need a Phillips screwdriver and a small hammer. No power tools.', source: { page: 1 } },
      { text: 'Assembly takes about 30 minutes. Two people make step 5 easier.', source: { page: 1 } },
      { stepId: 'check_parts', text: 'Lay out every part and count them against the table. If anything is missing, stop and contact the retailer. Do not substitute other screws.', source: { page: 2, section: 'Step 1' } },
      { stepId: 'cam_bolts', text: 'Screw the four cam bolts (A) into the small holes on the inner face of both side panels (G). Turn them by hand until the collar touches the panel. Do not overtighten.', source: { page: 2, section: 'Step 2' } },
      { stepId: 'dowels', text: 'Push two wooden dowels (B) into the end holes of each shelf (H). Tap them gently with the hammer if needed.', source: { page: 3, section: 'Step 3' } },
      { stepId: 'left_side', text: 'Fit the left side panel (G) onto both shelves so that the cam bolts enter the large holes in the shelves. The finished edge of each shelf faces the front.', source: { page: 3, section: 'Step 4' } },
      { stepId: 'cam_locks', text: 'Put the cam locks (C) into the large holes on the underside of the shelves, arrow pointing toward the cam bolt. Turn each lock clockwise half a turn with the screwdriver until it pulls tight.', source: { page: 3, section: 'Step 5' } },
      { stepId: 'right_side', text: 'Attach the right side panel (G) the same way as steps 4 and 5.', source: { page: 4, section: 'Step 6' } },
      { stepId: 'back_panel', text: 'Slide the back panel (E) into the grooves at the back of the side panels, smooth side facing forward. Caution: the back panel keeps the bookcase square. Do not use the bookcase without it.', source: { page: 4, section: 'Step 7' } },
      { stepId: 'nails', text: 'Nail the back panel to the shelves with the small nails (F). [The spacing figure on this page is smudged and cannot be read.]', source: { page: 5, section: 'Step 8' } },
      { stepId: 'wall_fix', text: 'Fix the bookcase to the wall with the wall bracket (D). Warning: the bookcase can tip over if it is not fixed to the wall. Wall screws are not included because the right type depends on your wall. Ask a hardware store which screws suit your wall.', source: { page: 5, section: 'Step 9' } },
    ],
  },
};
