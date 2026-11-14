import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ClerkApp } from './ClerkApp.tsx';
import './styles.css';

const authMode = import.meta.env.VITE_AUTH_MODE ?? (import.meta.env.DEV ? 'dev' : 'clerk');
if (!['dev', 'clerk'].includes(authMode)) throw new Error('VITE_AUTH_MODE must be dev or clerk');
if (import.meta.env.PROD && authMode === 'dev') throw new Error('Development sign-in is refused in release builds');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {authMode === 'clerk' ? <ClerkApp /> : <App />}
  </StrictMode>,
);
