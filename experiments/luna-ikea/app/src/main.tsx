import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { App } from '@wearables-ui-toolkit/mrbd';
import { ChoiceScreen, ContentScreen, TextBlock } from './lib/index.js';
import './lib/styles.css';
import './trotten.css';

type DeskSize = '140' | '160';
const STORAGE_KEY = 'trotten-assembly-progress-v1';
type SavedProgress = { size?: DeskSize; steps?: Partial<Record<DeskSize, number>> };

function loadProgress(): SavedProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { steps: {} };
    const saved = JSON.parse(raw) as SavedProgress;
    return {
      size: saved.size === '140' || saved.size === '160' ? saved.size : undefined,
      steps: {
        '140': validStep(saved.steps?.['140']) ? saved.steps?.['140'] : 1,
        '160': validStep(saved.steps?.['160']) ? saved.steps?.['160'] : 1,
      },
    };
  } catch {
    return { steps: {} };
  }
}
function validStep(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 13;
}

const commonSteps = [
  { text: 'Build two matching leg frames. Attach one foot rail to each pair of legs as shown.', page: 4, image: '1.png' },
  { text: 'Join the two centre rail sections with connector A. Align the keyed ends and press them together.', page: 5, image: '2.png' },
  { text: 'Attach a leg to the foot rail. Seat the two bolts shown in the leg bracket.', page: 6, image: '3.png' },
  { text: 'Fit the two locking fasteners into the leg frame. Turn them with the supplied hex key; do not use a drill.', page: 6, image: '4.png' },
  { text: 'Attach the crank-side support to the leg frame with the two shown fasteners.', page: 7, image: '5.png' },
  { text: 'Fit the crank handle and its retaining fastener to the support.', page: 7, image: '6.png' },
  { text: 'Secure the second leg frame to the centre rail using the illustrated fasteners.', page: 8, image: '7.png' },
  { text: 'Slide the rail assembly into the frame until it reaches the position shown.', page: 8, image: '8.png' },
] as const;
const sizeSteps = {
  '140': [
    { text: 'For the 140 cm tabletop, fasten the centre rail and frame at the positions shown. Use the two locking fasteners; do not use a drill.', page: 9, image: '140-9.png' },
    { text: 'Lower the tabletop onto the frame. Keep the crank clear, then attach the two brackets shown.', page: 10, image: '140-10.png' },
    { text: 'Secure the tabletop to the frame at the marked points. Use the supplied hex key; do not use a drill.', page: 11, image: '140-11.png' },
    { text: 'With another person, turn the desk upright carefully.', page: 12, image: '140-12.png' },
  ],
  '160': [
    { text: 'For the 160 cm tabletop, fasten the centre rail and frame at the positions shown. Use the two locking fasteners; do not use a drill.', page: 13, image: '160-9.png' },
    { text: 'Lower the tabletop onto the frame. Fit the support and the seven fasteners shown.', page: 14, image: '160-10.png' },
    { text: 'Secure the tabletop to the frame at the marked points. Use the supplied hex key; do not use a drill.', page: 15, image: '160-11.png' },
    { text: 'With another person, turn the desk upright carefully.', page: 16, image: '160-12.png' },
  ],
} as const;

function SizeMenu() {
  const navigate = useNavigate();
  const [progress] = useState(loadProgress);
  return <ChoiceScreen title="TROTTEN desk size" items={[
    { id: 'trotten.size.140', label: '140 cm desk', hint: progress.steps?.['140'] && progress.steps['140'] > 1 ? `Resume at step ${progress.steps['140']} of 13` : 'Start assembly guide' },
    { id: 'trotten.size.160', label: '160 cm desk', hint: progress.steps?.['160'] && progress.steps['160'] > 1 ? `Resume at step ${progress.steps['160']} of 13` : 'Start assembly guide' },
  ]} onChoose={id => navigate(`/guide/${id.endsWith('140') ? '140' : '160'}`)} />;
}

function Guide() {
  const { size: sizeParam } = useParams();
  const size: DeskSize = sizeParam === '160' ? '160' : '140';
  const navigate = useNavigate();
  const [progress, setProgress] = useState(loadProgress);
  const [step, setStep] = useState(progress.steps?.[size] ?? 1);
  useEffect(() => {
    const next = { ...progress, size, steps: { ...progress.steps, [size]: step } };
    setProgress(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Continue for this session if storage is unavailable. */ }
  }, [size, step]);

  const guide: { text: string; page: number; image?: string; warning?: boolean }[] = [
    { text: 'Use two people when handling the desk. Protect the floor while assembling. If anything is unclear, contact IKEA.', page: 2, warning: true },
    ...commonSteps,
    ...sizeSteps[size],
  ];
  const item = guide[step - 1];
  const assemblyStep = step - 1;
  const actions = [
    { id: 'trotten.previous', label: 'Previous', disabled: step === 1, onActivate: () => setStep(current => Math.max(1, current - 1)) },
    { id: 'trotten.next', label: step === guide.length ? 'Finish' : 'Next', onActivate: () => {
      if (step === guide.length) navigate('/');
      else setStep(current => Math.min(guide.length, current + 1));
    } },
  ];
  return <ContentScreen title="TROTTEN assembly" actions={actions}>
    <TextBlock label={item.warning ? 'Before you start' : `Step ${assemblyStep} of 12`} text={item.text}
      hint={`IKEA manual page ${item.page}`} />
    {!item.warning && item.image && <img className="trotten-diagram" src={`/guide/${item.image}`} alt={`IKEA TROTTEN assembly diagram, manual page ${item.page}`} />}
  </ContentScreen>;
}

function Demo() {
  return <BrowserRouter><ReactRouterNavigationProvider><App><Routes>
    <Route path="/" element={<SizeMenu />} />
    <Route path="/guide/:size" element={<Guide />} />
    <Route path="*" element={<SizeMenu />} />
  </Routes></App></ReactRouterNavigationProvider></BrowserRouter>;
}

createRoot(document.getElementById('root')!).render(<Demo />);
