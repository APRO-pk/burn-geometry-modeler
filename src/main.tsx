import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppDesktop from './AppDesktop.tsx';
import { NotificationProvider } from './ui/notifications';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NotificationProvider>
      <AppDesktop />
    </NotificationProvider>
  </StrictMode>,
);
