/**
 * 全局空间舞台滚动导演（Director）：
 *   #top         组装态，悬浮于 84 日量化账本波面与 4 设备车队信标之上，支持阻尼指针视差；
 *   #anatomy     粘性爆炸剖面区段，自顶层配额表圈至底层防抖光阑逐层聚焦，SVG 引线与三维锚点像素级对齐；
 *   中间交互章节   舞台平滑淡出并完全暂停 requestAnimationFrame，零 GPU 争抢；
 *   #install     终章回归：54° 高俯角凝视蓝宝石表镜内的计然开口双圆弧与 T 字擒纵桥冠冕。
 *
 * 首屏即刻呈现 Blender Cycles AgX 高清静帧；Three.js 与压缩 GLB 在 load 后空闲时按需加载。
 * 开启 prefers-reduced-motion: reduce 或不支持 WebGL 时自动进入 html.no-gl 静态模式。
 */
import type { MeterScene, StageState } from './scene';
import { layerCenter, SPEC } from './spec';

const N = SPEC.layers.length;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function mixState(a: StageState, b: StageState, t: number): StageState {
  const o = {} as StageState;
  for (const k of Object.keys(a) as (keyof StageState)[]) o[k] = mix(a[k], b[k], t);
  return o;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function boot(): void {
  const root = document.documentElement;
  const stage = document.querySelector<HTMLElement>('[data-stage]');
  const canvas = stage?.querySelector<HTMLCanvasElement>('canvas');
  if (!stage || !canvas) return;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !webglAvailable()) {
    root.classList.add('no-gl');
    initStaticAnatomy();
    return;
  }

  trackSteps();

  const coarse = matchMedia('(pointer: coarse)').matches;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const low = coarse || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;

  const start = () =>
    import('./scene')
      .then(async ({ MeterScene }) => {
        const meter = new MeterScene(canvas, { low });
        await meter.load('/models/meter.glb');
        run(meter, stage, coarse);
      })
      .catch((err) => {
        console.warn('[meter] WebGL stage unavailable, keeping Cycles poster:', err);
        root.classList.add('no-gl');
        initStaticAnatomy();
      });

  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => start(), { timeout: 1200 });
    else setTimeout(start, 240);
  };

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
}

/** 剖面文字面板只依赖滚动坐标，与 3D 模型异步加载解耦，确保任何网速下滚动响应零延迟。 */
function anatomyStep(): number {
  const ana = document.getElementById('anatomy');
  if (!ana) return -1;
  const r = ana.getBoundingClientRect();
  if (r.top > 0) return -1;
  const p = clamp(-r.top / Math.max(1, r.height - window.innerHeight));
  if (p < 0.06) return -1;
  return Math.min(N - 1, Math.floor(((p - 0.06) / 0.94) * N));
}

function trackSteps() {
  const ana = document.getElementById('anatomy');
  const steps = Array.from(document.querySelectorAll<HTMLElement>('[data-step]'));
  const rail = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-rail]'));
  let active = -2;
  const update = () => {
    const step = anatomyStep();
    if (step === active) return;
    active = step;
    steps.forEach((el, i) => el.classList.toggle('is-active', i === step));
    rail.forEach((el, i) => el.setAttribute('aria-current', String(i === step)));
    ana?.classList.toggle('is-stepping', step >= 0);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

function initStaticAnatomy() {
  document.querySelectorAll('[data-step]').forEach((el) => el.classList.add('is-active'));
}

function run(meter: MeterScene, stage: HTMLElement, coarse: boolean) {
  const hero = document.getElementById('top');
  const ana = document.getElementById('anatomy');
  const fin = document.getElementById('install');
  const tags = Array.from(document.querySelectorAll<HTMLElement>('[data-tag]'));
  const rail = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-rail]'));
  const lead = document.querySelector<SVGLineElement>('[data-lead]');
  const panel = document.querySelector<HTMLElement>('[data-anat-panel]');

  let vw = window.innerWidth;
  let vh = window.innerHeight;
  let wide = vw >= 900;
  let px = 0;
  let py = 0;

  const resize = () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    wide = vw >= 900;
    meter.resize(stage.clientWidth, stage.clientHeight);
  };
  resize();
  window.addEventListener('resize', resize);

  if (!coarse) {
    window.addEventListener(
      'pointermove',
      (e) => {
        px = (e.clientX / Math.max(1, vw) - 0.5) * 2;
        py = (e.clientY / Math.max(1, vh) - 0.5) * 2;
      },
      { passive: true },
    );
  }

  const H = SPEC.camera.hero;
  const heroState = (): StageState => ({
    az: H.azimuth,
    el: H.elevation,
    dist: wide ? H.distance : H.distance * 1.14,
    ty: H.target[2],
    explode: 0,
    shiftX: wide ? H.shiftX ?? 0 : 0,
    shiftY: wide ? 0.02 : 0.18,
    sea: 1,
    stream: 1,
    focus: -1,
    ring: 0,
  });

  const overview = (): StageState => ({
    az: -32,
    el: 21,
    dist: wide ? 10.2 : 13.6,
    ty: layerCenter(2, 1),
    explode: 1,
    shiftX: wide ? 0.2 : 0,
    shiftY: wide ? 0 : 0.16,
    sea: 0.22,
    stream: 0,
    focus: -1,
    ring: 0,
  });

  const focusState = (f: number, p: number): StageState => ({
    az: -30 + p * 38,
    el: 16 + 6 * Math.sin(p * Math.PI),
    dist: wide ? 6.1 : 8.2,
    ty: mix(layerCenter(Math.floor(f), 1), layerCenter(Math.min(N - 1, Math.floor(f) + 1), 1), f - Math.floor(f)),
    explode: 1,
    shiftX: wide ? 0.21 : 0,
    shiftY: wide ? 0 : 0.2,
    sea: 0,
    stream: 0,
    focus: f,
    ring: 1,
  });

  const finale = (): StageState => ({
    az: -12,
    el: 54,
    dist: wide ? 5.8 : 8.2,
    ty: 0.92,
    explode: 0,
    shiftX: wide ? 0.16 : 0,
    shiftY: wide ? 0.08 : 0.26,
    sea: 0.72,
    stream: 0.55,
    focus: -1,
    ring: 0,
  });

  let current = heroState();
  let last = performance.now();
  let time = 0;
  let frames = 0;
  let slow = 0;
  let degraded = false;
  let running = false;
  let raf = 0;

  const rect = (el: HTMLElement | null) => el?.getBoundingClientRect();

  function targetState(): { state: StageState; opacity: number; overviewT: number } {
    const hr = rect(hero);
    const ar = rect(ana);
    const fr = rect(fin);
    let state = heroState();
    let opacity = 1;
    let overviewT = 0;
    let parallax = 1;

    if (hr) {
      const p = clamp(-hr.top / Math.max(1, hr.height));
      state = mixState(heroState(), overview(), smooth(0.05, 1, p));
      overviewT = smooth(0.6, 1, p);
      parallax = 1 - smooth(0.15, 0.85, p);
    }
    if (ar && ar.top <= 0) {
      const total = Math.max(1, ar.height - vh);
      const p = clamp(-ar.top / total);
      const s = clamp((p - 0.06) / 0.94) * N;
      const k = Math.min(N - 1, Math.floor(s));
      const f = N - 1 - Math.min(N - 1, k + smooth(0.7, 1, s - k)); // 自顶层冠冕(4)至底层光阑(0)
      state = mixState(overview(), focusState(f, p), smooth(0.0, 0.07, p));
      overviewT = 1 - smooth(0.02, 0.07, p);
      opacity = clamp(ar.bottom / vh / 0.55);
      parallax = 0;
    }
    if (fr && fr.top < vh && (!ar || ar.bottom <= 0)) {
      const t = clamp(1 - fr.top / vh);
      state = finale();
      opacity = smooth(0.12, 0.78, t) * 0.72;
      overviewT = 0;
      parallax = 0.65;
    }

    if (!coarse && parallax > 0) {
      state = {
        ...state,
        az: state.az + px * 2.8 * parallax,
        el: state.el - py * 1.4 * parallax,
      };
    }
    return { state, opacity, overviewT };
  }

  function frame(now: number) {
    raf = 0;
    const raw = (now - last) / 1000;
    const dt = Math.min(0.05, raw);
    last = now;
    time += dt;

    const { state, opacity, overviewT } = targetState();
    const k = 1 - Math.exp(-dt * 5.5);
    current = mixState(current, state, k);
    stage.style.opacity = String(opacity);

    if (opacity > 0.002) {
      meter.apply(current, time, dt);
      meter.render();
      placeTags(overviewT);
      frames++;
      if (raw > (frames <= 30 ? 0.034 : 0.067)) slow++;
      if (frames > 2 && raw > 0.22 && !degraded) {
        degraded = true;
        meter.dropBloom();
        meter.setPixelRatio(Math.min(meter.pixelRatio, 0.75));
      }
      if (frames === 30) {
        if (slow > 15) {
          meter.dropBloom();
          if (meter.pixelRatio > 1) meter.setPixelRatio(1);
        }
        slow = 0;
      } else if (frames === 90 && slow > 30) {
        meter.setPixelRatio(0.75);
      }
    }

    if (running) raf = requestAnimationFrame(frame);
  }

  function placeTags(overviewT: number) {
    tags.forEach((el) => {
      const i = Number(el.dataset.tag);
      const a = meter.anchor(i, current);
      const w = el.offsetWidth || 220;
      const x = Math.max(16, Math.min(a.x, vw - w - 20));
      const y = clamp(a.y - 14, 72, vh - 40);
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const focusD = Math.abs(i - current.focus);
      const show = Math.max(overviewT, current.focus >= 0 ? clamp(1 - focusD * 1.6) : 0);
      el.style.opacity = String(show);
      el.classList.toggle('is-focus', current.focus >= 0 && focusD < 0.5);
    });
    if (lead && panel && wide) {
      const i = Math.round(current.focus);
      if (current.focus >= 0 && current.ring > 0.3) {
        const a = meter.anchor(i, current, -1);
        const pr = panel.getBoundingClientRect();
        lead.setAttribute('x1', String(pr.right + 16));
        lead.setAttribute('y1', String(pr.top + 42));
        lead.setAttribute('x2', a.x.toFixed(1));
        lead.setAttribute('y2', a.y.toFixed(1));
        lead.style.opacity = String(clamp(current.ring * (1 - Math.abs(current.focus - i) * 2.5)));
      } else {
        lead.style.opacity = '0';
      }
    }
  }

  const setRunning = (on: boolean) => {
    running = on && !document.hidden;
    if (running && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  const visible = new Set<Element>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      setRunning(visible.size > 0);
      if (visible.size === 0) stage.style.opacity = '0';
    },
    { rootMargin: '10% 0px' },
  );
  [hero, ana, fin].forEach((el) => el && io.observe(el));
  document.addEventListener('visibilitychange', () => setRunning(visible.size > 0));

  rail.forEach((btn, i) =>
    btn.addEventListener('click', () => {
      if (!ana) return;
      const docTop = ana.getBoundingClientRect().top + window.scrollY;
      const total = Math.max(1, ana.offsetHeight - vh);
      const p = 0.06 + ((i + 0.5) / N) * 0.94;
      window.scrollTo({ top: docTop + total * p, behavior: 'smooth' });
    }),
  );

  requestAnimationFrame((t) => {
    last = t;
    frame(t);
    stage.classList.add('is-live');
    hero?.classList.add('is-live');
    document.documentElement.classList.add('gl-live');
  });
}
