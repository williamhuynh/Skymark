export type Specialist = 'naa-project' | 'aid-coo' | 'none';

export type Settings = {
  mcUrl: string;
  defaultSpecialist: Specialist;
  autoDetect: boolean;
};

export type SkymarkApi = {
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
  };
  deepgramKey: {
    set: (key: string) => Promise<boolean>;
    has: () => Promise<boolean>;
    clear: () => Promise<boolean>;
  };
};
