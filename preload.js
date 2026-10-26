'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('gendo', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  getDefaults: () => ipcRenderer.invoke('config:defaults'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getModelStatus: () => ipcRenderer.invoke('system:models'),

  pickFiles: (options) => ipcRenderer.invoke('dialog:pickFiles', options),
  pickFolder: (options) => ipcRenderer.invoke('dialog:pickFolder', options),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  startJob: (kind, payload) => ipcRenderer.invoke('jobs:start', { kind, payload }),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  getJobLog: (id) => ipcRenderer.invoke('jobs:log', id),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  onJobUpdate: (callback) => subscribe('job:update', callback),
  onJobLog: (callback) => subscribe('job:log', callback),

  openPath: (targetPath) => ipcRenderer.invoke('path:open', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('path:reveal', targetPath),
  openFolder: (targetPath) => ipcRenderer.invoke('path:openFolder', targetPath),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openWorkspace: () => ipcRenderer.invoke('app:openWorkspace'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),

  startService: (name) => ipcRenderer.invoke('services:start', name),
  stopService: (name) => ipcRenderer.invoke('services:stop', name),
  listServices: () => ipcRenderer.invoke('services:list'),
  getServiceLog: (name) => ipcRenderer.invoke('services:log', name),
  onServiceUpdate: (callback) => subscribe('service:update', callback),
  onConfigUpdate: (callback) => subscribe('config:update', callback)
});
