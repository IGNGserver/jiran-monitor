import rawSpec from '../../../design/tokens.json';

export type ModelId = 'hero' | 'mix' | 'quota' | 'hub';

export interface CameraSpec {
  distance: number;
  elevation: number;
  azimuth: number;
  fov: number;
  target: [number, number, number];
}

export interface HeroStackSpec {
  id: string;
  x: number;
  z: number;
  count: number;
  w: number;
  d: number;
  h: number;
  mat: string;
}

export interface HubRouteSpec {
  from: [number, number, number];
  mid: [number, number, number];
  to: [number, number, number];
  tone: 'cyan' | 'brass';
}

export interface TokensSpec {
  palette: {
    void: string;
    baseDark: string;
    frameMetal: string;
    rawSlate: string;
    platinum: string;
    cyan: string;
    cyanDeep: string;
    brass: string;
    amber: string;
  };
  models: {
    hero: {
      file: string;
      camera: CameraSpec;
      streamLanesZ: number[];
      gateX: number;
      streamSpan: [number, number];
      stacks: HeroStackSpec[];
    };
    mix: {
      file: string;
      camera: CameraSpec;
      segments: { id: string; w: number; mat: string; layers: number }[];
      columns: { x: number; tokens: number; costH: number }[];
    };
    quota: {
      file: string;
      camera: CameraSpec;
      dialCenter: [number, number, number];
      creditsCenter: [number, number, number];
    };
    hub: {
      file: string;
      camera: CameraSpec;
      hubPos: [number, number, number];
      routes: HubRouteSpec[];
    };
  };
}

export const SPEC = rawSpec as unknown as TokensSpec;
