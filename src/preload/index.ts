import { contextBridge, ipcRenderer } from 'electron';
import type {
  AskResult,
  Nudge,
  QuestionAnswer,
  Settings,
  SessionState,
  SkymarkApi,
  StartSessionArgs,
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
    ask: (question: string): Promise<AskResult> => ipcRenderer.invoke('session:ask', question),
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
    onNudge: (cb: (n: Nudge) => void) => {
      const handler = (_e: unknown, n: Nudge) => cb(n);
      ipcRenderer.on('session:nudge', handler);
      return () => ipcRenderer.removeListener('session:nudge', handler);
    },
    onAnswer: (cb: (a: QuestionAnswer) => void) => {
      const handler = (_e: unknown, a: QuestionAnswer) => cb(a);
      ipcRenderer.on('session:answer', handler);
      return () => ipcRenderer.removeListener('session:answer', handler);
    },
  },
};

contextBridge.exposeInMainWorld('skymark', api);
