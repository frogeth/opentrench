import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './index.css';

if (/Electron/i.test(navigator.userAgent)) {
  document.documentElement.classList.add('electron');
  // the top bar makes room for the OS's own window controls: left for macOS traffic lights, right for the Windows overlay
  document.documentElement.classList.add(/Mac/i.test(navigator.platform) ? 'os-mac' : /Win/i.test(navigator.platform) ? 'os-win' : 'os-linux');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
