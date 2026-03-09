const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaApp', {
  getDashboard: () => ipcRenderer.invoke('app:get-dashboard'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickDirectory: () => ipcRenderer.invoke('settings:pick-directory'),
  search: (payload) => ipcRenderer.invoke('search:run', payload),
  inspectLink: (url) => ipcRenderer.invoke('search:inspect-link', url),
  startDownload: (item) => ipcRenderer.invoke('downloads:start', item),
  listLibrary: (payload) => ipcRenderer.invoke('library:list', payload),
  rescanLibrary: () => ipcRenderer.invoke('library:rescan'),
  listPlaylists: () => ipcRenderer.invoke('playlists:list'),
  createPlaylist: (payload) => ipcRenderer.invoke('playlists:create', payload),
  addTrackToPlaylist: (payload) => ipcRenderer.invoke('playlists:add-track', payload),
  removeTrackFromPlaylist: (payload) => ipcRenderer.invoke('playlists:remove-track', payload),
  openDownloadFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  onDownloadUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('downloads:update', listener);
    return () => ipcRenderer.removeListener('downloads:update', listener);
  }
});
