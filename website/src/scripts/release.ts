/**
 * 下载入口的客户端部分：
 * 1. 读构建时烘焙的发布信息（#release-data）；
 * 2. 按访客系统挑一个直链给首屏主按钮，并在「取」一节预选对应平台；
 * 3. 后台向 GitHub 刷新一次「当前正式版」，失败就保留烘焙值（本站唯一的外部请求）。
 */
import { findStableRelease, RELEASE_SEGMENT, type ReleaseInfo } from '../data/release';
import { REPO_URL, type AssetKey } from '../data/product';

/** Build the href from repository constants plus validated segments; never assign API URLs. */
function setAssetHref(anchor: HTMLAnchorElement, tag: string, name: string) {
  if (!RELEASE_SEGMENT.test(tag) || !RELEASE_SEGMENT.test(name)) return;
  anchor.href = `${REPO_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function setReleaseHref(anchor: HTMLAnchorElement, tag: string) {
  if (!RELEASE_SEGMENT.test(tag)) return;
  anchor.href = `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
}

type Platform = 'mac' | 'win' | 'linux' | 'android' | 'server';
const PRIMARY: Record<Platform, AssetKey> = {
  mac: 'macArm',
  win: 'winSetup',
  linux: 'appImage',
  android: 'android',
  server: 'headless',
};
const LABEL: Record<Platform, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux', android: 'Android', server: 'Server' };

export function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return null; // 没有 iOS 客户端
  if (/mac/i.test(uaPlatform) || /Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/win/i.test(uaPlatform) || /Windows/.test(ua)) return 'win';
  if (/linux|cros/i.test(uaPlatform) || /Linux|X11/.test(ua)) return 'linux';
  return null;
}

function readBaked(): ReleaseInfo | null {
  const el = document.getElementById('release-data');
  try {
    return el?.textContent ? (JSON.parse(el.textContent) as ReleaseInfo | null) : null;
  } catch {
    return null;
  }
}

/** 页面 load 之后、浏览器空闲时再执行；不支持 requestIdleCallback 的浏览器（Safari）退回短延时 */
function afterLoad(fn: () => void) {
  const idle = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => fn(), { timeout: 1200 });
    else setTimeout(fn, 300);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

const CACHE_KEY = 'jiran-release-v1';
async function refresh(repo: string): Promise<ReleaseInfo | null> {
  try {
    const hit = sessionStorage.getItem(CACHE_KEY);
    if (hit) return JSON.parse(hit) as ReleaseInfo;
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 */
  }
  const info = await findStableRelease(
    repo,
    { Accept: 'application/vnd.github+json' },
    fetch,
    AbortSignal.timeout(6000),
  );
  try {
    if (info) sessionStorage.setItem(CACHE_KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
  return info;
}

function apply(info: ReleaseInfo | null, platform: Platform | null) {
  // 「取」一节里每个资产链接
  document.querySelectorAll<HTMLAnchorElement>('[data-asset]').forEach((a) => {
    const asset = info?.assets[a.dataset.asset as AssetKey];
    if (!info || !asset) return;
    setAssetHref(a, info.tag, asset.name);
    a.removeAttribute('aria-disabled');
    const name = a.querySelector('[data-asset-name]');
    if (name) name.textContent = asset.name;
    const size = a.querySelector('[data-asset-size]');
    if (size) size.textContent = `${(asset.size / 1048576).toFixed(asset.size > 1048576 * 10 ? 0 : 1)} MB`;
  });
  document.querySelectorAll<HTMLElement>('[data-release-tag]').forEach((el) => {
    if (info) el.textContent = info.tag;
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-release-url]').forEach((a) => {
    if (info) setReleaseHref(a, info.tag);
  });
  document.querySelectorAll<HTMLTimeElement>('[data-release-date]').forEach((el) => {
    if (!info) return;
    el.dateTime = info.publishedAt;
    el.textContent = info.publishedAt.slice(0, 10);
  });

  // 首屏主按钮
  const primary = document.querySelector<HTMLAnchorElement>('[data-dl-primary]');
  const meta = document.querySelector<HTMLElement>('[data-dl-meta]');
  const asset = platform && info ? info.assets[PRIMARY[platform]] : undefined;
  if (primary && asset && platform && info) {
    setAssetHref(primary, info.tag, asset.name);
    if (meta) meta.textContent = `${LABEL[platform]} · ${info.tag}`;
  } else if (meta && info) {
    meta.textContent = info.tag;
  }
}

export function initRelease(repo: string) {
  const platform = detectPlatform();
  if (platform) document.dispatchEvent(new CustomEvent('jiran:platform', { detail: platform }));
  const baked = readBaked();
  apply(baked, platform);
  // 构建时的版本信息已经上屏；向 GitHub 刷新的响应约 1MB JSON（gzip 后 ~125KB），放到 load 之后，
  // 不和首屏资源抢带宽、也不在首屏解析大 JSON
  afterLoad(() =>
    refresh(repo)
      .then((fresh) => {
        if (fresh && fresh.tag !== baked?.tag) apply(fresh, platform);
      })
      .catch(() => {
        /* 离线或被限流：保留构建时的版本信息 */
      }),
  );
  return platform;
}
