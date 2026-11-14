/**
 * 多端同步与本地数据边界交互演示（Interactive Sync & Local Boundary Sandbox）
 *
 * 直观展示计然的数据流向与离线/多机切换：
 * - 左侧 4 台设备产生两类数据块：
 *     1) 红色「提示词与本地路径」方块 —— 始终止步于 34% 处的本机采集边界，留在本地磁盘；
 *     2) 青色「Token 计数」与金色「成本差值」 —— 在多机同步模式下发往自建 Docker Hub (:17321)，
 *        再同步至右侧桌面端、网页端与 Android 微件。
 * - 支持切换「自建 Hub 多机同步」与「桌面端仅本机离线模式」。
 * - 支持模拟「笔记本休眠 >10m 标为离线（Stale）」及唤醒后的增量续接。
 */

interface Particle {
  lane: number;
  x: number;
  speed: number;
  kind: 'prompt' | 'token' | 'cost' | 'sse';
  targetLane: number;
  alpha: number;
}

export function initFlowSandbox(root: HTMLElement) {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-flow-canvas]');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const modeBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-flow-mode]')];
  const staleBtn = root.querySelector<HTMLButtonElement>('[data-flow-stale]');
  const statusEl = root.querySelector<HTMLElement>('[data-flow-status]');
  const egressEl = root.querySelector<HTMLElement>('[data-flow-egress]');
  const macBadge = root.querySelector<HTMLElement>('[data-flow-mac-state]');

  const zh = root.dataset.lang !== 'en';
  let mode: 'fleet' | 'local' = 'fleet';
  let laptopStale = false;
  let resumeBurst = 0;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const particles: Particle[] = [];

  let width = 900;
  let height = 310;
  let dpr = 1;
  let running = false;
  let raf = 0;
  let spawnAcc = 0;

  const updateReadout = () => {
    modeBtns.forEach((b) => {
      const on = b.dataset.flowMode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });

    if (staleBtn) {
      staleBtn.classList.toggle('is-stale', laptopStale);
      staleBtn.textContent = laptopStale
        ? staleBtn.dataset.labelWake ?? 'Wake'
        : staleBtn.dataset.labelSleep ?? 'Sleep >10m';
    }

    if (macBadge) {
      macBadge.textContent = laptopStale ? 'STALE >10m' : 'LIVE · 1.5s';
      macBadge.dataset.state = laptopStale ? 'stale' : 'live';
    }

    if (egressEl) {
      egressEl.textContent =
        mode === 'local'
          ? '0.0 KB/s (OFFLINE)'
          : laptopStale
            ? '1.8 KB/s → 127.0.0.1:17321'
            : '2.4 KB/s → 127.0.0.1:17321';
    }

    if (statusEl) {
      if (mode === 'local') {
        statusEl.textContent = statusEl.dataset.msgLocal ?? '';
        statusEl.dataset.tone = 'cyan';
      } else if (laptopStale) {
        statusEl.textContent = statusEl.dataset.msgStale ?? '';
        statusEl.dataset.tone = 'stale';
      } else {
        statusEl.textContent = statusEl.dataset.msgNormal ?? '';
        statusEl.dataset.tone = 'normal';
      }
    }
  };

  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.flowMode === 'local' ? 'local' : 'fleet';
      updateReadout();
      if (reduced) drawFrame(0);
    });
  });

  staleBtn?.addEventListener('click', () => {
    const wasStale = laptopStale;
    laptopStale = !laptopStale;
    if (wasStale && !laptopStale && mode === 'fleet') {
      resumeBurst = 14;
    }
    updateReadout();
    if (reduced) drawFrame(0);
  });

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    width = Math.max(300, Math.floor(r.width));
    height = Math.max(240, Math.floor(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    if (reduced) drawFrame(0);
  };

  const spawn = () => {
    const activeLanes = mode === 'local' ? [0] : laptopStale ? [1, 2] : [0, 1, 2];
    const lane = activeLanes[Math.floor(Math.random() * activeLanes.length)];
    if (Math.random() < 0.52) {
      particles.push({
        lane,
        x: 0.06,
        speed: 0.16 + Math.random() * 0.05,
        kind: 'prompt',
        targetLane: 0,
        alpha: 0.85,
      });
    }
    particles.push({
      lane,
      x: 0.06,
      speed: 0.21 + Math.random() * 0.06,
      kind: Math.random() < 0.76 ? 'token' : 'cost',
      targetLane: Math.floor(Math.random() * 4),
      alpha: 1,
    });
  };

  function drawFrame(dt: number) {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const gateX = width * 0.34;
    const hubX = width * 0.58;
    const outX = width * 0.91;
    const srcX = width * 0.08;
    const laneY = (i: number) => height * (0.2 + i * 0.2);
    const hubY = height * 0.5;

    // 1. 背景辅助线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const gx = (width / 6) * i;
      ctx.beginPath();
      ctx.moveTo(gx, 12);
      ctx.lineTo(gx, height - 12);
      ctx.stroke();
    }

    // 2. 连线路径
    for (let i = 0; i < 4; i++) {
      const y = laneY(i);
      const laneOffline = i === 3 || (i === 0 && laptopStale) || (mode === 'local' && i > 0);

      ctx.strokeStyle = laneOffline ? 'rgba(255,255,255,0.06)' : 'rgba(79,195,247,0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(srcX, y);
      ctx.lineTo(gateX, y);
      ctx.stroke();

      ctx.strokeStyle =
        mode === 'local' || laneOffline ? 'rgba(255,255,255,0.045)' : 'rgba(79,195,247,0.24)';
      ctx.setLineDash(mode === 'local' || laneOffline ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(gateX, y);
      ctx.bezierCurveTo((gateX + hubX) * 0.5, y, (gateX + hubX) * 0.5, hubY, hubX, hubY);
      ctx.stroke();
      ctx.setLineDash([]);

      const localDesktopOnly = mode === 'local' && i === 0;
      ctx.strokeStyle =
        mode === 'fleet'
          ? 'rgba(79,195,247,0.2)'
          : localDesktopOnly
            ? 'rgba(79,195,247,0.34)'
            : 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      if (localDesktopOnly) {
        ctx.moveTo(gateX, laneY(0));
        ctx.lineTo(outX, laneY(0));
      } else {
        ctx.moveTo(hubX, hubY);
        ctx.bezierCurveTo((hubX + outX) * 0.5, hubY, (hubX + outX) * 0.5, y, outX, y);
      }
      ctx.stroke();
    }

    // 3. 本机采集边界（仅提取统计数字，原始记录留盘）
    ctx.strokeStyle = 'rgba(79, 195, 247, 0.52)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(gateX, 20);
    ctx.lineTo(gateX, height - 18);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < 4; i++) {
      const y = laneY(i);
      ctx.fillStyle = '#0e1118';
      ctx.strokeStyle = 'rgba(79, 195, 247, 0.68)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(gateX - 5, y - 7, 10, 14, 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = '#4fc3f7';
    ctx.font = '600 10px "JetBrains Mono Variable", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(zh ? '本机边界 · 仅传计数' : 'LOCAL BOUNDARY · COUNTS ONLY', gateX, 13);

    // 4. 更新与绘制数据块
    if (!reduced && dt > 0) {
      spawnAcc += dt;
      while (spawnAcc > 0.24) {
        spawnAcc -= 0.24;
        if (particles.length < 72) spawn();
      }
      if (resumeBurst > 0) {
        resumeBurst--;
        particles.push({
          lane: 0,
          x: 0.08 + Math.random() * 0.06,
          speed: 0.3,
          kind: resumeBurst % 3 === 0 ? 'cost' : 'token',
          targetLane: resumeBurst % 4,
          alpha: 1,
        });
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.speed * dt;

        // 提示词与本地路径留在设备端，越界前淡出过滤
        if (p.kind === 'prompt' && p.x >= 0.33) {
          particles.splice(i, 1);
          continue;
        }

        if (mode === 'local' && p.x >= 0.91) {
          particles.splice(i, 1);
          continue;
        }

        if (mode === 'fleet' && p.kind !== 'sse' && p.x >= 0.58) {
          p.kind = 'sse';
        }

        if (p.x >= 0.91) {
          particles.splice(i, 1);
        }
      }
    }

    const drawList: Particle[] = reduced
      ? [
          { lane: 0, x: 0.21, speed: 0, kind: 'prompt', targetLane: 0, alpha: 0.85 },
          { lane: 1, x: 0.27, speed: 0, kind: 'token', targetLane: 1, alpha: 1 },
          { lane: 1, x: 0.46, speed: 0, kind: 'token', targetLane: 0, alpha: 1 },
          { lane: 2, x: 0.51, speed: 0, kind: 'cost', targetLane: 2, alpha: 1 },
          { lane: 0, x: 0.76, speed: 0, kind: 'sse', targetLane: 0, alpha: 1 },
          { lane: 2, x: 0.82, speed: 0, kind: 'sse', targetLane: 3, alpha: 1 },
        ]
      : particles;

    for (const p of drawList) {
      const px = p.x * width;
      let py = laneY(p.lane);
      if (mode === 'local' && p.x > 0.34) {
        py = laneY(0);
      } else if (p.x > 0.34 && p.x <= 0.58) {
        const t = (p.x - 0.34) / 0.24;
        const s = t * t * (3 - 2 * t);
        py = py + (hubY - py) * s;
      } else if (p.x > 0.58) {
        const t = (p.x - 0.58) / 0.33;
        const s = t * t * (3 - 2 * t);
        const ty = laneY(p.targetLane);
        py = hubY + (ty - hubY) * s;
      }

      if (p.kind === 'prompt') {
        const fade = p.x > 0.26 ? Math.max(0, 1 - (p.x - 0.26) / 0.07) : 1;
        ctx.fillStyle = `rgba(239, 90, 82, ${0.72 * p.alpha * fade})`;
        ctx.fillRect(px - 4, py - 2, 7, 4);
      } else if (p.kind === 'cost') {
        ctx.fillStyle = '#e5a94c';
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#4fc3f7';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5. 中央自建 Docker Hub 节点
    const hubActive = mode === 'fleet';
    ctx.fillStyle = hubActive ? '#141923' : '#0e1118';
    ctx.strokeStyle = hubActive ? '#4fc3f7' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(hubX - 56, hubY - 30, 112, 60, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = hubActive ? '#eef1f6' : '#636c7d';
    ctx.font = '600 11px "Instrument Sans Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(hubActive ? 'DOCKER HUB' : 'LOCAL ONLY', hubX, hubY - 7);
    ctx.fillStyle = hubActive ? '#4fc3f7' : '#636c7d';
    ctx.font = '500 9.5px "JetBrains Mono Variable", monospace';
    ctx.fillText(hubActive ? ':17321 · MySQL 8' : 'NO SYNC TRAFFIC', hubX, hubY + 10);
    ctx.fillStyle = hubActive ? '#e5a94c' : '#636c7d';
    ctx.fillText('AES-256-GCM', hubX, hubY + 23);
  }

  let last = performance.now();
  const loop = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    drawFrame(dt);
    if (running) raf = requestAnimationFrame(loop);
  };

  const setRunning = (on: boolean) => {
    running = on && !reduced && !document.hidden;
    if (running && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) setRunning(e.isIntersecting);
    },
    { rootMargin: '80px 0px' },
  );
  io.observe(root);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => setRunning(running));

  updateReadout();
  resize();
}
