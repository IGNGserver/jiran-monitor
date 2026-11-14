/**
 * 轻量三维视口引导器（首屏体积 < 2 KB）：
 * - 若 URL 含 ?still=<key>，立即按确定性姿态渲染高清母版静帧供 design/tools/stills.mjs 采集；
 * - 若系统开启 prefers-reduced-motion: reduce 或环境不支持 WebGL，标记 html.no-gl，全程展示高清静态图；
 * - 否则在首屏 load 后的空闲时机动态 import('./runtime')，按视口可见性懒加载四组 Token 三维模型。
 */
function canUseWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const stillKey = new URLSearchParams(window.location.search).get('still');

if (stillKey) {
  import('./runtime').then((m) => m.renderStillFromQuery(stillKey));
} else {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !canUseWebGL()) {
    document.documentElement.classList.add('no-gl');
  } else {
    const start = () => {
      const idle =
        'requestIdleCallback' in window
          ? (cb: () => void) =>
              (window as Window & { requestIdleCallback: (fn: () => void, opts?: { timeout: number }) => number })
                .requestIdleCallback(cb, { timeout: 900 })
          : (cb: () => void) => window.setTimeout(cb, 120);
      idle(() => {
        import('./runtime')
          .then((m) => m.mountModelStages())
          .catch(() => document.documentElement.classList.add('no-gl'));
      });
    };

    if (document.readyState === 'complete') {
      start();
    } else {
      window.addEventListener('load', start, { once: true });
    }
  }
}
