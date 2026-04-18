import type { SkymarkApi } from './index';

declare global {
  interface Window {
    skymark: SkymarkApi;
  }
}

export {};
