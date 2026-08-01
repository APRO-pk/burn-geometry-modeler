import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppDesktop from './AppDesktop.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppDesktop />
  </StrictMode>,
);
