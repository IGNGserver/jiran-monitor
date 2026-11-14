/**
 * 首屏「计算遥测核心（Computational Telemetry Conduit & Precision Gauge Core）」实时 WebGL2 场景。
 * 站点静帧母版同样由本场景确定性渲染（design/tools/stills.mjs），确保静帧与实时画面 100% 同源。
 *
 * 视觉结构与产品事实一一对应：
 * 1. 中央「开口双计量环 + 原点信号球 + 测地球面经纬核」与计然应用图标（assets/icon.png）几何同构；
 * 2. 外圈精密游标盘精确排布 59 枚径向刻线，59 条三维光纤流道将各方工具的激光脉冲汇聚入本地采集核；
 * 3. 实心高光脉冲代表上游精确 Token，半透明脉冲代表按内容推算的本地适配数据；
 * 4. 右侧中段独立三环琥珀色立柱计量仪专收原生 Credits，绝不并入主计量核（准则 02：积分与 Token 严格分账）。
 *
 * 所有粒子矩阵均为 f(seed, time) 纯函数，同一时刻 t 在任意机器上渲染结果完全一致。
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  PointLight,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from 'three';
import paletteSpec from '../../../design/palette.json';
import { arcFragment, arcVertex, coreFragment, coreVertex, gridFragment, gridVertex } from './shaders';

export type HeroView = 'wide' | 'tall' | 'macro';

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface HeroOptions {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  tools: string[];
  onFocus?: (info: ScreenPoint & { index: number }) => void;
  onReading?: (pt: ScreenPoint) => void;
  onCredits?: (pt: ScreenPoint) => void;
  onCount?: (tokens: number) => void;
  onReady?: () => void;
  still?: { view: HeroView; time: number; width: number; height: number };
}

const P = paletteSpec.palette;
const SOURCE_COUNT = 59;
const USAGE_COUNT = 52;
const PACKETS_CAP = 260;

/** 确定性无状态哈希 [0, 1) */
function hash(a: number, b: number): number {
  let x = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

interface Conduit {
  index: number;
  curve: CatmullRomCurve3;
  interval: number;
  duration: number;
  phase: number;
  estimated: boolean;
  tone: 'cyan' | 'violet' | 'teal' | 'cobalt';
}

interface Tier {
  dpr: number;
  fps: number;
  filaments: number;
  gridSegments: number;
}

function detectTier(gl: WebGLRenderingContext | WebGL2RenderingContext, forcedStill: boolean): Tier {
  if (forcedStill) return { dpr: 1, fps: 60, filaments: SOURCE_COUNT, gridSegments: 88 };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const isSoftware = /swiftshader|llvmpipe|software|basic render/i.test(rendererName);
  if (isSoftware) {
    return { dpr: 1, fps: 18, filaments: 28, gridSegments: 32 };
  }
  return { dpr: Math.min(window.devicePixelRatio || 1, 2), fps: 60, filaments: SOURCE_COUNT, gridSegments: 88 };
}

export function startHero(opts: HeroOptions) {
  const { canvas, host, still } = opts;
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: !!still,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(P.bg), 1);

  const tier = detectTier(renderer.getContext(), !!still);
  let dpr = tier.dpr;

  const scene = new Scene();
  scene.fog = new FogExp2(P.bg, 0.046);

  const camera = new PerspectiveCamera(36, 16 / 9, 0.1, 80);

  // 精密冷色布光（不使用 RoomEnvironment 棚灯贴图，杜绝球面灰色塑料反光斑）
  const hemi = new HemisphereLight('#bae6fd', '#050b18', 1.05);
  const keyLight = new DirectionalLight('#e0f2fe', 2.1);
  keyLight.position.set(4.2, 6.8, 5.2);
  const rimLight = new DirectionalLight('#3b82f6', 1.75);
  rimLight.position.set(-5.2, 2.4, -3.8);
  const coreLight = new PointLight('#38bdf8', 4.2, 9.5, 1.6);
  coreLight.position.set(0, 0.52, 0);
  scene.add(hemi, keyLight, rimLight, coreLight);

  // 舞台根组
  const rig = new Group();
  scene.add(rig);

  // 1. 底部空间遥测坐标网格（自定义 GLSL）
  const gridUniforms = {
    uTime: { value: 0 },
    uBg: { value: new Color(P.bg) },
    uCyan: { value: new Color(P.cyan) },
    uCobalt: { value: new Color(P.cobalt) },
  };
  const gridMat = new ShaderMaterial({
    vertexShader: gridVertex,
    fragmentShader: gridFragment,
    uniforms: gridUniforms,
    transparent: true,
    depthWrite: false,
  });
  const gridMesh = new Mesh(new PlaneGeometry(30, 30, tier.gridSegments, tier.gridSegments), gridMat);
  gridMesh.rotation.x = -Math.PI / 2;
  gridMesh.position.y = -1.72;
  scene.add(gridMesh);

  // 2. 中央「计然开口计量环 + 球面经纬光学核 + 测地线框笼」组件
  const coreCenter = new Vector3(0, 0.5, 0);
  const coreGroup = new Group();
  coreGroup.position.copy(coreCenter);
  rig.add(coreGroup);

  // 中央程序化经纬流场球核
  const coreUniforms = {
    uTime: { value: 0 },
    uDeep: { value: new Color('#040a1a') },
    uCobalt: { value: new Color('#0a84ff') },
    uCyan: { value: new Color('#38bdf8') },
    uViolet: { value: new Color('#818cf8') },
  };
  const coreMat = new ShaderMaterial({
    vertexShader: coreVertex,
    fragmentShader: coreFragment,
    uniforms: coreUniforms,
    transparent: true,
  });
  const innerSphere = new Mesh(new SphereGeometry(0.74, 56, 40), coreMat);
  coreGroup.add(innerSphere);

  // 外层测地多面体精密线框笼（替代混浊玻璃球，营造通透锐利的计算仪器质感）
  const geoWire = new WireframeGeometry(new IcosahedronGeometry(0.94, 2));
  const latticeCage = new LineSegments(
    geoWire,
    new LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.19,
      blending: AdditiveBlending,
    }),
  );
  coreGroup.add(latticeCage);

  // 正交双星盘细环（Astrolabe Rings）
  const astrolabeGroup = new Group();
  coreGroup.add(astrolabeGroup);
  const fineRingMat = new MeshBasicMaterial({
    color: '#7dd3fc',
    transparent: true,
    opacity: 0.36,
    blending: AdditiveBlending,
  });
  const eqRing = new Mesh(new TorusGeometry(1.08, 0.0055, 10, 112), fineRingMat);
  eqRing.rotation.x = Math.PI * 0.42;
  const merRing = new Mesh(new TorusGeometry(1.08, 0.0055, 10, 112), fineRingMat);
  merRing.rotation.y = Math.PI * 0.38;
  merRing.rotation.x = -0.25;
  astrolabeGroup.add(eqRing, merRing);

  // 与产品图标（assets/icon.png）几何同构的开口双圆弧 + 左下发光原点球
  const arcGroup = new Group();
  arcGroup.rotation.x = 0.2;
  arcGroup.rotation.y = -0.26;
  coreGroup.add(arcGroup);

  const rightArcMat = new ShaderMaterial({
    vertexShader: arcVertex,
    fragmentShader: arcFragment,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new Color('#7dd3fc') },
      uColorB: { value: new Color('#0a84ff') },
      uPhase: { value: 0.0 },
    },
    transparent: true,
  });
  const leftArcMat = new ShaderMaterial({
    vertexShader: arcVertex,
    fragmentShader: arcFragment,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new Color('#38bdf8') },
      uColorB: { value: new Color('#2563eb') },
      uPhase: { value: 0.5 },
    },
    transparent: true,
  });

  // 底层暗钛金属导轨环，衬托发光圆弧厚度
  const darkTitanium = new MeshStandardMaterial({
    color: '#0d182e',
    emissive: '#081226',
    emissiveIntensity: 0.4,
    metalness: 0.78,
    roughness: 0.3,
  });
  const backingTrack = new Mesh(new TorusGeometry(1.42, 0.016, 12, 112), darkTitanium);
  arcGroup.add(backingTrack);

  const rightArc = new Mesh(new TorusGeometry(1.42, 0.048, 22, 80, Math.PI * 0.96), rightArcMat);
  rightArc.rotation.z = -Math.PI * 0.47;
  arcGroup.add(rightArc);

  const leftArc = new Mesh(new TorusGeometry(1.42, 0.048, 22, 68, Math.PI * 0.72), leftArcMat);
  leftArc.rotation.z = Math.PI * 0.55;
  arcGroup.add(leftArc);

  // 左下发光原点信号球 + 光晕壳
  const originOrbAngle = Math.PI * 1.33;
  const orbPos = new Vector3(Math.cos(originOrbAngle) * 1.42, Math.sin(originOrbAngle) * 1.42, 0);
  const originOrb = new Mesh(
    new SphereGeometry(0.115, 24, 20),
    new MeshBasicMaterial({ color: '#bae6fd' }),
  );
  originOrb.position.copy(orbPos);
  const originHalo = new Mesh(
    new SphereGeometry(0.19, 20, 16),
    new MeshBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.28,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  originHalo.position.copy(orbPos);
  arcGroup.add(originOrb, originHalo);

  // 内层「26 项多窗口订阅配额环」（5h 滚动窗 + 周限额双弧示意）
  const quotaRingGroup = new Group();
  quotaRingGroup.rotation.set(-0.34, 0.22, 0.15);
  coreGroup.add(quotaRingGroup);
  const quotaArc5h = new Mesh(
    new TorusGeometry(1.22, 0.015, 12, 72, Math.PI * 1.18),
    new MeshBasicMaterial({ color: '#a78bfa', transparent: true, opacity: 0.72 }),
  );
  const quotaArcWeek = new Mesh(
    new TorusGeometry(1.22, 0.015, 12, 54, Math.PI * 0.56),
    new MeshBasicMaterial({ color: '#34d399', transparent: true, opacity: 0.76 }),
  );
  quotaArcWeek.rotation.z = Math.PI * 1.32;
  quotaRingGroup.add(quotaArc5h, quotaArcWeek);

  // 外层深色钛金属游标盘 + 59 枚来源刻度针
  const vernierGroup = new Group();
  vernierGroup.rotation.x = 1.06;
  vernierGroup.rotation.z = -0.22;
  coreGroup.add(vernierGroup);

  const bezelRing = new Mesh(new TorusGeometry(1.88, 0.018, 14, 120), darkTitanium);
  vernierGroup.add(bezelRing);

  const tickGeo = new BoxGeometry(0.02, 0.125, 0.012);
  const tickMat = new MeshBasicMaterial({ color: '#ffffff' });
  const ticks = new InstancedMesh(tickGeo, tickMat, SOURCE_COUNT);
  const tmpM = new Matrix4();
  const tmpQ = new Quaternion();
  const tmpP = new Vector3();
  const tmpS = new Vector3();
  const cCyan = new Color(P.cyan);
  const cViolet = new Color(P.violet);
  const cEmerald = new Color(P.emerald);

  for (let i = 0; i < SOURCE_COUNT; i++) {
    const a = (i / SOURCE_COUNT) * Math.PI * 2;
    const isSession = i < 4 || i === 25;
    const isQuotaOnly = i >= USAGE_COUNT;
    const r = 1.88 + (isSession ? 0.085 : 0.048);
    tmpP.set(Math.cos(a) * r, Math.sin(a) * r, 0);
    tmpQ.setFromAxisAngle(new Vector3(0, 0, 1), a - Math.PI / 2);
    tmpS.set(1, isSession ? 1.55 : isQuotaOnly ? 1.2 : 0.88, 1);
    tmpM.compose(tmpP, tmpQ, tmpS);
    ticks.setMatrixAt(i, tmpM);
    ticks.setColorAt(i, isSession ? cEmerald : isQuotaOnly ? cViolet : cCyan);
  }
  ticks.instanceMatrix.needsUpdate = true;
  if (ticks.instanceColor) ticks.instanceColor.needsUpdate = true;
  vernierGroup.add(ticks);

  // 外围斜交陀螺仪细环
  const gyroRing = new Mesh(
    new TorusGeometry(2.22, 0.009, 10, 108, Math.PI * 1.65),
    new MeshBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.3,
      blending: AdditiveBlending,
    }),
  );
  gyroRing.rotation.set(-0.58, 0.46, 0.28);
  coreGroup.add(gyroRing);

  // 3. 下方 14 日量化柱阵（呼应总览页 14 天趋势柱）
  const barsGroup = new Group();
  barsGroup.position.set(0, -1.66, 0);
  rig.add(barsGroup);
  const barGeo = new CylinderGeometry(0.032, 0.032, 1, 12);
  const barMat = new MeshStandardMaterial({
    color: '#1e3a8a',
    emissive: '#0ea5e9',
    emissiveIntensity: 0.55,
    roughness: 0.25,
    metalness: 0.45,
    transparent: true,
    opacity: 0.68,
  });
  const barMeshes: Mesh[] = [];
  for (let i = 0; i < 14; i++) {
    const bm = new Mesh(barGeo, barMat);
    const angle = ((i - 6.5) / 14) * 1.42;
    bm.position.set(Math.sin(angle) * 1.42, 0.18, Math.cos(angle) * 0.52 - 0.35);
    barsGroup.add(bm);
    barMeshes.push(bm);
  }

  // 4. 右侧中段独立「原生 Credits 三环晶柱计量仪」（高于底部统计卡，绝不混入主 Token 核）
  const creditsCenter = new Vector3(2.18, 0.14, 0.34);
  const creditsGroup = new Group();
  creditsGroup.position.copy(creditsCenter);
  rig.add(creditsGroup);

  const amberMat = new MeshBasicMaterial({
    color: P.amber,
    transparent: true,
    opacity: 0.88,
  });
  const amberSoftMat = new MeshBasicMaterial({
    color: '#f59e0b',
    transparent: true,
    opacity: 0.42,
    blending: AdditiveBlending,
  });

  // 三层水平精密刻度环 + 中央八面体晶核 + 垂直轴杆
  const creditsRings: Mesh[] = [];
  [-0.17, 0, 0.17].forEach((yy, idx) => {
    const r = idx === 1 ? 0.28 : 0.21;
    const ring = new Mesh(new TorusGeometry(r, 0.012, 12, 48, Math.PI * 1.7), idx === 1 ? amberMat : amberSoftMat);
    ring.rotation.x = Math.PI * 0.46;
    ring.position.y = yy;
    creditsGroup.add(ring);
    creditsRings.push(ring);
  });

  const creditsCrystal = new Mesh(
    new OctahedronGeometry(0.115, 0),
    new MeshBasicMaterial({ color: '#fde68a' }),
  );
  const creditsCage = new LineSegments(
    new WireframeGeometry(new OctahedronGeometry(0.175, 0)),
    new LineBasicMaterial({ color: P.amber, transparent: true, opacity: 0.65 }),
  );
  const creditsAxis = new Mesh(
    new CylinderGeometry(0.006, 0.006, 0.52, 8),
    amberSoftMat,
  );
  creditsGroup.add(creditsCrystal, creditsCage, creditsAxis);

  // Credits 独立双流道曲线（来自外围独立积分工具，绝不进入主核心）
  const creditsCurves = [
    new CatmullRomCurve3([
      new Vector3(4.45, 1.48, -0.55),
      new Vector3(3.42, 0.85, 0.08),
      new Vector3(2.68, 0.42, 0.28),
      creditsCenter.clone(),
    ]),
    new CatmullRomCurve3([
      new Vector3(4.25, -0.45, -0.35),
      new Vector3(3.32, -0.18, 0.12),
      new Vector3(2.65, 0.02, 0.3),
      creditsCenter.clone(),
    ]),
  ];
  for (const cc of creditsCurves) {
    rig.add(
      new Mesh(
        new TubeGeometry(cc, 28, 0.0055, 6, false),
        new MeshBasicMaterial({
          color: P.amber,
          transparent: true,
          opacity: 0.28,
          blending: AdditiveBlending,
        }),
      ),
    );
  }

  // 5. 59 条来源三维光纤流道（Catmull-Rom 样条）+ 外围 59 枚来源星点锚
  const conduits: Conduit[] = [];
  const lineMatExact = new LineBasicMaterial({
    color: '#38bdf8',
    transparent: true,
    opacity: 0.19,
    blending: AdditiveBlending,
  });
  const lineMatQuota = new LineBasicMaterial({
    color: '#818cf8',
    transparent: true,
    opacity: 0.16,
    blending: AdditiveBlending,
  });

  const tones: Conduit['tone'][] = ['cyan', 'teal', 'violet', 'cobalt'];
  const sourcePositions: number[] = [];
  const sourceColors: number[] = [];

  for (let i = 0; i < SOURCE_COUNT; i++) {
    const golden = i * 2.39996323;
    const band = (i / (SOURCE_COUNT - 1)) * 2 - 1;
    const radius = 4.15 + hash(i, 11) * 1.85;
    const sx = Math.cos(golden) * radius * 1.12;
    const sy = band * 2.3 + (hash(i, 23) - 0.5) * 0.42 + 0.45;
    const sz = Math.sin(golden) * radius * 0.78 - 0.55;

    const start = new Vector3(sx, sy, sz);
    sourcePositions.push(sx, sy, sz);
    const sc = i < 4 || i === 25 ? cEmerald : i >= USAGE_COUNT ? cViolet : cCyan;
    sourceColors.push(sc.r, sc.g, sc.b);

    const mid1 = start.clone().lerp(coreCenter, 0.38);
    mid1.y += (hash(i, 37) - 0.42) * 0.85;
    mid1.z += Math.cos(golden) * 0.52;

    const entryAngle = (i / SOURCE_COUNT) * Math.PI * 2;
    const mid2 = new Vector3(
      coreCenter.x + Math.cos(entryAngle) * 1.52,
      coreCenter.y + Math.sin(entryAngle) * 0.82,
      coreCenter.z + Math.sin(entryAngle * 2) * 0.52,
    );

    const curve = new CatmullRomCurve3([start, mid1, mid2, coreCenter.clone()]);
    const estimated = i === 22 || i === 24;
    conduits.push({
      index: i,
      curve,
      interval: 1.5 + hash(i, 53) * 1.4,
      duration: 1.85 + hash(i, 71) * 0.9,
      phase: hash(i, 97),
      estimated,
      tone: tones[i % tones.length],
    });

    if (i < tier.filaments) {
      const pts = curve.getPoints(36);
      const geo = new BufferGeometry().setFromPoints(pts);
      rig.add(new Line(geo, i >= USAGE_COUNT ? lineMatQuota : lineMatExact));
    }
  }

  const anchorGeo = new BufferGeometry();
  anchorGeo.setAttribute('position', new Float32BufferAttribute(sourcePositions, 3));
  anchorGeo.setAttribute('color', new Float32BufferAttribute(sourceColors, 3));
  const anchorPoints = new Points(
    anchorGeo,
    new PointsMaterial({
      size: 0.065,
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  rig.add(anchorPoints);

  // 6. 实例化纤细激光脉冲（实心精确 Token 脉冲 + 半透明推算脉冲 + 琥珀色积分脉冲）
  const packetGeo = new SphereGeometry(1, 12, 8);
  const solidPacketMat = new MeshBasicMaterial({ color: '#ffffff' });
  const ghostPacketMat = new MeshBasicMaterial({
    color: P.cyan,
    transparent: true,
    opacity: 0.45,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const solidPackets = new InstancedMesh(packetGeo, solidPacketMat, PACKETS_CAP);
  const ghostPackets = new InstancedMesh(packetGeo, ghostPacketMat, 64);
  solidPackets.frustumCulled = false;
  ghostPackets.frustumCulled = false;
  rig.add(solidPackets, ghostPackets);

  const toneColors: Record<Conduit['tone'], Color> = {
    cyan: new Color('#7dd3fc'),
    teal: new Color('#5eead4'),
    violet: new Color('#c4b5fd'),
    cobalt: new Color('#60a5fa'),
  };
  const cAmber = new Color('#fcd34d');
  const cWhite = new Color('#ffffff');

  let focusK = 0;
  let focusN = 0;
  let focusStart = 0;
  let focusEnd = -1;
  let lastPicked = 0;
  let focusLive = false;
  const focusWorld = new Vector3();

  const pickFocus = (time: number) => {
    let best: { k: number; n: number; land: number } | null = null;
    for (let step = 1; step <= 15; step++) {
      const k = (lastPicked + step * 5) % SOURCE_COUNT;
      const c = conduits[k];
      const n = Math.ceil((time + 1.15 - c.duration) / c.interval - c.phase);
      const land = (n + c.phase) * c.interval + c.duration;
      if (!best || land < best.land) best = { k, n, land };
    }
    focusK = best!.k;
    focusN = best!.n;
    focusEnd = best!.land;
    focusStart = Math.max(time, focusEnd - conduits[focusK].duration);
    lastPicked = focusK;
  };

  const pt = new Vector3();
  const tangent = new Vector3();
  const upAxis = new Vector3(0, 1, 0);

  const updateSceneAt = (time: number) => {
    gridUniforms.uTime.value = time;
    coreUniforms.uTime.value = time;
    rightArcMat.uniforms.uTime.value = time;
    leftArcMat.uniforms.uTime.value = time;

    // 多层精密反相运动
    latticeCage.rotation.y = time * 0.09;
    latticeCage.rotation.x = -time * 0.055;
    astrolabeGroup.rotation.z = time * 0.11;
    astrolabeGroup.rotation.y = -time * 0.07;

    arcGroup.rotation.z = Math.sin(time * 0.26) * 0.12;
    arcGroup.rotation.y = -0.26 + Math.cos(time * 0.2) * 0.14;
    quotaRingGroup.rotation.z = 0.15 - time * 0.16;
    vernierGroup.rotation.z = -0.22 + time * 0.08;
    gyroRing.rotation.z = 0.28 - time * 0.13;

    creditsCrystal.rotation.y = time * 0.55;
    creditsCage.rotation.y = -time * 0.32;
    creditsRings.forEach((r, idx) => {
      r.rotation.z = time * (idx === 1 ? -0.42 : 0.34);
    });

    for (let i = 0; i < barMeshes.length; i++) {
      const h = 0.22 + 0.38 * (0.5 + 0.5 * Math.sin(time * 1.1 + i * 0.55));
      barMeshes[i].scale.set(1, h, 1);
      barMeshes[i].position.y = h * 0.5;
    }

    let ns = 0;
    let ng = 0;
    focusLive = false;

    for (const c of conduits) {
      const nMax = Math.floor(time / c.interval - c.phase);
      const nMin = Math.ceil((time - c.duration) / c.interval - c.phase);
      for (let n = nMin; n <= nMax; n++) {
        const u = (time - (n + c.phase) * c.interval) / c.duration;
        if (u <= 0 || u >= 1) continue;
        const eased = u * u * (3 - 2 * u);
        c.curve.getPointAt(eased, pt);
        c.curve.getTangentAt(eased, tangent);
        tmpQ.setFromUnitVectors(upAxis, tangent.normalize());

        // 纤细高速激光脉冲比例，告别粗胖胶囊感
        const fadeScale = Math.sin(u * Math.PI);
        const radius = 0.014 + 0.008 * fadeScale;
        const stretch = 3.8 + 3.4 * fadeScale;
        tmpS.set(radius, radius * stretch, radius);
        tmpM.compose(pt, tmpQ, tmpS);

        const isFocus = c.index === focusK && n === focusN;
        if (isFocus) {
          focusWorld.copy(pt);
          rig.localToWorld(focusWorld);
          focusLive = true;
        }

        if (c.estimated) {
          if (ng < 64) ghostPackets.setMatrixAt(ng++, tmpM);
        } else if (ns < PACKETS_CAP) {
          solidPackets.setMatrixAt(ns, tmpM);
          solidPackets.setColorAt(ns, isFocus ? cWhite : toneColors[c.tone]);
          ns++;
        }
      }
    }

    // 独立 Credits 双通道琥珀色脉冲
    const creditInterval = 1.45;
    const creditDuration = 1.6;
    for (let ci = 0; ci < creditsCurves.length; ci++) {
      const cc = creditsCurves[ci];
      const phase = ci * 0.48;
      const cnMax = Math.floor(time / creditInterval - phase);
      const cnMin = Math.ceil((time - creditDuration) / creditInterval - phase);
      for (let n = cnMin; n <= cnMax; n++) {
        const u = (time - (n + phase) * creditInterval) / creditDuration;
        if (u <= 0 || u >= 1 || ns >= PACKETS_CAP) continue;
        cc.getPointAt(u, pt);
        cc.getTangentAt(u, tangent);
        tmpQ.setFromUnitVectors(upAxis, tangent.normalize());
        const fadeScale = Math.sin(u * Math.PI);
        const r = 0.016 + 0.007 * fadeScale;
        tmpS.set(r, r * 4.2, r);
        tmpM.compose(pt, tmpQ, tmpS);
        solidPackets.setMatrixAt(ns, tmpM);
        solidPackets.setColorAt(ns, cAmber);
        ns++;
      }
    }

    solidPackets.count = ns;
    ghostPackets.count = ng;
    solidPackets.instanceMatrix.needsUpdate = true;
    if (solidPackets.instanceColor) solidPackets.instanceColor.needsUpdate = true;
    ghostPackets.instanceMatrix.needsUpdate = true;
  };

  /** 根据视口比例与机位放置相机：宽屏将核心置于右上方开阔舞台，给左侧标题与底部统计卡留足净空 */
  const placeCamera = (viewMode: HeroView | 'auto', time: number, scrollP: number, px: number, py: number) => {
    const aspect = camera.aspect;
    const mode: HeroView =
      viewMode === 'auto' ? (aspect < 1.02 ? 'tall' : 'wide') : viewMode;

    if (mode === 'macro') {
      camera.fov = 30;
      camera.position.set(0.62, 0.72, 3.85);
      rig.position.set(0.15, -0.05, 0);
      camera.lookAt(0.15, 0.42, 0);
    } else if (mode === 'tall') {
      camera.fov = 44;
      const swayX = Math.sin(time * 0.18) * 0.14 + px * 0.22;
      const swayY = Math.cos(time * 0.15) * 0.1 - py * 0.16;
      rig.position.set(0, 0.48 - scrollP * 0.4, 0);
      camera.position.set(swayX, 0.92 + swayY + scrollP * 0.55, 7.6);
      camera.lookAt(0, 0.32, 0);
    } else {
      camera.fov = 35;
      const offsetX = MathUtils.clamp((aspect - 1.0) * 1.55, 0.9, 1.98);
      rig.position.set(offsetX, 0.16 - scrollP * 0.35, 0);
      const swayX = Math.sin(time * 0.18) * 0.18 + px * 0.32;
      const swayY = Math.cos(time * 0.14) * 0.12 - py * 0.22;
      camera.position.set(swayX * 0.6, 0.8 + swayY + scrollP * 0.65, 6.85 + scrollP * 0.6);
      camera.lookAt(offsetX * 0.52, 0.28, 0);
    }
    camera.updateProjectionMatrix();
  };

  const scratch = new Vector3();
  const project = (world: Vector3, margin = 48): ScreenPoint => {
    scratch.copy(world).project(camera);
    const w = host.clientWidth;
    const h = host.clientHeight;
    const x = (scratch.x * 0.5 + 0.5) * w;
    const y = (-scratch.y * 0.5 + 0.5) * h;
    const visible =
      scratch.z > -1 &&
      scratch.z < 1 &&
      x > margin &&
      x < w - margin &&
      y > margin &&
      y < h - margin;
    return { x, y, visible };
  };

  // 静帧母版渲染分支（design/tools/stills.mjs）
  if (still) {
    renderer.setPixelRatio(1);
    renderer.setSize(still.width, still.height, false);
    camera.aspect = still.width / still.height;
    pickFocus(still.time);
    updateSceneAt(still.time);
    placeCamera(still.view, still.time, 0, 0, 0);
    renderer.render(scene, camera);
    return {
      draw: () => renderer.render(scene, camera),
      dispose: () => {
        renderer.dispose();
      },
    };
  }

  // 实时交互模式
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  let px = 0;
  let py = 0;
  let tx = 0;
  let ty = 0;
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    tx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    ty = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let scrollP = 0;
  const onScroll = () => {
    scrollP = MathUtils.clamp(window.scrollY / Math.max(1, host.clientHeight), 0, 1.2);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  let visible = document.visibilityState === 'visible';
  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
  };
  document.addEventListener('visibilitychange', onVisibility);

  let running = true;
  const t0 = performance.now();
  const OFFSET = 41.3;
  let prev = t0;
  let baseTokens = 18_420_600;
  let shownTokens = baseTokens;
  let ready = false;
  const frameSamples: number[] = [];
  let degraded = false;

  const coreReadingAnchor = new Vector3();
  const creditsAnchor = new Vector3();

  const tick = (now: number) => {
    if (!running) return;
    requestAnimationFrame(tick);
    if (!visible || scrollP >= 0.85) {
      prev = now;
      return;
    }
    if (tier.fps < 60 && now - prev < 1000 / tier.fps - 2) return;

    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    const time = OFFSET + (now - t0) / 1000;

    if (!degraded && frameSamples.length < 80) {
      frameSamples.push(dt);
      if (frameSamples.length === 80) {
        const avg = frameSamples.slice(16).reduce((a, b) => a + b, 0) / 64;
        if (avg > 0.028 && dpr > 1) {
          degraded = true;
          dpr = 1;
          resize();
        }
      }
    }

    px = MathUtils.damp(px, tx, 2.4, dt);
    py = MathUtils.damp(py, ty, 2.4, dt);

    if (time > focusEnd) pickFocus(time);
    updateSceneAt(time);
    placeCamera('auto', time, scrollP, px, py);

    baseTokens += dt * 1480;
    shownTokens = MathUtils.damp(shownTokens, baseTokens, 6, dt);

    renderer.render(scene, camera);

    opts.onCount?.(shownTokens);

    const calm = scrollP < 0.28;
    if (opts.onFocus) {
      const fp = project(focusWorld, 80);
      const age = time - focusStart;
      opts.onFocus({
        index: focusK,
        x: fp.x,
        y: fp.y,
        visible: calm && focusLive && fp.visible && age > 0.18 && focusEnd - time > 0.15,
      });
    }
    if (opts.onReading) {
      coreReadingAnchor.set(coreCenter.x + 1.46, coreCenter.y + 0.86, coreCenter.z);
      rig.localToWorld(coreReadingAnchor);
      const rp = project(coreReadingAnchor, 44);
      opts.onReading({ ...rp, visible: rp.visible && calm });
    }
    if (opts.onCredits) {
      creditsAnchor.copy(creditsCenter).add(new Vector3(0.28, -0.02, 0));
      rig.localToWorld(creditsAnchor);
      const cp = project(creditsAnchor, 56);
      opts.onCredits({ ...cp, visible: cp.visible && calm });
    }

    if (!ready) {
      ready = true;
      opts.onReady?.();
    }
  };

  requestAnimationFrame(tick);

  return {
    draw: () => renderer.render(scene, camera),
    dispose: () => {
      running = false;
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose();
    },
  };
}
