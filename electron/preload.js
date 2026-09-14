// The one bridge between the page and the desktop shell: the Discord plugin installer.
// Everything else the page needs comes from the backend over HTTP.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** which Discord installs exist and whether our plugin is injected */
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  /** confirm (native dialog), quit Discord, inject, relaunch */
  discordSetup: () => ipcRenderer.invoke('discord:setup'),
  /** confirm, quit Discord, restore the original app.asar, relaunch */
  discordRemove: () => ipcRenderer.invoke('discord:remove'),
  /** the app's own version */
  version: () => ipcRenderer.invoke('app:version'),
  /** run the updater now; it reports with its own dialog */
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
});
