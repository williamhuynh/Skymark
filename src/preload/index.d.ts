import type { SkymarkApi } from '../shared/types';

declare global {
  interface Window {
    skymark: SkymarkApi;
  }
}

export {};
