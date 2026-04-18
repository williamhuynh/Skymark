import { contextBridge, ipcRenderer } from 'electron';
import type { Settings, SkymarkApi } from '../shared/types';

const api: SkymarkApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  },
  deepgramKey: {
    set: (key: string) => ipcRenderer.invoke('deepgram-key:set', key),
    has: () => ipcRenderer.invoke('deepgram-key:has'),
    clear: () => ipcRenderer.invoke('deepgram-key:clear'),
  },
};

contextBridge.exposeInMainWorld('skymark', api);
