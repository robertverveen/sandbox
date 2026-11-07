import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/prototype.css';
import './styles/app.css';
import { App } from './App';
import { createQueryClient } from './lib/queries';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={createQueryClient()} />
  </StrictMode>,
);
