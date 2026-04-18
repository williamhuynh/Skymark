import { contextBridge, ipcRenderer } from 'electron';
import type {
  Settings,
  SessionState,
  StartSessionArgs,
  SkymarkApi,
  TranscriptEvent,
} from '../shared/types';

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
  session: {
    start: (args: StartSessionArgs) => ipcRenderer.invoke('session:start', args),
    stop: () => ipcRenderer.invoke('session:stop'),
    sendAudio: (chunk: ArrayBuffer) => ipcRenderer.send('session:audio', chunk),
    getState: () => ipcRenderer.invoke('session:get-state'),
    onState: (cb: (state: SessionState) => void) => {
      const handler = (_e: unknown, state: SessionState) => cb(state);
      ipcRenderer.on('session:state', handler);
      return () => ipcRenderer.removeListener('session:state', handler);
    },
    onTranscript: (cb: (ev: TranscriptEvent) => void) => {
      const handler = (_e: unknown, ev: TranscriptEvent) => cb(ev);
      ipcRenderer.on('session:transcript', handler);
      return () => ipcRenderer.removeListener('session:transcript', handler);
    },
  },
};

contextBridge.exposeInMainWorld('skymark', api);
