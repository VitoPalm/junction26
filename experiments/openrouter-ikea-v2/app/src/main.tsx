import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ReactRouterNavigationProvider } from '@wearables-ui-toolkit/mrbd/react-router';
import { App } from '@wearables-ui-toolkit/mrbd';
import { ChoiceScreen, ContentScreen, TextBlock, Diagram } from './lib/index.js';
import { readPositions, resumeIndex, moveIndex } from './progress.js';
import candidate from './generated.json';
import assets from './assets.json';
import './lib/styles.css';
import './guide.css';

const KEY = 'openrouter-trotten-v2';
const pageAssets = assets as Record<string, string>;

function saved() {
  try { return readPositions(localStorage.getItem(KEY)); }
  catch { return readPositions(null); }
}
function Menu() {
  const navigate = useNavigate();
  return <ChoiceScreen title={candidate.title} items={candidate.variants.map(v => ({ id: v.id, label: v.label }))}
    onChoose={id => navigate(`/guide/${encodeURIComponent(id)}`)} />;
}
function Guide() {
  const { id } = useParams();
  const navigate = useNavigate();
  const variant = candidate.variants.find(v => v.id === id);
  const screens = variant ? [...candidate.commonSteps, ...variant.steps] : [];
  const [index, setIndex] = useState(() => {
    const previous = variant ? saved().positions[variant.id] : undefined;
    const migrated = screens.find(s => s.id === previous || s.id.startsWith(`${previous}:text:`))?.id;
    return resumeIndex(screens.map(s => s.id), migrated);
  });
  const item = screens[Math.min(index, screens.length - 1)];
  if (!variant || !item) return <Menu />;
  function go(next: number) {
    setIndex(next);
    try {
      const state = saved();
      state.positions[variant!.id] = screens[next].id;
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch { /* The current session remains usable without storage. */ }
  }
  return <ContentScreen title={item.title ?? undefined} actions={[
    { id: 'guide.previous', label: 'Previous', disabled: index === 0, onActivate: () => go(moveIndex(index, -1, screens.length)) },
    { id: 'guide.next', label: index === screens.length - 1 ? 'Finish' : 'Next', onActivate: () => index === screens.length - 1 ? navigate('/') : go(moveIndex(index, 1, screens.length)) },
  ]}>
    {item.kind === 'image'
      ? <Diagram src={pageAssets[item.id]} alt={`Source diagram, PDF page ${item.diagram?.page ?? item.sourcePage}`} />
      : <TextBlock text={item.text ?? ''} hint={item.hint ?? undefined} />}
  </ContentScreen>;
}
/** Remount the guide per URL so its state starts fresh for each guide. */
function KeyedGuide() {
  const { pathname } = useLocation();
  return <Guide key={pathname} />;
}
function Root() {
  return <BrowserRouter><ReactRouterNavigationProvider><App><Routes>
    <Route path="/" element={<Menu />} />
    <Route path="/guide/:id" element={<KeyedGuide />} />
    <Route path="*" element={<Menu />} />
  </Routes></App></ReactRouterNavigationProvider></BrowserRouter>;
}
createRoot(document.getElementById('root')!).render(<Root />);
