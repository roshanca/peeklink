import { StrictMode } from 'preact/compat';
import { createRoot } from 'preact/compat/client';
import { Options } from './Options';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
