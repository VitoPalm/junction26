/** Small inline icon set (stroke icons, 24px grid, currentColor). */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 20, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconBack = (p: P) => <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>;
export const IconArrowUp = (p: P) => <svg {...base(p)}><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>;
export const IconArrowRight = (p: P) => <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconClose = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const IconClip = (p: P) => <svg {...base(p)}><path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" /></svg>;
export const IconHelp = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.3a2.6 2.6 0 015 .9c0 1.7-2.5 2.3-2.5 4" /><path d="M12 17.3v.01" strokeWidth={2.6} /></svg>;
export const IconReset = (p: P) => <svg {...base(p)}><path d="M4 12a8 8 0 108-8 8.3 8.3 0 00-5.7 2.3L4 8.5" /><path d="M4 4v4.5h4.5" /></svg>;
export const IconMic = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" /></svg>;
export const IconSend = (p: P) => <svg {...base(p)}><path d="M4.5 12L20 4.5 15.5 20l-3-6.5z" /><path d="M12.5 13.5L20 4.5" /></svg>;
export const IconSpark = (p: P) => <svg {...base(p)}><path d="M12 3.5l1.9 5.3 5.6 1.9-5.6 1.9L12 18l-1.9-5.4-5.6-1.9 5.6-1.9z" /><path d="M19 16v4M17 18h4" /></svg>;
export const IconFile = (p: P) => <svg {...base(p)}><path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z" /><path d="M14 3.5v5h5" /></svg>;
export const IconWarn = (p: P) => <svg {...base(p)}><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.01" /></svg>;
export const IconLogout = (p: P) => <svg {...base(p)}><path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 16l-4-4 4-4M6 12h10" /></svg>;
export const IconTrash = (p: P) => <svg {...base(p)}><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" /></svg>;
export const IconLink = (p: P) => <svg {...base(p)}><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></svg>;
export const IconGlasses = (p: P) => (
  <svg {...base(p)}>
    <path d="M1.8 9.2L3.2 7M22.2 9.2L20.8 7" />
    <path d="M2.5 10h8v2.2a3.6 3.6 0 01-3.6 3.6h-.8a3.6 3.6 0 01-3.6-3.6zM13.5 10h8v2.2a3.6 3.6 0 01-3.6 3.6h-.8a3.6 3.6 0 01-3.6-3.6z" />
    <path d="M10.5 10.8c1-.6 2-.6 3 0" />
  </svg>
);

/* Capability glyphs for the "what you can make" sheet. */
export const IconLoop = (p: P) => <svg {...base(p)}><path d="M17 3.5l3 3-3 3" /><path d="M20 6.5H9a5 5 0 00-5 5v.5M7 20.5l-3-3 3-3" /><path d="M4 17.5h11a5 5 0 005-5V12" /></svg>;
export const IconSteps = (p: P) => <svg {...base(p)}><path d="M4 19h5v-5h5V9h5V4" /></svg>;
export const IconCounter = (p: P) => <svg {...base(p)}><rect x="3.5" y="5" width="17" height="14" rx="4" /><path d="M8 12h3M9.5 10.5v3M14 12h2.5" /></svg>;
export const IconList = (p: P) => <svg {...base(p)}><path d="M4 7l1.5 1.5L8 6M4 13l1.5 1.5L8 12M11 7.2h9M11 13.2h9M11 19h9M4.5 19h2" /></svg>;
export const IconCard = (p: P) => <svg {...base(p)}><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M7.5 10h9M7.5 14h5" /></svg>;

export const CAPABILITY_ICONS: Record<string, (p: P) => React.JSX.Element> = {
  motion: IconLoop,
  guide: IconSteps,
  tracker: IconCounter,
  lists: IconList,
  notes: IconCard,
};

/** The brand mark: two lenses lit by the signature gradient. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className="brand-mark">
      <defs>
        <linearGradient id="bm-g" x1="4" y1="8" x2="44" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF9A5C" />
          <stop offset="0.5" stopColor="#FF4F8B" />
          <stop offset="1" stopColor="#7A5CFF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill="url(#bm-g)" />
      <g fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 19h13v4a6 6 0 01-6 6h-1a6 6 0 01-6-6zM27 19h13v4a6 6 0 01-6 6h-1a6 6 0 01-6-6z" />
        <path d="M21 20.2c2-1.2 4-1.2 6 0" />
      </g>
      <path d="M30.5 22.5h5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity="0.9" />
    </svg>
  );
}
