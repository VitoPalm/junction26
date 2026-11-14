import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { App } from '@wearables-ui-toolkit/mrbd';
import { ChoiceScreen, ChecklistScreen, InstructionScreen, ContentScreen, ValueReadout } from './lib/index.js';
import './lib/styles.css';

const steps = [
  'Make a slip knot. Place the loop on your hook and gently tighten it.',
  'Yarn over. Pull the yarn through the loop to make one chain stitch.',
  'Repeat until you have ten chains. Keep the loops loose enough to move.',
];

function ExamplesMenu() {
  const navigate = useNavigate();
  return <ChoiceScreen title="Component examples" items={[
      { id: 'guide', label: 'Crochet guide', hint: 'One instruction at a time' },
      { id: 'checklist', label: 'Project supplies', hint: 'Controlled checklist' },
      { id: 'value', label: 'Character health', hint: 'A local value with actions' },
    ]} onChoose={id => navigate(`/${id}`)} />;
}

function Demo() {
  // Outside the routes: navigation cannot erase domain state.
  const [step, setStep] = useState(1);
  const [packed, setPacked] = useState<Record<string, boolean>>({});
  const [health, setHealth] = useState(12);
  return <BrowserRouter><ReactRouterNavigationProvider><App><Routes>
    <Route path="/" element={<ExamplesMenu />} />
    <Route path="/guide" element={<InstructionScreen title="First chain" step={step} total={steps.length}
      text={steps[step - 1]} actions={[
        { id: 'previous', label: 'Previous', disabled: step === 1, onActivate: () => setStep(s => Math.max(1, s - 1)) },
        { id: 'next', label: 'Next', disabled: step === steps.length, onActivate: () => setStep(s => Math.min(steps.length, s + 1)) },
      ]} />} />
    <Route path="/checklist" element={<ChecklistScreen title="Project supplies" items={[
      { id: 'yarn', label: 'Yarn' }, { id: 'hook', label: 'Crochet hook' }, { id: 'marker', label: 'Stitch marker' },
      { id: 'scissors', label: 'Scissors' }, { id: 'needle', label: 'Yarn needle' }, { id: 'tape', label: 'Measuring tape' },
      { id: 'pattern', label: 'Pattern' },
    ].map(i => ({ ...i, checked: packed[i.id] ?? false }))} onToggle={(id, checked) => setPacked(p => ({ ...p, [id]: checked }))} />} />
    <Route path="/value" element={<ContentScreen title="Character" actions={[
      { id: 'damage', label: 'Lose 1 HP', disabled: health === 0, onActivate: () => setHealth(h => Math.max(0, h - 1)) },
      { id: 'heal', label: 'Heal 1 HP', disabled: health === 20, onActivate: () => setHealth(h => Math.min(20, h + 1)) },
    ]}><ValueReadout label="Health" value={`${health} / 20`} hint="Changes stay in this demo session." /></ContentScreen>} />
  </Routes></App></ReactRouterNavigationProvider></BrowserRouter>;
}

createRoot(document.getElementById('root')!).render(
  <Demo />,
);
