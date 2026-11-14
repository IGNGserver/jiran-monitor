import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildStudioEnv } from './env';
import { SPEC, type CameraSpec, type ModelId } from './spec';

declare global {
  interface Window {
    __MODEL_STILL__?: string;
  }
}

interface AnimatedNode {
  obj: THREE.Object3D;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
}

interface ModelRig {
  id: ModelId;
  scene: THREE.Scene;
  root: THREE.Object3D;
  nodes: Map<string, AnimatedNode>;
  arcMat: THREE.MeshStandardMaterial | null;
  hubCurves: THREE.QuadraticBezierCurve3[];
}

interface StageEntry {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  id: ModelId;
  camera: THREE.PerspectiveCamera;
  rig: ModelRig | null;
  loading: boolean;
  visible: boolean;
  width: number;
  height: number;
  dpr: number;
  pointerTargetX: number;
  pointerTargetY: number;
  pointerX: number;
  pointerY: number;
}

function isLowTierDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}

function upgradeSceneMaterials(root: THREE.Object3D, enableShadow: boolean): THREE.MeshStandardMaterial | null {
  const cache = new Map<string, THREE.Material>();
  const P = SPEC.palette;
  let quotaArcMat: THREE.MeshStandardMaterial | null = null;

  const makeUpgraded = (name: string): THREE.Material => {
    switch (name) {
      case 'base_dark':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#101520'),
          metalness: 0.68,
          roughness: 0.44,
          envMapIntensity: 1.05,
        });
      case 'frame_metal':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#273042'),
          metalness: 0.86,
          roughness: 0.24,
          envMapIntensity: 1.38,
        });
      case 'raw_slate':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#1f2737'),
          metalness: 0.34,
          roughness: 0.54,
          envMapIntensity: 0.92,
        });
      case 'glass_cyan':
        return new THREE.MeshPhysicalMaterial({
          name,
          color: new THREE.Color('#70d6ff'),
          metalness: 0.06,
          roughness: 0.14,
          clearcoat: 0.92,
          clearcoatRoughness: 0.12,
          transparent: true,
          opacity: 0.84,
          emissive: new THREE.Color(P.cyan),
          emissiveIntensity: 0.16,
          envMapIntensity: 1.55,
        });
      case 'cyan_tile':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#3bb6eb'),
          metalness: 0.28,
          roughness: 0.22,
          emissive: new THREE.Color(P.cyan),
          emissiveIntensity: 0.15,
          envMapIntensity: 1.28,
        });
      case 'cyan_deep':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#1e7ca6'),
          metalness: 0.38,
          roughness: 0.26,
          emissive: new THREE.Color(P.cyan),
          emissiveIntensity: 0.1,
          envMapIntensity: 1.22,
        });
      case 'platinum_tile':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(P.platinum),
          metalness: 0.44,
          roughness: 0.18,
          emissive: new THREE.Color('#ffffff'),
          emissiveIntensity: 0.05,
          envMapIntensity: 1.38,
        });
      case 'brass_tile':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(P.brass),
          metalness: 0.76,
          roughness: 0.21,
          emissive: new THREE.Color(P.brass),
          emissiveIntensity: 0.12,
          envMapIntensity: 1.42,
        });
      case 'cyan_glow':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(P.cyan),
          metalness: 0.05,
          roughness: 0.2,
          emissive: new THREE.Color(P.cyan),
          emissiveIntensity: 1.55,
        });
      case 'gold_glow':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(P.brass),
          metalness: 0.08,
          roughness: 0.2,
          emissive: new THREE.Color(P.brass),
          emissiveIntensity: 1.45,
        });
      case 'amber_glow':
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(P.amber),
          metalness: 0.08,
          roughness: 0.22,
          emissive: new THREE.Color(P.amber),
          emissiveIntensity: 1.45,
        });
      default:
        return new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color('#273042'),
          metalness: 0.6,
          roughness: 0.35,
        });
    }
  };

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const origMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const matName = origMat?.name || 'frame_metal';

    if (obj.name === 'quota_arc_5h') {
      const special = makeUpgraded('glass_cyan') as THREE.MeshStandardMaterial;
      obj.material = special;
      quotaArcMat = special;
    } else {
      let next = cache.get(matName);
      if (!next) {
        next = makeUpgraded(matName);
        cache.set(matName, next);
      }
      obj.material = next;
    }

    const isGlow = matName.endsWith('_glow');
    if (enableShadow) {
      obj.castShadow = !isGlow;
      obj.receiveShadow = !isGlow;
    }
  });

  return quotaArcMat;
}

function addStageLights(scene: THREE.Scene, enableShadow: boolean): void {
  const hemi = new THREE.HemisphereLight('#c4dcf5', '#0a0e16', 0.58);
  scene.add(hemi);

  const key = new THREE.DirectionalLight('#f5f8fd', 2.25);
  key.position.set(3.2, 5.1, 2.9);
  if (enableShadow) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.8;
    key.shadow.camera.far = 14;
    key.shadow.camera.left = -2.6;
    key.shadow.camera.right = 2.6;
    key.shadow.camera.top = 2.0;
    key.shadow.camera.bottom = -2.0;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.015;
  }
  scene.add(key);

  const cyanRim = new THREE.DirectionalLight(SPEC.palette.cyan, 1.45);
  cyanRim.position.set(-3.6, 2.5, -2.6);
  scene.add(cyanRim);

  const goldFill = new THREE.DirectionalLight(SPEC.palette.brass, 0.92);
  goldFill.position.set(2.8, 1.9, -1.9);
  scene.add(goldFill);
}

function buildRig(id: ModelId, gltfScene: THREE.Group, envMap: THREE.Texture, enableShadow: boolean): ModelRig {
  const scene = new THREE.Scene();
  scene.environment = envMap;
  addStageLights(scene, enableShadow);

  const arcMat = upgradeSceneMaterials(gltfScene, enableShadow);
  scene.add(gltfScene);

  // 托盘底部柔和暗影承接垫（让底座与视口自然融合）
  if (enableShadow) {
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 6),
      new THREE.ShadowMaterial({ opacity: 0.34 }),
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.002;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);
  }

  const root = gltfScene.getObjectByName('model_root') ?? gltfScene;
  const nodes = new Map<string, AnimatedNode>();
  gltfScene.traverse((o) => {
    if (o.name) {
      nodes.set(o.name, {
        obj: o,
        basePos: o.position.clone(),
        baseRot: o.rotation.clone(),
      });
    }
  });

  const hubCurves =
    id === 'hub'
      ? SPEC.models.hub.routes.map(
          (r) =>
            new THREE.QuadraticBezierCurve3(
              new THREE.Vector3(...r.from),
              new THREE.Vector3(...r.mid),
              new THREE.Vector3(...r.to),
            ),
        )
      : [];

  return { id, scene, root, nodes, arcMat, hubCurves };
}

function applyAnimation(rig: ModelRig, t: number): void {
  // 整体极克制的呼吸微转角，让倒角高光保持生命感
  rig.root.rotation.y = Math.sin(t * 0.36) * 0.032;

  if (rig.id === 'hero') {
    const [minX, maxX] = SPEC.models.hero.streamSpan;
    const span = maxX - minX;
    for (let i = 0; i < 12; i++) {
      const n = rig.nodes.get(`stream_${i}`);
      if (!n) continue;
      const laneIdx = Math.floor(i / 3);
      const slotIdx = i % 3;
      const u = (slotIdx / 3 + laneIdx * 0.09 + t * 0.095) % 1;
      const x = minX + u * span;
      const gateBoost = Math.exp(-Math.pow((x - SPEC.models.hero.gateX) / 0.22, 2));
      n.obj.position.x = x;
      n.obj.position.y = n.basePos.y + gateBoost * 0.024;
    }

    const scan = rig.nodes.get('scan_bar');
    if (scan) {
      scan.obj.position.y = scan.basePos.y - 0.05 + Math.sin(t * 1.45) * 0.048;
    }

    for (let s = 0; s < 4; s++) {
      const st = rig.nodes.get(`stack_${s}`);
      if (!st) continue;
      const topChild = st.obj.children[st.obj.children.length - 1];
      if (topChild) {
        const specSt = SPEC.models.hero.stacks[s];
        const baseTopY = (specSt.count - 1) * (specSt.h + 0.022) + specSt.h / 2;
        topChild.position.y = baseTopY + 0.012 + Math.sin(t * 1.25 + s * 1.15) * 0.014;
      }
    }
  } else if (rig.id === 'mix') {
    for (let i = 0; i < 5; i++) {
      const seg = rig.nodes.get(`seg_${i}`);
      if (!seg) continue;
      seg.obj.position.y = seg.basePos.y + Math.sin(t * 1.18 - i * 0.58) * 0.016;
    }
    for (let c = 0; c < 3; c++) {
      const col = rig.nodes.get(`col_${c}`);
      if (!col) continue;
      col.obj.position.y = col.basePos.y + Math.sin(t * 0.95 + c * 1.3) * 0.012;
    }
  } else if (rig.id === 'quota') {
    const dial = rig.nodes.get('quota_dial');
    if (dial) {
      dial.obj.rotation.z = Math.sin(t * 0.72) * 0.025;
    }
    if (rig.arcMat) {
      rig.arcMat.emissiveIntensity = 0.16 + Math.sin(t * 1.55) * 0.07;
    }
    const topPlaque = rig.nodes.get('credits_top');
    if (topPlaque) {
      topPlaque.obj.position.y = topPlaque.basePos.y + Math.sin(t * 1.3) * 0.022;
    }
  } else if (rig.id === 'hub') {
    rig.hubCurves.forEach((curve, rIdx) => {
      for (let k = 0; k < 2; k++) {
        const pkt = rig.nodes.get(`pkt_${rIdx * 2 + k}`);
        if (!pkt) continue;
        const u = (k * 0.5 + rIdx * 0.19 + t * 0.19) % 1;
        curve.getPoint(u, pkt.obj.position);
        const tangent = curve.getTangent(u);
        pkt.obj.rotation.y = Math.atan2(tangent.x, tangent.z);
      }
    });

    const hub = rig.nodes.get('hub_core');
    if (hub) {
      hub.obj.position.y = hub.basePos.y + Math.sin(t * 1.05) * 0.012;
    }
    const phone = rig.nodes.get('android_surface');
    if (phone) {
      phone.obj.position.y = phone.basePos.y + Math.sin(t * 1.15 + 0.8) * 0.018;
    }
  }
}

function updateCameraPose(
  camera: THREE.PerspectiveCamera,
  specCam: CameraSpec,
  aspect: number,
  px: number,
  py: number,
): void {
  camera.fov = specCam.fov;
  camera.aspect = aspect;
  // 窄屏自动微拉远机位，保证左右两侧底座边缘完整入画
  const aspectScale = aspect < 1.32 ? 1 + (1.32 - aspect) * 0.44 : 1;
  const dist = specCam.distance * aspectScale;
  const az = THREE.MathUtils.degToRad(specCam.azimuth + px * 4.2);
  const el = THREE.MathUtils.degToRad(specCam.elevation + py * 2.4);
  const [tx, ty, tz] = specCam.target;

  const cosEl = Math.cos(el);
  camera.position.set(
    tx + dist * cosEl * Math.sin(az),
    ty + dist * Math.sin(el),
    tz + dist * cosEl * Math.cos(az),
  );
  camera.lookAt(tx, ty, tz);
  camera.updateProjectionMatrix();
}

function paintStillBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, shiftRight = false): void {
  const lin = ctx.createLinearGradient(0, 0, 0, h);
  lin.addColorStop(0, '#111622');
  lin.addColorStop(1, '#090b10');
  ctx.fillStyle = lin;
  ctx.fillRect(0, 0, w, h);

  const cx = w * (shiftRight ? 0.72 : 0.54);
  const cy = h * 0.44;
  const rCyan = Math.max(w, h) * 0.56;
  const gCyan = ctx.createRadialGradient(cx, cy, 0, cx, cy, rCyan);
  gCyan.addColorStop(0, 'rgba(79, 195, 247, 0.095)');
  gCyan.addColorStop(0.7, 'rgba(79, 195, 247, 0.02)');
  gCyan.addColorStop(1, 'rgba(79, 195, 247, 0)');
  ctx.fillStyle = gCyan;
  ctx.fillRect(0, 0, w, h);

  const gx = w * (shiftRight ? 0.84 : 0.72);
  const gy = h * 0.62;
  const rGold = Math.max(w, h) * 0.44;
  const gGold = ctx.createRadialGradient(gx, gy, 0, gx, gy, rGold);
  gGold.addColorStop(0, 'rgba(229, 169, 76, 0.065)');
  gGold.addColorStop(1, 'rgba(229, 169, 76, 0)');
  ctx.fillStyle = gGold;
  ctx.fillRect(0, 0, w, h);
}

export async function renderStillFromQuery(stillKey: string): Promise<void> {
  const presets: Record<
    string,
    { id: ModelId; w: number; h: number; t: number; offsetX: number }
  > = {
    hero: { id: 'hero', w: 1920, h: 1320, t: 1.45, offsetX: 0 },
    'hero-portrait': { id: 'hero', w: 1080, h: 900, t: 1.45, offsetX: 0 },
    'hero-og': { id: 'hero', w: 2400, h: 1260, t: 1.45, offsetX: -0.22 },
    mix: { id: 'mix', w: 1600, h: 1050, t: 1.85, offsetX: 0 },
    quota: { id: 'quota', w: 1600, h: 1050, t: 2.1, offsetX: 0 },
    hub: { id: 'hub', w: 1880, h: 800, t: 1.35, offsetX: 0 },
  };

  const preset = presets[stillKey] ?? presets.hero;
  const params = new URLSearchParams(window.location.search);
  const w = Number(params.get('w')) || preset.w;
  const h = Number(params.get('h')) || preset.h;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);

  const envMap = buildStudioEnv(renderer);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const modelMeta = SPEC.models[preset.id];
  const gltf = await loader.loadAsync(`/models/${modelMeta.file}`);
  const rig = buildRig(preset.id, gltf.scene, envMap, true);
  applyAnimation(rig, preset.t);

  const camera = new THREE.PerspectiveCamera(modelMeta.camera.fov, w / h, 0.1, 40);
  updateCameraPose(camera, modelMeta.camera, w / h, 0, 0);
  if (preset.offsetX !== 0) {
    camera.setViewOffset(w, h, Math.round(w * preset.offsetX), 0, w, h);
  }

  renderer.render(rig.scene, camera);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  paintStillBackdrop(ctx, w, h, preset.offsetX !== 0);
  ctx.drawImage(renderer.domElement, 0, 0, w, h);

  window.__MODEL_STILL__ = out.toDataURL('image/png');
  renderer.dispose();
  envMap.dispose();
}

export function mountModelStages(): void {
  const stageEls = [...document.querySelectorAll<HTMLElement>('[data-model-stage]')];
  if (stageEls.length === 0) return;

  const low = isLowTierDevice();
  let renderer: THREE.WebGLRenderer | null = null;
  let envMap: THREE.Texture | null = null;
  let loader: GLTFLoader | null = null;

  const rigPromises = new Map<ModelId, Promise<ModelRig>>();
  const entries: StageEntry[] = [];

  const ensureEngine = () => {
    if (renderer && envMap && loader) return { renderer, envMap, loader };
    renderer = new THREE.WebGLRenderer({
      antialias: !low,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.16;
    renderer.shadowMap.enabled = !low;
    renderer.setPixelRatio(1);

    envMap = buildStudioEnv(renderer);
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    return { renderer, envMap, loader };
  };

  const loadModelRig = (id: ModelId): Promise<ModelRig> => {
    const existing = rigPromises.get(id);
    if (existing) return existing;
    const { envMap: env, loader: gltfLoader } = ensureEngine();
    const file = SPEC.models[id].file;
    const p = gltfLoader
      .loadAsync(`/models/${file}`)
      .then((gltf) => buildRig(id, gltf.scene, env, !low));
    rigPromises.set(id, p);
    return p;
  };

  const syncSize = (entry: StageEntry) => {
    const rect = entry.el.getBoundingClientRect();
    const w = Math.max(240, Math.round(rect.width));
    const h = Math.max(180, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, low ? 1.35 : 2);
    if (entry.width === w && entry.height === h && entry.dpr === dpr) return;
    entry.width = w;
    entry.height = h;
    entry.dpr = dpr;
    entry.canvas.width = Math.round(w * dpr);
    entry.canvas.height = Math.round(h * dpr);
  };

  const renderEntry = (entry: StageEntry, timeSec: number, dt: number) => {
    if (!entry.rig || !renderer) return;
    syncSize(entry);
    const cw = entry.canvas.width;
    const ch = entry.canvas.height;
    if (cw === 0 || ch === 0) return;

    const damp = 1 - Math.exp(-dt * 6);
    entry.pointerX += (entry.pointerTargetX - entry.pointerX) * damp;
    entry.pointerY += (entry.pointerTargetY - entry.pointerY) * damp;

    if (renderer.domElement.width !== cw || renderer.domElement.height !== ch) {
      renderer.setSize(cw, ch, false);
    }

    applyAnimation(entry.rig, timeSec);
    updateCameraPose(
      entry.camera,
      SPEC.models[entry.id].camera,
      cw / ch,
      entry.pointerX,
      entry.pointerY,
    );

    renderer.render(entry.rig.scene, entry.camera);
    entry.ctx.clearRect(0, 0, cw, ch);
    entry.ctx.drawImage(renderer.domElement, 0, 0, cw, ch);
  };

  let raf = 0;
  let lastNow = performance.now();
  const tStart = lastNow;

  const tick = (now: number) => {
    raf = 0;
    if (document.hidden) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    const timeSec = (now - tStart) / 1000 + 1.45;

    let anyActive = false;
    for (const entry of entries) {
      if (entry.visible && entry.rig) {
        renderEntry(entry, timeSec, dt);
        anyActive = true;
      }
    }
    if (anyActive) {
      raf = requestAnimationFrame(tick);
    }
  };

  const ensureLoop = () => {
    if (raf || document.hidden) return;
    if (entries.some((e) => e.visible && e.rig)) {
      lastNow = performance.now();
      raf = requestAnimationFrame(tick);
    }
  };

  for (const el of stageEls) {
    const rawId = el.dataset.modelId as ModelId | undefined;
    if (!rawId || !(rawId in SPEC.models)) continue;
    const canvas = el.querySelector<HTMLCanvasElement>('[data-model-canvas]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) continue;

    const specCam = SPEC.models[rawId].camera;
    const entry: StageEntry = {
      el,
      canvas,
      ctx,
      id: rawId,
      camera: new THREE.PerspectiveCamera(specCam.fov, 1.5, 0.1, 40),
      rig: null,
      loading: false,
      visible: false,
      width: 0,
      height: 0,
      dpr: 1,
      pointerTargetX: 0,
      pointerTargetY: 0,
      pointerX: 0,
      pointerY: 0,
    };

    el.addEventListener(
      'pointermove',
      (ev) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        entry.pointerTargetX = ((ev.clientX - r.left) / r.width) * 2 - 1;
        entry.pointerTargetY = -(((ev.clientY - r.top) / r.height) * 2 - 1);
      },
      { passive: true },
    );
    el.addEventListener(
      'pointerleave',
      () => {
        entry.pointerTargetX = 0;
        entry.pointerTargetY = 0;
      },
      { passive: true },
    );

    entries.push(entry);
  }

  const activateEntry = (entry: StageEntry) => {
    if (entry.rig || entry.loading) return;
    entry.loading = true;
    loadModelRig(entry.id)
      .then((rig) => {
        entry.rig = rig;
        renderEntry(entry, (performance.now() - tStart) / 1000 + 1.45, 0.016);
        entry.el.classList.add('is-live');
        if (entry.id === 'hero') {
          document.querySelector('[data-hero]')?.classList.add('is-live');
        }
        ensureLoop();
      })
      .catch(() => {
        entry.el.classList.add('is-fallback');
      });
  };

  const io = new IntersectionObserver(
    (changes) => {
      for (const ch of changes) {
        const entry = entries.find((e) => e.el === ch.target);
        if (!entry) continue;
        entry.visible = ch.isIntersecting;
        if (ch.isIntersecting) {
          activateEntry(entry);
        }
      }
      ensureLoop();
    },
    { rootMargin: '240px 0px', threshold: 0.01 },
  );

  for (const entry of entries) {
    io.observe(entry.el);
  }

  window.addEventListener(
    'resize',
    () => {
      for (const entry of entries) {
        entry.width = 0;
        if (entry.visible && entry.rig) {
          renderEntry(entry, (performance.now() - tStart) / 1000 + 1.45, 0.016);
        }
      }
    },
    { passive: true },
  );

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensureLoop();
  });
}
