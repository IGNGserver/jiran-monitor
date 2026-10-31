/**
 * 首屏「刻漏」实时场景。几何、节奏与配色读 design/kelou.json；站点静帧也由本场景渲染
 * （design/tools/stills.mjs），所以静帧与实时画面同源。
 *
 * 叙事：五十九处来源的水滴落入源壶 → 平水壶把它们匀成稳定的一滴一滴 → 受水壶里的浮箭随计入的
 * Token 上升，刻度从朱砂指针旁经过。实测的水滴是实心的，按内容重建的水滴是半透明的；
 * credits 落进旁边单独的小杯，不倒进主壶（credits 绝不折算进 Token）。
 *
 * 所有水滴的位置都是 f(种子, 时间) 的纯函数：同一时刻渲染出的画面完全一致，没有逐帧积累的状态
 * （唯一的例外是演示计数器的缓动）。只在支持 WebGL 且未开启「减少动态」时由 Hero 动态加载；
 * 任何失败都停在静帧上。
 */
import {
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  LatheGeometry,
  MathUtils,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  CatmullRomCurve3,
  BoxGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import spec from '../../../design/kelou.json';
import { MAX_HITS, waterFragment, waterVertex } from './shaders';

export type HeroView = 'wide' | 'tall' | 'macro';

export interface ScreenPoint { x: number; y: number; visible: boolean }

export interface HeroOptions {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  tools: string[];
  /** 当前被标注的来源：index 对应 tools，坐标是那一滴水在画布上的位置 */
  onFocus?: (info: ScreenPoint & { index: number }) => void;
  /** 朱砂指针在画布上的位置，用来把读数贴在它旁边 */
  onReading?: (info: ScreenPoint) => void;
  /** credits 小杯在画布上的位置 */
  onCredits?: (info: ScreenPoint) => void;
  onCount?: (tokens: number) => void;
  onReady?: () => void;
  /** 静帧模式：只渲染给定时刻的一帧（供 design/tools/stills.mjs 使用），不启动动画循环 */
  still?: { time: number; view: HeroView; width: number; height: number };
}

const P = spec.palette;
const G = spec.gravity;
const RIPPLE_LIFE = 2.4;
// 从高处落下的水滴很快达到终端速度：先加速，再匀速。这样它们在画面里停留得够久，能被看清、被标注
const V = spec.sources.speed;
const TAU = spec.sources.settle;

/** 终端速度下落 h 米所需的秒数（不动点迭代，几步就收敛） */
function terminalFall(h: number) {
  let T = h / V + TAU;
  for (let i = 0; i < 4; i++) T = h / V + TAU * (1 - Math.exp(-T / TAU));
  return T;
}

/** 整数哈希 → [0, 1)。与时间无关的「种子」都从这里来。 */
function hash(a: number, b: number) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 画质档位。软件光栅（SwiftShader / llvmpipe 等，没有 GPU 的机器与 CI）走最轻的一档：小而硬的阴影、30 帧。 */
function tier(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return { shadow: 512, dpr: 1, soft: false, fps: 30 };
  const w = Math.min(window.innerWidth, window.innerHeight * 2);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (w < 700 || cores <= 4 || mem <= 2) return { shadow: 1024, dpr: 1.5, soft: true, fps: 60 };
  return { shadow: 2048, dpr: 2, soft: true, fps: 60 };
}

type VesselSpec = { id: string; pos: number[]; radius: number; height: number; level: number };

const WALL = 0.045;
const FOOT = 0.9; // 壶底半径相对口沿的比例（略收）

/** 壶的剖面：内壁 → 口沿 → 外壁 → 圈足，绕 Y 轴车出来。 */
function vesselGeometry(R: number, H: number) {
  const b = R * FOOT;
  const pts = [
    [0, WALL],
    [b - WALL - 0.04, WALL],
    [b - WALL, WALL + 0.04],
    [R - WALL, H - 0.02],
    [R - WALL + 0.012, H],
    [R + 0.028, H],
    [R + 0.036, H - 0.026],
    [R + 0.004, H - 0.06],
    [b, 0.07],
    [b - 0.012, 0.03],
    [b - 0.05, 0.0],
    [0, 0],
  ].map(([x, y]) => new Vector2(x, y));
  const geo = new LatheGeometry(pts, 112);
  geo.computeVertexNormals();
  return geo;
}

/** 内壁在高度 y（相对壶底）处的半径 */
function innerRadius(R: number, H: number, y: number) {
  const b = R * FOOT - WALL;
  return MathUtils.lerp(b, R - WALL, MathUtils.clamp((y - WALL) / (H - WALL), 0, 1));
}

interface Surface {
  center: Vector3; // 水面中心（世界坐标）
  radius: number;
  mat: ShaderMaterial;
  hits: Vector4[];
}

interface Emitter {
  x: number;
  z: number;
  y0: number; // 出水点高度
  fall: number; // 落到水面所需秒数
  interval: number;
  phase: number; // 第 n 滴的出水时刻 = (n + phase) * interval
  surface: Surface;
  kind: 'source' | 'drip' | 'credit';
  index: number; // 来源序号；非来源为 -1
  radius: number;
  hang: boolean; // 出水口上是否挂着正在形成的一滴
  terminal: boolean; // true：终端速度下落（远处来的水滴）；false：自由落体（出水口的短距离滴落）
}

function makeSurface(center: Vector3, radius: number): Surface {
  const mat = new ShaderMaterial({
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uRadius: { value: radius },
        uHits: { value: Array.from({ length: MAX_HITS }, () => new Vector4()) },
        uDeep: { value: new Color(P.water) },
        uLight: { value: new Color(P.waterLight) },
      },
    ]),
  });
  return { center, radius, mat, hits: [] };
}

/** 浮箭的刻度：象牙色竹片，每「刻」一道长线并标上汉字序数，中间四道短线。 */
function rodTexture() {
  const r = spec.rod;
  const w = 64;
  const h = 2048;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = P.ivory;
  g.fillRect(0, 0, w, h);
  // 竹纹：几道极淡的纵向纤维
  g.globalAlpha = 0.06;
  g.fillStyle = P.wood;
  for (let i = 0; i < 9; i++) g.fillRect(4 + hash(i, 3) * (w - 8), 0, 1, h);
  g.globalAlpha = 1;
  const numerals = ['十', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const major = h / r.marks;
  g.fillStyle = P.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 26px 'Noto Serif SC', 'Songti SC', 'STSong', serif`;
  for (let m = 0; m < r.marks; m++) {
    // 画布 y 向下；纹理 v 向上，所以从底往上排
    const y = h - m * major;
    g.fillRect(0, y - 2, w, 3);
    for (let k = 1; k < 5; k++) g.fillRect(0, y - (k * major) / 5 - 1, w * 0.32, 2);
    g.fillText(numerals[m], w / 2 + 6, y - major * 0.5);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function buildApparatus(shadowSize: number) {
  const root = new Group();
  const celadon = new MeshPhysicalMaterial({
    color: P.celadon,
    roughness: 0.3,
    clearcoat: 0.9,
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.9,
  });
  const stone = new MeshStandardMaterial({ color: P.stone, roughness: 0.92, metalness: 0 });
  const wood = new MeshStandardMaterial({ color: P.wood, roughness: 0.6 });
  const vessels = spec.vessels as VesselSpec[];
  const surfaces: Surface[] = [];
  const tips: Vector3[] = [];

  const addVessel = (v: VesselSpec, plinth: boolean) => {
    const [x, y, z] = v.pos;
    const mesh = new Mesh(vesselGeometry(v.radius, v.height), celadon);
    mesh.position.set(x, y + 0.004, z); // 抬起一点，避免圈足与石台共面产生阴影条纹
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    if (plinth && y > 0.001) {
      const side = v.radius * 2.25;
      const block = new Mesh(new RoundedBoxGeometry(side, y, side, 3, 0.035), stone);
      block.position.set(x, y / 2, z);
      block.castShadow = true;
      block.receiveShadow = true;
      root.add(block);
    }
    const ly = v.height * v.level;
    const surf = makeSurface(new Vector3(x, y + ly, z), innerRadius(v.radius, v.height, ly));
    const disc = new Mesh(new CircleGeometry(surf.radius, 72), surf.mat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(surf.center);
    root.add(disc);
    surfaces.push(surf);
    return surf;
  };

  vessels.forEach((v) => addVessel(v, true));
  const cr = spec.credits;
  const creditsSurface = addVessel({ id: 'credits', pos: cr.pos, radius: cr.radius, height: cr.height, level: cr.level }, false);

  // 出水管：从上一只壶的侧壁伸出，弯向下一只壶的水面上方
  const spoutMat = new MeshStandardMaterial({ color: P.celadonDeep, roughness: 0.35, metalness: 0.05 });
  for (let i = 0; i < vessels.length - 1; i++) {
    const a = vessels[i];
    const b = vessels[i + 1];
    const d = new Vector3(b.pos[0] - a.pos[0], 0, b.pos[2] - a.pos[2]);
    const dist = d.length();
    d.normalize();
    const y0 = a.pos[1] + 0.2;
    const start = new Vector3(a.pos[0], y0, a.pos[2]).addScaledVector(d, a.radius * 0.96);
    const reach = dist - b.radius * 0.42;
    const tip = new Vector3(a.pos[0], y0 - 0.12, a.pos[2]).addScaledVector(d, reach);
    const mid = new Vector3(a.pos[0], y0 + 0.02, a.pos[2]).addScaledVector(d, MathUtils.lerp(a.radius, reach, 0.62));
    const bend = new Vector3(a.pos[0], y0 - 0.04, a.pos[2]).addScaledVector(d, reach - 0.04);
    const curve = new CatmullRomCurve3([start, mid, bend, tip]);
    const tube = new Mesh(new TubeGeometry(curve, 40, 0.032, 12, false), spoutMat);
    tube.castShadow = true;
    root.add(tube);
    tips.push(tip);
  }

  // 受水壶：口沿上架一根横木，浮箭从水里升起；横木上立一根小柱，挑出朱砂指针
  const recv = vessels[vessels.length - 1];
  const rs = surfaces[vessels.length - 1];
  const rimY = recv.pos[1] + recv.height + 0.03;
  const bar = new Mesh(new BoxGeometry(recv.radius * 2 + 0.16, 0.05, 0.07), wood);
  bar.position.set(recv.pos[0], rimY, recv.pos[2]);
  bar.castShadow = true;
  root.add(bar);
  const r = spec.rod;
  const rodTex = rodTexture();
  rodTex.repeat.set(1, (r.above + r.below) / r.period);
  const rodMat = new MeshStandardMaterial({ color: '#ffffff', map: rodTex, roughness: 0.55 });
  const rodLen = r.above + r.below;
  const rod = new Mesh(new BoxGeometry(r.width, rodLen, r.width), rodMat);
  rod.position.set(recv.pos[0], rs.center.y - r.below + rodLen / 2, recv.pos[2]);
  rod.castShadow = true;
  root.add(rod);
  const postX = recv.pos[0] + 0.15;
  const postH = r.pointer + 0.16;
  const post = new Mesh(new BoxGeometry(0.035, postH, 0.035), wood);
  post.position.set(postX, rimY + postH / 2, recv.pos[2]);
  post.castShadow = true;
  root.add(post);
  const pointerY = rs.center.y + r.pointer;
  const pointer = new Mesh(
    new BoxGeometry(0.15 - r.width / 2, 0.016, 0.03),
    new MeshStandardMaterial({ color: P.cinnabar, roughness: 0.4 }),
  );
  pointer.position.set(recv.pos[0] + r.width / 2 + (0.15 - r.width / 2) / 2, pointerY, recv.pos[2]);
  root.add(pointer);
  const pointerTip = new Vector3(recv.pos[0] + 0.15, pointerY, recv.pos[2]);

  // 地面只接影子：画面里没有「桌面」，器物直接立在纸上
  const ground = new Mesh(new PlaneGeometry(40, 40), new ShadowMaterial({ color: P.ink, opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  return { root, surfaces, tips, rodTex, pointerTip, creditsSurface, shadowSize };
}

/** 构图：宽屏把刻漏放在右侧给文字让位；竖屏放在上半屏。 */
function framing(aspect: number, view: HeroView) {
  if (view === 'macro') {
    return { fov: 24, distance: 3.1, elevation: 9, azimuth: 30, target: new Vector3(0.98, 1.55, 0.55), shiftX: 0, shiftY: 0 };
  }
  if (view === 'wide' && aspect >= 1.05) {
    const squeeze = MathUtils.clamp((1.9 - aspect) / 0.7, 0, 1);
    return {
      fov: 30,
      distance: 12.8 + squeeze * 5.2,
      elevation: 21,
      azimuth: 32,
      target: new Vector3(-0.35, 1.3, -0.3),
      shiftX: -0.21 - squeeze * 0.02,
      shiftY: 0,
    };
  }
  const narrow = MathUtils.clamp((1.05 - aspect) / 0.6, 0, 1);
  return { fov: 34, distance: 13.5 + narrow * 4, elevation: 22, azimuth: 30, target: new Vector3(-0.5, 1.4, -0.45), shiftX: 0, shiftY: 0.2 };
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
  const t = tier(renderer.getContext());
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(P.paper, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.fog = new Fog(P.paper, 13, 30);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  scene.add(new HemisphereLight(P.paper, P.stone, 0.55));
  const key = new DirectionalLight('#fff4e4', 1.7);
  key.position.set(-5.5, 9, 6.5);
  key.target.position.set(0, 0.8, 0);
  key.castShadow = true;
  const shadowSize = still ? 4096 : t.shadow;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.shadow.radius = still || t.soft ? 6 : 1;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.035;
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  scene.add(key, key.target);

  const camera = new PerspectiveCamera(30, 1, 0.1, 80);
  const app = buildApparatus(shadowSize);
  scene.add(app.root);

  // ------------------------------------------------------------------ 水滴
  const [srcS, lvlS, rcvS] = app.surfaces;
  const src = spec.sources;
  const emitters: Emitter[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < src.count; k++) {
    // 向日葵排布：五十九个落点均匀铺在源壶水面上
    const rr = srcS.radius * src.spread * Math.sqrt((k + 0.5) / src.count);
    const th = k * golden;
    const h = src.height + hash(k, 11) * 1.2;
    emitters.push({
      x: srcS.center.x + rr * Math.cos(th),
      z: srcS.center.z + rr * Math.sin(th),
      y0: srcS.center.y + h,
      fall: terminalFall(h),
      interval: src.base * (1 + k * src.growth),
      phase: hash(k, 7),
      surface: srcS,
      kind: 'source',
      index: k,
      radius: src.radius * (0.85 + hash(k, 5) * 0.3),
      hang: false,
      terminal: true,
    });
  }
  const dripFrom = (tip: Vector3, to: Surface, interval: number, phase: number): Emitter => ({
    x: tip.x,
    z: tip.z,
    y0: tip.y - 0.03,
    fall: Math.sqrt((2 * (tip.y - 0.03 - to.center.y)) / G),
    interval,
    phase,
    surface: to,
    kind: 'drip',
    index: -1,
    radius: 0.044,
    hang: true,
    terminal: false,
  });
  const toLevel = dripFrom(app.tips[0], lvlS, spec.drips.source, 0.1);
  const toReceive = dripFrom(app.tips[1], rcvS, spec.drips.level, 0.55);
  emitters.push(toLevel, toReceive);
  const cs = app.creditsSurface;
  const creditH = 6.2;
  emitters.push({
    x: cs.center.x - 0.03,
    z: cs.center.z + 0.02,
    y0: cs.center.y + creditH,
    fall: terminalFall(creditH),
    interval: spec.credits.interval,
    phase: spec.credits.phase,
    surface: cs,
    kind: 'credit',
    index: -1,
    radius: 0.038,
    hang: false,
    terminal: true,
  });

  const dropGeo = new SphereGeometry(1, 18, 12);
  const solidMat = new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4 });
  const ghostMat = new MeshPhysicalMaterial({
    color: P.drop,
    roughness: 0.1,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    envMapIntensity: 1.2,
  });
  const CAP = 160;
  const solid = new InstancedMesh(dropGeo, solidMat, CAP);
  const ghost = new InstancedMesh(dropGeo, ghostMat, CAP);
  solid.frustumCulled = ghost.frustumCulled = false;
  scene.add(solid, ghost);
  const cDrop = new Color(P.drop);
  const cCredit = new Color(P.brass);
  const cFocus = new Color(P.ink);
  for (let i = 0; i < CAP; i++) solid.setColorAt(i, cDrop);

  const m4 = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();

  let focusK = -1;
  let focusN = 0;
  let focusStart = 0;
  let focusEnd = -1;
  let lastK = 0;
  const focusPos = new Vector3();
  let focusLive = false;

  /** 选下一滴要标注的水：在空中、离落下至少还有约 1.2 秒的里面，最先落下的那一滴 */
  const pickFocus = (time: number) => {
    let best: { k: number; n: number; land: number } | null = null;
    for (let step = 1; step <= 12; step++) {
      const k = (lastK + step * 7) % src.count; // 跳着走，避免相邻的来源挨在一起
      const e = emitters[k];
      const n = Math.ceil((time + 1.2 - e.fall) / e.interval - e.phase);
      const land = (n + e.phase) * e.interval + e.fall;
      if (!best || land < best.land) best = { k, n, land };
    }
    focusK = best!.k;
    focusN = best!.n;
    focusEnd = best!.land;
    focusStart = Math.max(time, focusEnd - emitters[focusK].fall);
    lastK = focusK;
  };

  const writeDrops = (time: number) => {
    let ns = 0;
    let ng = 0;
    focusLive = false;
    for (const s of app.surfaces) s.hits.length = 0;
    for (const e of emitters) {
      const nMax = Math.floor(time / e.interval - e.phase);
      const nMin = Math.ceil((time - e.fall) / e.interval - e.phase);
      for (let n = nMin; n <= nMax; n++) {
        const tt = time - (n + e.phase) * e.interval;
        if (tt < 0 || tt > e.fall) continue;
        const decay = Math.exp(-tt / TAU);
        const y = e.terminal ? e.y0 - V * (tt - TAU * (1 - decay)) : e.y0 - 0.5 * G * tt * tt;
        const v = e.terminal ? V * (1 - decay) : G * tt;
        const stretch = 1 + Math.min(1.4, v * 0.2);
        pos.set(e.x, y, e.z);
        scl.set(e.radius, e.radius * stretch, e.radius);
        m4.compose(pos, q, scl);
        const estimated = e.kind === 'source' && hash(e.index * 131 + 17, n) < src.estimated;
        if (estimated) {
          if (ng < CAP) ghost.setMatrixAt(ng++, m4);
        } else if (ns < CAP) {
          const isFocus = e.index === focusK && n === focusN;
          if (isFocus) {
            focusPos.copy(pos);
            focusLive = true;
          }
          solid.setMatrixAt(ns, m4);
          solid.setColorAt(ns, isFocus ? cFocus : e.kind === 'credit' ? cCredit : cDrop);
          ns++;
        }
      }
      // 出水口上正在形成的一滴：随间隔慢慢长大，落下的一瞬间消失
      if (e.hang && ns < CAP) {
        const f = time / e.interval - e.phase;
        const grow = Math.pow(f - Math.floor(f), 0.7);
        const r = e.radius * (0.25 + 0.75 * grow);
        pos.set(e.x, e.y0 + 0.02 - r, e.z);
        scl.set(r, r * (1 + 0.25 * grow), r);
        m4.compose(pos, q, scl);
        solid.setMatrixAt(ns, m4);
        solid.setColorAt(ns, cDrop);
        ns++;
      }
      // 涟漪：最近落下的几滴
      const hMax = Math.floor((time - e.fall) / e.interval - e.phase);
      const hMin = Math.ceil((time - e.fall - RIPPLE_LIFE) / e.interval - e.phase);
      for (let n = hMin; n <= hMax; n++) {
        const at = (n + e.phase) * e.interval + e.fall;
        const strength = e.kind === 'source' ? 0.75 : 1;
        e.surface.hits.push(new Vector4(e.x - e.surface.center.x, -(e.z - e.surface.center.z), at, strength));
      }
    }
    solid.count = ns;
    ghost.count = ng;
    solid.instanceMatrix.needsUpdate = true;
    ghost.instanceMatrix.needsUpdate = true;
    if (solid.instanceColor) solid.instanceColor.needsUpdate = true;
    for (const s of app.surfaces) {
      s.hits.sort((a, b) => b.z - a.z);
      const u = s.mat.uniforms.uHits.value as Vector4[];
      for (let i = 0; i < MAX_HITS; i++) {
        const h = s.hits[i];
        if (h) u[i].copy(h);
        else u[i].set(0, 0, -99, 0);
      }
      s.mat.uniforms.uTime.value = time;
    }
  };

  /** 截至 time 为止落进受水壶的 Token（演示值） */
  const chunk = (n: number) => spec.count.min + hash(n, 29) * spec.count.spread;
  const landedIndex = (time: number) => Math.floor((time - toReceive.fall) / toReceive.interval - toReceive.phase);

  // ------------------------------------------------------------------ 镜头
  const view: HeroView = still?.view ?? 'wide';
  let frame = framing(1, view);
  let dpr = still ? 1 : Math.min(window.devicePixelRatio || 1, t.dpr);
  let W = 1;
  let H = 1;
  const resize = () => {
    W = still ? still.width : host.clientWidth;
    H = still ? still.height : host.clientHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    frame = framing(camera.aspect, view);
    camera.fov = frame.fov;
    if (frame.shiftX || frame.shiftY) camera.setViewOffset(W, H, W * frame.shiftX, H * frame.shiftY, W, H);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  resize();

  const camPos = new Vector3();
  const placeCamera = (time: number, scroll: number, px: number, py: number) => {
    const p = MathUtils.smootherstep(Math.min(scroll, 1), 0, 1);
    const el = MathUtils.degToRad(frame.elevation + py * 2 + p * 8);
    const az = MathUtils.degToRad(frame.azimuth + Math.sin(time * 0.05) * 3 + px * 3);
    const dist = frame.distance * MathUtils.lerp(1, 0.78, p);
    const target = frame.target.clone().lerp(app.pointerTip, p * 0.5);
    camPos.set(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az)).add(target);
    camera.position.copy(camPos);
    camera.lookAt(target);
  };

  const project = (v: Vector3, pad = 0): ScreenPoint => {
    const p = v.clone().project(camera);
    const x = (p.x * 0.5 + 0.5) * W;
    const y = (-p.y * 0.5 + 0.5) * H;
    return { x, y, visible: p.z < 1 && x > pad && x < W - pad && y > pad && y < H - pad };
  };

  if (still) {
    // 刻度用的是页面字体；等字体就绪再画一次纹理
    placeCamera(still.time, 0, 0, 0);
    writeDrops(still.time);
    const draw = () => renderer.render(scene, camera);
    draw();
    return { draw, dispose: () => renderer.dispose() };
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // 指针：只做极轻的视差
  let px = 0;
  let py = 0;
  let tx = 0;
  let ty = 0;
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    tx = (e.clientX / window.innerWidth) * 2 - 1;
    ty = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let scrollP = 0;
  const onScroll = () => {
    scrollP = MathUtils.clamp(window.scrollY / Math.max(1, host.clientHeight), 0, 1.2);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  let running = true;
  let visible = true;
  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
  };
  document.addEventListener('visibilitychange', onVisibility);

  // 字体加载后重画刻度（汉字序数）
  document.fonts?.ready.then(() => {
    const fresh = rodTexture();
    app.rodTex.image = fresh.image;
    app.rodTex.needsUpdate = true;
  });

  const t0 = performance.now();
  // 从一个已经「流起来」的时刻开始，避免首帧空无一滴
  const OFFSET = 30;
  let prev = t0;
  let landed = landedIndex(OFFSET);
  let counted = 0;
  let shown = 0;
  let ready = false;
  const samples: number[] = [];
  let degraded = false;

  const tick = (now: number) => {
    if (!running) return;
    requestAnimationFrame(tick);
    if (!visible || scrollP >= 1.05) {
      prev = now;
      return;
    }
    // 软件光栅限到 30 帧，把 CPU 留给页面本身
    if (t.fps < 60 && now - prev < 1000 / t.fps - 2) return;
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    const time = OFFSET + (now - t0) / 1000;

    // 自适应：前 90 帧平均超过 26ms 就降分辨率、关掉软阴影
    if (!degraded && samples.length < 90) {
      samples.push(dt);
      if (samples.length === 90) {
        const avg = samples.slice(20).reduce((a, b) => a + b, 0) / 70;
        if (avg > 0.026) {
          degraded = true;
          dpr = 1;
          key.shadow.radius = 1;
          resize();
        }
      }
    }

    px = MathUtils.damp(px, tx, 2, dt);
    py = MathUtils.damp(py, ty, 2, dt);
    placeCamera(time, scrollP, px, py);

    if (time > focusEnd) pickFocus(time);
    writeDrops(time);

    const li = landedIndex(time);
    while (landed < li) counted += chunk(++landed);
    shown = MathUtils.damp(shown, counted, 7, dt);
    // 浮箭随读数上升：刻度向上走过指针
    app.rodTex.offset.y = -(shown / (spec.rod.tokensPerMark * spec.rod.marks));

    renderer.render(scene, camera);

    opts.onCount?.(shown);
    const calm = scrollP < 0.2;
    if (opts.onFocus) {
      const fp = project(focusPos, 90);
      const age = time - focusStart;
      opts.onFocus({ index: focusK, x: fp.x, y: fp.y, visible: calm && focusLive && fp.visible && age > 0.2 && focusEnd - time > 0.15 });
    }
    if (opts.onReading) {
      const rp = project(app.pointerTip, 40);
      opts.onReading({ ...rp, visible: rp.visible && calm });
    }
    if (opts.onCredits) {
      const cp = project(app.creditsSurface.center.clone().add(new Vector3(0, 0.05, 0)), 60);
      opts.onCredits({ ...cp, visible: cp.visible && calm });
    }
    if (!ready) {
      ready = true;
      opts.onReady?.();
    }
  };
  requestAnimationFrame(tick);

  return {
    draw: () => {},
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
