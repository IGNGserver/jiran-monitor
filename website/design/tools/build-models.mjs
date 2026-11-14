#!/usr/bin/env node
/**
 * 由 design/tokens.json 参数化构建四组「Token 词元」主题三维模型，导出并经 gltfpack (meshopt) 压缩至 public/models/*.glb：
 *   - hero.glb   首屏：词元切分流与本地四栏账本归集
 *   - mix.glb    功能一：五维词元构成积木与三模型单价对照柱
 *   - quota.glb  功能二：双窗口订阅配额环（5h / 周）与物理隔离的原生 Credits 词元牌
 *   - hub.glb    多端与隐私：本地原始记录留盘，纯净词元增量汇入自建 Docker Hub 并分发至手机微件
 *
 * 用法（在本地构建区 $BUILD_SCRATCH_ROOT 内执行）：
 *   node design/tools/build-models.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((ab) => {
        this.result = ab;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((ab) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(ab).toString('base64')}`;
        this.onloadend?.();
      });
    }
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(readFileSync(path.join(root, 'design/tokens.json'), 'utf8'));
const P = spec.palette;

function makeMaterials() {
  const std = (name, hex, metalness, roughness, emitHex = null, emitIntensity = 0) => {
    const m = new THREE.MeshStandardMaterial({
      name,
      color: new THREE.Color(hex),
      metalness,
      roughness,
    });
    if (emitHex) {
      m.emissive = new THREE.Color(emitHex);
      m.emissiveIntensity = emitIntensity;
    }
    return m;
  };

  return {
    base_dark: std('base_dark', P.baseDark, 0.72, 0.42),
    frame_metal: std('frame_metal', P.frameMetal, 0.86, 0.25),
    raw_slate: std('raw_slate', P.rawSlate, 0.38, 0.52),
    cyan_tile: std('cyan_tile', '#3ab4e8', 0.28, 0.22, P.cyan, 0.16),
    cyan_deep: std('cyan_deep', P.cyanDeep, 0.36, 0.26, P.cyan, 0.12),
    glass_cyan: std('glass_cyan', '#6bd4ff', 0.08, 0.12, P.cyan, 0.18),
    platinum_tile: std('platinum_tile', P.platinum, 0.42, 0.18, '#ffffff', 0.06),
    brass_tile: std('brass_tile', P.brass, 0.74, 0.21, P.brass, 0.14),
    cyan_glow: std('cyan_glow', P.cyan, 0.05, 0.2, P.cyan, 1.45),
    gold_glow: std('gold_glow', P.brass, 0.1, 0.2, P.brass, 1.35),
    amber_glow: std('amber_glow', P.amber, 0.08, 0.22, P.amber, 1.4),
  };
}

/** 构造一枚带圆角倒角与顶部语素刻槽条的立体「词元切块（Token Tile）」 */
function createTokenBrick(w, h, d, bodyMat, barMat, opts = {}) {
  const g = new THREE.Group();
  const radius = Math.min(w, h, d) * 0.18;
  const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), bodyMat);
  g.add(body);

  if (opts.carrier !== false) {
    const basePlate = new THREE.Mesh(
      new RoundedBoxGeometry(w * 0.94, Math.max(0.018, h * 0.16), d * 0.94, 2, 0.006),
      opts.carrierMat,
    );
    basePlate.position.y = -h * 0.48;
    g.add(basePlate);
  }

  if (barMat) {
    const barW = w * (opts.barRatio ?? 0.58);
    const bar = new THREE.Mesh(
      new RoundedBoxGeometry(barW, 0.018, Math.min(0.065, d * 0.22), 2, 0.006),
      barMat,
    );
    bar.position.set(-w * 0.08, h * 0.5 + 0.006, 0);
    g.add(bar);

    if (w >= 0.48) {
      const dot = new THREE.Mesh(new RoundedBoxGeometry(0.045, 0.018, 0.045, 2, 0.008), barMat);
      dot.position.set(w * 0.31, h * 0.5 + 0.006, 0);
      g.add(dot);
    }
  }
  return g;
}

/** 构造精密倒角底座托盘 */
function createBaseTray(w, h, d, mats) {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, 0.035), mats.base_dark);
  slab.position.y = h / 2;
  g.add(slab);

  const rimThickness = 0.045;
  const rimH = 0.026;
  const front = new THREE.Mesh(new RoundedBoxGeometry(w + 0.02, rimH, rimThickness, 2, 0.008), mats.frame_metal);
  front.position.set(0, h + rimH * 0.35, d / 2 - rimThickness / 2);
  const back = front.clone();
  back.position.z = -d / 2 + rimThickness / 2;
  const left = new THREE.Mesh(new RoundedBoxGeometry(rimThickness, rimH, d - rimThickness * 2, 2, 0.008), mats.frame_metal);
  left.position.set(-w / 2 + rimThickness / 2, h + rimH * 0.35, 0);
  const right = left.clone();
  right.position.x = w / 2 - rimThickness / 2;
  g.add(front, back, left, right);
  return g;
}

/** 1. 首屏模型：词元切分流 → 本地四栏账本归集 */
function buildHeroScene() {
  const mats = makeMaterials();
  const scene = new THREE.Scene();
  const rootGroup = new THREE.Group();
  rootGroup.name = 'model_root';

  const baseH = 0.13;
  rootGroup.add(createBaseTray(3.68, baseH, 2.16, mats));

  const cfg = spec.models.hero;

  // 左侧 4 条词元滑轨与流动词元块（stream_0..stream_11）
  const brickPatterns = [
    [
      { w: 0.42, x: -1.48, kind: 'raw' },
      { w: 0.56, x: -0.92, kind: 'raw' },
      { w: 0.44, x: -0.44, kind: 'cyan' },
    ],
    [
      { w: 0.62, x: -1.38, kind: 'raw' },
      { w: 0.38, x: -0.78, kind: 'raw' },
      { w: 0.48, x: -0.36, kind: 'glass' },
    ],
    [
      { w: 0.46, x: -1.52, kind: 'raw' },
      { w: 0.58, x: -0.96, kind: 'raw' },
      { w: 0.40, x: -0.42, kind: 'platinum' },
    ],
    [
      { w: 0.52, x: -1.42, kind: 'raw' },
      { w: 0.40, x: -0.86, kind: 'raw' },
      { w: 0.46, x: -0.38, kind: 'brass' },
    ],
  ];

  let streamIdx = 0;
  cfg.streamLanesZ.forEach((z, laneIdx) => {
    const rail = new THREE.Mesh(new RoundedBoxGeometry(1.58, 0.024, 0.06, 2, 0.008), mats.frame_metal);
    rail.position.set(-0.98, baseH + 0.015, z);
    rootGroup.add(rail);

    for (const item of brickPatterns[laneIdx]) {
      const bMat =
        item.kind === 'cyan'
          ? mats.cyan_tile
          : item.kind === 'glass'
            ? mats.glass_cyan
            : item.kind === 'platinum'
              ? mats.platinum_tile
              : item.kind === 'brass'
                ? mats.brass_tile
                : mats.raw_slate;
      const barMat =
        item.kind === 'raw' ? mats.frame_metal : item.kind === 'brass' ? mats.gold_glow : mats.cyan_glow;
      const brick = createTokenBrick(item.w, 0.11, 0.28, bMat, barMat, { carrierMat: mats.frame_metal });
      brick.name = `stream_${streamIdx}`;
      brick.position.set(item.x, baseH + 0.095, z);
      rootGroup.add(brick);
      streamIdx++;
    }
  });

  // 中央本地解析门框（Local Parse Frame）
  const gate = new THREE.Group();
  gate.name = 'parse_gate';
  const postL = new THREE.Mesh(new RoundedBoxGeometry(0.065, 0.62, 0.085, 2, 0.014), mats.frame_metal);
  postL.position.set(cfg.gateX, baseH + 0.31, -0.92);
  const postR = postL.clone();
  postR.position.z = 0.92;
  const beam = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.065, 1.92, 2, 0.014), mats.frame_metal);
  beam.position.set(cfg.gateX, baseH + 0.61, 0);
  const scanBar = new THREE.Mesh(new RoundedBoxGeometry(0.024, 0.024, 1.76, 2, 0.008), mats.cyan_glow);
  scanBar.name = 'scan_bar';
  scanBar.position.set(cfg.gateX, baseH + 0.565, 0);
  const floorLine = new THREE.Mesh(new RoundedBoxGeometry(0.022, 0.014, 1.82, 2, 0.005), mats.cyan_glow);
  floorLine.position.set(cfg.gateX, baseH + 0.01, 0);
  gate.add(postL, postR, beam, scanBar, floorLine);
  rootGroup.add(gate);

  // 右侧四组分类归集词元柱阵（Cache Read / Input / Output / Cost & Credits）
  const divider = new THREE.Mesh(new RoundedBoxGeometry(1.52, 0.026, 0.028, 2, 0.008), mats.frame_metal);
  divider.position.set(0.80, baseH + 0.015, 0.03);
  rootGroup.add(divider);

  cfg.stacks.forEach((st, sIdx) => {
    const pad = new THREE.Mesh(new RoundedBoxGeometry(st.w + 0.1, 0.028, st.d + 0.1, 2, 0.01), mats.frame_metal);
    pad.position.set(st.x, baseH + 0.014, st.z);
    rootGroup.add(pad);

    const stackGroup = new THREE.Group();
    stackGroup.name = `stack_${sIdx}`;
    stackGroup.position.set(st.x, baseH + 0.03, st.z);

    const tileMat = mats[st.mat];
    const topBarMat = st.mat === 'brass_tile' ? mats.gold_glow : st.mat === 'platinum_tile' ? mats.cyan_tile : mats.cyan_glow;

    for (let i = 0; i < st.count; i++) {
      const isTop = i === st.count - 1;
      const tile = createTokenBrick(st.w, st.h, st.d, tileMat, isTop ? topBarMat : null, {
        carrier: i === 0,
        carrierMat: mats.frame_metal,
        barRatio: 0.52,
      });
      tile.position.y = i * (st.h + 0.022) + st.h / 2;
      stackGroup.add(tile);
    }
    rootGroup.add(stackGroup);
  });

  scene.add(rootGroup);
  return scene;
}

/** 2. 功能一模型：五维词元构成积木条 + 三款模型并排成本对照柱 */
function buildMixScene() {
  const mats = makeMaterials();
  const scene = new THREE.Scene();
  const rootGroup = new THREE.Group();
  rootGroup.name = 'model_root';

  const baseH = 0.12;
  rootGroup.add(createBaseTray(3.42, baseH, 2.08, mats));

  const cfg = spec.models.mix;
  const gap = 0.055;
  const totalW = cfg.segments.reduce((s, x) => s + x.w, 0) + gap * (cfg.segments.length - 1);
  let cursorX = -totalW / 2;

  // 前排：五维词元拆分积木条（Cache Read 叠片 / Input / Uncached / Cache Write / Output）
  const cradleBar = new THREE.Mesh(new RoundedBoxGeometry(totalW + 0.16, 0.032, 0.62, 2, 0.012), mats.frame_metal);
  cradleBar.position.set(0, baseH + 0.018, 0.46);
  rootGroup.add(cradleBar);

  cfg.segments.forEach((seg, idx) => {
    const cx = cursorX + seg.w / 2;
    cursorX += seg.w + gap;

    const segGroup = new THREE.Group();
    segGroup.name = `seg_${idx}`;
    segGroup.position.set(cx, baseH + 0.04, 0.46);

    const mat = mats[seg.mat];
    const barMat = seg.mat === 'platinum_tile' ? mats.cyan_tile : mats.cyan_glow;

    if (seg.layers > 1) {
      // Cache Read 用 5 层半透明薄晶片表现高复用率
      const waferH = 0.058;
      for (let l = 0; l < seg.layers; l++) {
        const wafer = createTokenBrick(seg.w, waferH, 0.52, mat, l === seg.layers - 1 ? barMat : null, {
          carrier: l === 0,
          carrierMat: mats.frame_metal,
        });
        wafer.position.y = l * (waferH + 0.016) + waferH / 2;
        segGroup.add(wafer);
      }
    } else {
      const blockH = 0.34;
      const block = createTokenBrick(seg.w, blockH, 0.52, mat, barMat, {
        carrier: true,
        carrierMat: mats.frame_metal,
      });
      block.position.y = blockH / 2;
      segGroup.add(block);
    }
    rootGroup.add(segGroup);
  });

  // 后排：三款主力模型并排对比台（左青色词元量叠块 vs 右暖金百万单价柱）
  cfg.columns.forEach((col, idx) => {
    const colGroup = new THREE.Group();
    colGroup.name = `col_${idx}`;
    colGroup.position.set(col.x, baseH + 0.02, -0.38);

    const plinth = new THREE.Mesh(new RoundedBoxGeometry(0.78, 0.035, 0.64, 2, 0.012), mats.frame_metal);
    plinth.position.y = 0.018;
    colGroup.add(plinth);

    const tileH = 0.088;
    for (let k = 0; k < col.tokens; k++) {
      const m = k < col.tokens - 2 ? mats.glass_cyan : k === col.tokens - 1 ? mats.platinum_tile : mats.cyan_tile;
      const t = new THREE.Mesh(new RoundedBoxGeometry(0.34, tileH, 0.42, 3, 0.018), m);
      t.position.set(-0.16, 0.045 + k * (tileH + 0.016) + tileH / 2, 0);
      colGroup.add(t);
    }

    const costBar = createTokenBrick(0.26, col.costH, 0.38, mats.brass_tile, mats.gold_glow, {
      carrier: true,
      carrierMat: mats.frame_metal,
      barRatio: 0.5,
    });
    costBar.position.set(0.19, 0.045 + col.costH / 2, 0);
    colGroup.add(costBar);

    rootGroup.add(colGroup);
  });

  scene.add(rootGroup);
  return scene;
}

/** 3. 功能二模型：双窗口配额环（周 + 5h）与独立隔离的原生 Credits 词元牌 */
function buildQuotaScene() {
  const mats = makeMaterials();
  const scene = new THREE.Scene();
  const rootGroup = new THREE.Group();
  rootGroup.name = 'model_root';

  // 左右两座物理分离的底座（强化原生 Credits 与 Token/USD 严格分账）
  const leftTray = createBaseTray(1.96, 0.12, 1.92, mats);
  leftTray.position.set(-0.68, 0, 0);
  rootGroup.add(leftTray);

  const rightTray = createBaseTray(1.36, 0.12, 1.92, mats);
  rightTray.position.set(1.08, 0, 0);
  rootGroup.add(rightTray);

  // 左侧前缘：ISO 周一至周日 7 格日历刻度条
  for (let d = 0; d < 7; d++) {
    const tick = new THREE.Mesh(
      new RoundedBoxGeometry(0.19, 0.042, 0.12, 2, 0.01),
      d < 5 ? mats.cyan_tile : mats.raw_slate,
    );
    tick.position.set(-0.68 + (d - 3) * 0.23, 0.145, 0.74);
    rootGroup.add(tick);
  }

  // 左侧：倾斜式双窗口配额环（外圈周限额分段块 + 内圈 5h 滚动窗口 + 临界提醒段）
  const dialGroup = new THREE.Group();
  dialGroup.name = 'quota_dial';
  dialGroup.position.set(-0.68, 0.54, -0.06);
  dialGroup.rotation.x = -0.78;

  const backing = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.78, 0.06, 48), mats.frame_metal);
  backing.rotation.x = Math.PI / 2;
  backing.position.z = -0.04;
  dialGroup.add(backing);

  const totalSegs = 16;
  const activeSegs = 11;
  for (let i = 0; i < totalSegs; i++) {
    const ang = (i / totalSegs) * Math.PI * 2 + Math.PI * 0.65;
    const segMat = i < activeSegs ? mats.cyan_tile : mats.raw_slate;
    const seg = new THREE.Mesh(new RoundedBoxGeometry(0.19, 0.09, 0.09, 2, 0.018), segMat);
    const r = 0.62;
    seg.position.set(Math.cos(ang) * r, Math.sin(ang) * r, 0.02);
    seg.rotation.z = ang + Math.PI / 2;
    dialGroup.add(seg);
  }

  const innerArc = new THREE.Mesh(
    new THREE.TorusGeometry(0.41, 0.042, 16, 56, Math.PI * 1.18),
    mats.glass_cyan,
  );
  innerArc.name = 'quota_arc_5h';
  innerArc.rotation.z = Math.PI * 0.55;
  innerArc.position.z = 0.035;
  dialGroup.add(innerArc);

  const warnTip = new THREE.Mesh(
    new THREE.TorusGeometry(0.41, 0.048, 16, 20, Math.PI * 0.28),
    mats.amber_glow,
  );
  warnTip.rotation.z = Math.PI * 1.76;
  warnTip.position.z = 0.04;
  dialGroup.add(warnTip);

  // 中央简洁 T 字词元锚点
  const tStem = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.28, 0.06, 2, 0.015), mats.platinum_tile);
  tStem.position.set(0, -0.04, 0.035);
  const tTop = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.075, 0.06, 2, 0.015), mats.platinum_tile);
  tTop.position.set(0, 0.09, 0.035);
  dialGroup.add(tStem, tTop);

  rootGroup.add(dialGroup);

  // 右侧独立托盘：原生 Credits 金色词元叠牌 + 固定月费 vs API 等效柱
  const creditsPedestal = new THREE.Mesh(new RoundedBoxGeometry(0.76, 0.04, 0.72, 2, 0.012), mats.frame_metal);
  creditsPedestal.position.set(1.08, 0.14, 0.34);
  rootGroup.add(creditsPedestal);

  for (let i = 0; i < 4; i++) {
    const plaque = createTokenBrick(0.58, 0.095, 0.52, mats.brass_tile, i === 3 ? mats.gold_glow : null, {
      carrier: i === 0,
      carrierMat: mats.frame_metal,
    });
    if (i === 3) {
      plaque.name = 'credits_top';
      plaque.position.set(1.08, 0.22 + i * 0.118 + 0.05, 0.34);
    } else {
      plaque.position.set(1.08, 0.22 + i * 0.112, 0.34);
    }
    rootGroup.add(plaque);
  }

  // 后方：固定套餐块 vs API 等效成本块
  const planBlock = createTokenBrick(0.42, 0.38, 0.44, mats.platinum_tile, mats.cyan_tile, {
    carrier: true,
    carrierMat: mats.frame_metal,
  });
  planBlock.position.set(0.84, 0.33, -0.44);
  const apiEquivBlock = createTokenBrick(0.42, 0.62, 0.44, mats.brass_tile, mats.gold_glow, {
    carrier: true,
    carrierMat: mats.frame_metal,
  });
  apiEquivBlock.position.set(1.34, 0.45, -0.44);
  rootGroup.add(planBlock, apiEquivBlock);

  scene.add(rootGroup);
  return scene;
}

/** 4. 架构与多端模型：本地保留原始记录，纯净词元增量块汇入自建 Docker Hub 并分发手机微件 */
function buildHubScene() {
  const mats = makeMaterials();
  const scene = new THREE.Scene();
  const rootGroup = new THREE.Group();
  rootGroup.name = 'model_root';

  const baseH = 0.12;
  rootGroup.add(createBaseTray(3.72, baseH, 2.26, mats));

  const cfg = spec.models.hub;
  const [hx, hy, hz] = cfg.hubPos;

  // 中央三层自建 Docker Compose Hub 立方体（HTTP/PWA 层 · AES 密钥金库层 · MySQL 账本层）
  const hubGroup = new THREE.Group();
  hubGroup.name = 'hub_core';
  hubGroup.position.set(hx, hy, hz);

  const hubPedestal = new THREE.Mesh(new RoundedBoxGeometry(1.04, 0.05, 1.04, 2, 0.015), mats.frame_metal);
  hubPedestal.position.y = 0.025;
  hubGroup.add(hubPedestal);

  const tierMats = [mats.cyan_deep, mats.brass_tile, mats.glass_cyan];
  for (let t = 0; t < 3; t++) {
    const slab = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.155, 0.86, 3, 0.028), tierMats[t]);
    slab.position.y = 0.14 + t * 0.195;
    hubGroup.add(slab);
  }
  const topCap = createTokenBrick(0.52, 0.06, 0.52, mats.platinum_tile, mats.cyan_glow, { carrier: false });
  topCap.position.y = 0.65;
  hubGroup.add(topCap);
  rootGroup.add(hubGroup);

  // 左侧 3 台在线采集终端 + 1 台 >10m 离线置灰终端（底座均留有本地深色原始会话块，绝不离开设备）
  const producers = [
    { pos: [-1.42, baseH, 0.68], kind: 'laptop', live: true },
    { pos: [-1.52, baseH, -0.08], kind: 'wsl', live: true },
    { pos: [-1.26, baseH, -0.78], kind: 'server', live: true },
    { pos: [-0.52, baseH, -0.88], kind: 'stale', live: false },
  ];

  producers.forEach((p, idx) => {
    const node = new THREE.Group();
    node.name = `device_${idx}`;
    node.position.set(...p.pos);

    const pad = new THREE.Mesh(new RoundedBoxGeometry(0.56, 0.036, 0.48, 2, 0.01), mats.frame_metal);
    pad.position.y = 0.018;
    node.add(pad);

    if (p.kind === 'laptop' || p.kind === 'stale') {
      const screen = new THREE.Mesh(
        new RoundedBoxGeometry(0.42, 0.26, 0.03, 2, 0.008),
        p.live ? mats.cyan_deep : mats.raw_slate,
      );
      screen.position.set(-0.04, 0.16, -0.14);
      screen.rotation.x = 0.22;
      node.add(screen);
    } else if (p.kind === 'wsl') {
      const hostBox = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.12, 0.34, 2, 0.015), mats.base_dark);
      hostBox.position.y = 0.095;
      const wslBox = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.10, 0.28, 2, 0.015), mats.cyan_tile);
      wslBox.position.y = 0.215;
      node.add(hostBox, wslBox);
    } else {
      for (let b = 0; b < 2; b++) {
        const blade = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.085, 0.34, 2, 0.012), mats.frame_metal);
        blade.position.y = 0.08 + b * 0.105;
        node.add(blade);
      }
    }

    // 永远留在本地磁盘的原始对话文本条（raw_slate）
    for (let r = 0; r < 2; r++) {
      const localTranscript = new THREE.Mesh(new RoundedBoxGeometry(0.18, 0.032, 0.08, 2, 0.006), mats.raw_slate);
      localTranscript.position.set(-0.1 + r * 0.2, 0.052, 0.14);
      node.add(localTranscript);
    }

    const dot = new THREE.Mesh(
      new RoundedBoxGeometry(0.055, 0.025, 0.055, 2, 0.008),
      p.live ? mats.cyan_glow : mats.raw_slate,
    );
    dot.position.set(0.2, 0.046, 0.16);
    node.add(dot);

    rootGroup.add(node);
  });

  // 右侧：Android 只读伴侣端与 5 款主屏微件（今日 / 额度 / 趋势 / 仪表盘 / 热门模型）
  const phone = new THREE.Group();
  phone.name = 'android_surface';
  phone.position.set(1.42, baseH + 0.22, 0.16);
  phone.rotation.z = 0.28;
  phone.rotation.y = -0.32;

  const chassis = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.05, 0.84, 3, 0.02), mats.frame_metal);
  phone.add(chassis);

  const widgets = [
    { x: -0.09, z: -0.24, w: 0.18, d: 0.20, mat: mats.cyan_tile },
    { x: 0.10, z: -0.24, w: 0.18, d: 0.20, mat: mats.brass_tile },
    { x: 0.0, z: 0.0, w: 0.37, d: 0.18, mat: mats.glass_cyan },
    { x: -0.09, z: 0.22, w: 0.18, d: 0.18, mat: mats.platinum_tile },
    { x: 0.10, z: 0.22, w: 0.18, d: 0.18, mat: mats.cyan_deep },
  ];
  for (const wg of widgets) {
    const tile = new THREE.Mesh(new RoundedBoxGeometry(wg.w, 0.028, wg.d, 2, 0.008), wg.mat);
    tile.position.set(wg.x, 0.036, wg.z);
    phone.add(tile);
  }
  rootGroup.add(phone);

  // 4 条同步弧线导轨 + 8 枚沿弧线运动的纯净整数词元块（pkt_0..pkt_7）
  cfg.routes.forEach((rt, rIdx) => {
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(...rt.from),
      new THREE.Vector3(...rt.mid),
      new THREE.Vector3(...rt.to),
    );
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.011, 8, false), mats.frame_metal);
    rootGroup.add(tube);

    for (let k = 0; k < 2; k++) {
      const pIdx = rIdx * 2 + k;
      const pMat = rt.tone === 'brass' && k === 0 ? mats.gold_glow : mats.cyan_glow;
      const pkt = new THREE.Mesh(new RoundedBoxGeometry(0.082, 0.062, 0.082, 2, 0.016), pMat);
      pkt.name = `pkt_${pIdx}`;
      const pt = curve.getPoint((k * 0.5 + rIdx * 0.17) % 1);
      pkt.position.copy(pt);
      rootGroup.add(pkt);
    }
  });

  scene.add(rootGroup);
  return scene;
}

const builders = {
  hero: buildHeroScene,
  mix: buildMixScene,
  quota: buildQuotaScene,
  hub: buildHubScene,
};

const outDir = path.join(root, 'public/models');
const tmpDir = path.join(root, '.tmp-models');
mkdirSync(outDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const exporter = new GLTFExporter();
const gltfpack = path.join(root, 'node_modules/.bin/gltfpack');

for (const [id, buildFn] of Object.entries(builders)) {
  const scene = buildFn();
  scene.updateMatrixWorld(true);
  const rawBuf = Buffer.from(await exporter.parseAsync(scene, { binary: true }));
  const rawPath = path.join(tmpDir, `${id}_raw.glb`);
  const outPath = path.join(outDir, `${id}.glb`);
  writeFileSync(rawPath, rawBuf);
  execFileSync(gltfpack, ['-i', rawPath, '-o', outPath, '-cc', '-kn', '-km'], { stdio: 'inherit' });
  console.log(`[models] ${id}.glb -> ${(statSync(outPath).size / 1024).toFixed(1)} KB`);
}

rmSync(tmpDir, { recursive: true, force: true });
