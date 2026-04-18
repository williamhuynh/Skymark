import { contextBridge, ipcRenderer } from 'electron';

export type Settings = {
  mcUrl: string;
  defaultSpecialist: 'naa-project' | 'aid-coo' | 'none';
  autoDetect: boolean;
};

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:set', patch),
  },
  deepgramKey: {
    set: (key: string): Promise<boolean> => ipcRenderer.invoke('deepgram-key:set', key),
    has: (): Promise<boolean> => ipcRenderer.invoke('deepgram-key:has'),
    clear: (): Promise<boolean> => ipcRenderer.invoke('deepgram-key:clear'),
  },
};

contextBridge.exposeInMainWorld('skymark', api);

export type SkymarkApi = typeof api;
