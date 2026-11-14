/**
 * 读取 design/meter.json（Blender 与站点 Three.js 舞台共用的唯一几何与色板定义），
 * 并提供组装态 / 爆炸态层高换算工具。
 * Blender 采用 Z 向上，导出 glTF 后为 Three.js 的 Y 向上：(x, y, z)_blender -> (x, z, -y)_three。
 */
import raw from '../../../design/meter.json';

export interface WaveComponent {
  dir: [number, number];
  k: number;
  amp: number;
  speed: number;
  phase: number;
}

export interface FleetCluster {
  id: string;
  label: string;
  /** [x, y, health]：Blender 平面坐标与健康态（1 = 在线冰青 cyan，0.45 = >10m 离线置灰/香槟暗金） */
  nodes: [number, number, number][];
}

export interface CameraPose {
  distance: number;
  elevation: number;
  azimuth: number;
  lens: number;
  target: [number, number, number];
  shiftX?: number;
}

export interface MeterLayerSpec {
  id: 'ingest' | 'prism' | 'drum' | 'credits' | 'quota';
  code: string;
  labelZh: string;
  labelEn: string;
  h: number;
}

export interface Spec {
  palette: Record<
    'void' | 'graphite' | 'anodized' | 'steel' | 'platinum' | 'cyan' | 'brass' | 'copper' | 'danger',
    string
  >;
  radius: number;
  seam: number;
  explode: number;
  layers: MeterLayerSpec[];
  clusters: FleetCluster[];
  waves: {
    size: number;
    res: number;
    z: number;
    components: WaveComponent[];
    ripple: { amp: number; k: number; speed: number; decay: number };
  };
  camera: Record<'hero' | 'explode', CameraPose>;
}

export const SPEC = raw as unknown as Spec;

/** 组装态下每层底面的高度（Three.js Y 轴，自下而上 0..4）。 */
export function layerBases(): number[] {
  const out: number[] = [];
  let y = 0;
  for (const l of SPEC.layers) {
    out.push(y);
    y += l.h + SPEC.seam;
  }
  return out;
}

/** 爆炸系数 f (0..1) 下第 i 层（自下而上）的底面高度。 */
export function layerY(i: number, f: number): number {
  return layerBases()[i]! + i * SPEC.explode * f;
}

/** 爆炸系数 f 下第 i 层的垂直几何中心高度。 */
export function layerCenter(i: number, f: number): number {
  return layerY(i, f) + SPEC.layers[i]!.h / 2;
}

export const STACK_HEIGHT = layerBases().at(-1)! + SPEC.layers.at(-1)!.h;
