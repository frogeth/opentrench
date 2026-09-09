import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

if (/Electron/i.test(navigator.userAgent)) document.documentElement.classList.add('electron');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
