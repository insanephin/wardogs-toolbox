import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';

// /leaderboard is the public page; everything else is the admin dashboard behind the login.
// Loaded separately so leaderboard visitors don't download the dashboard code.
const load = location.pathname.replace(/\/+$/, '') === '/leaderboard' ? import('./views/Leaderboard.tsx') : import('./App.tsx');

load.then(({ default: Root }) => createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>));
