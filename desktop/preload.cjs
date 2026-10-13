'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, params) => ipcRenderer.invoke('mediahub:ui', { method, params }).then(receipt => {
  if (!receipt.ok) throw Object.assign(new Error(receipt.error?.message || '操作失败'), { code: receipt.error?.code });
  return receipt.result;
});
contextBridge.exposeInMainWorld('mediaHub', Object.freeze({
  call: (method, params = {}) => invoke('call', { method, params }),
  onChanged: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('mediahub:changed', listener); return () => ipcRenderer.removeListener('mediahub:changed', listener); },
  selectWorkspace: () => invoke('selectWorkspace'),
  importAssets: projectId => invoke('importAssets', { projectId }),
  openArtifact: id => invoke('openArtifact', { id }),
  showInFolder: (kind, id) => invoke('showInFolder', { kind, id }),
  copyConnection: () => invoke('copyConnection'),
  downloadSkill: () => invoke('downloadSkill'),
  openStudio: (projectId, bounds) => invoke('openStudio', { projectId, bounds }),
  setStudioBounds: bounds => { ipcRenderer.send('mediahub:studio-bounds', bounds); },
  closeStudio: () => invoke('closeStudio')
}));
