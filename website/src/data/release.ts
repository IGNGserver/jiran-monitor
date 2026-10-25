import { ASSET_PATTERNS, REPO, REPO_URL, RELEASES_URL, type AssetKey } from './product';

export interface ReleaseInfo {
  tag: string;
  url: string;
  publishedAt: string;
  assets: Partial<Record<AssetKey, { name: string; url: string; size: number }>>;
}

interface GhAsset { name: string; size: number }
interface GhRelease { tag_name: string; published_at: string; draft: boolean; prerelease: boolean; assets: GhAsset[] }

// Only use API values that can be safely placed in a path segment. The download and
// release URLs are then built from OUR repository constants, never from the API's
// html_url/browser_download_url fields.
export const RELEASE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const releaseTagUrl = (tag: string) => `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
const releaseAssetUrl = (tag: string, name: string) => `${REPO_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

/**
 * 取「当前正式版」：最新一个既非 draft 也非 prerelease 的发布。
 * 不用 /releases/latest —— 那个端点只认 GitHub 上手动标记的 Latest，可能落后于新正式版。
 * 这与产品的更新通道语义一致（正式版只考虑非 prerelease 的发布）。
 */
export function pickStable(list: GhRelease[]): ReleaseInfo | null {
  const rel = list.find((r) => !r.draft && !r.prerelease);
  if (!rel || !RELEASE_SEGMENT.test(rel.tag_name)) return null;
  const assets: ReleaseInfo['assets'] = {};
  for (const [key, re] of Object.entries(ASSET_PATTERNS) as [AssetKey, RegExp][]) {
    const hit = rel.assets.find((a) => re.test(a.name) && RELEASE_SEGMENT.test(a.name));
    if (hit) assets[key] = { name: hit.name, url: releaseAssetUrl(rel.tag_name, hit.name), size: hit.size };
  }
  return { tag: rel.tag_name, url: releaseTagUrl(rel.tag_name), publishedAt: rel.published_at, assets };
}

const RELEASES_PER_PAGE = 30;
const MAX_RELEASE_PAGES = 10;

/**
 * 找到最新的正式版。必须分页查找：产品每天可能发多个 prerelease，
 * 只读第一页会让「最新正式版」在若干次发版后掉出窗口，下载直链随之消失。
 */
export async function findStableRelease(
  repo: string,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReleaseInfo | null> {
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      { headers, signal },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const list = (await res.json()) as GhRelease[];
    const stable = pickStable(list);
    if (stable) return stable;
    if (list.length < RELEASES_PER_PAGE) break;
  }
  return null;
}

let cached: Promise<ReleaseInfo | null> | undefined;

/** 构建时调用一次；网络失败或设置 JIRAN_OFFLINE=1 时返回 null，页面退化为指向 Releases 页面的链接。 */
export function getRelease(): Promise<ReleaseInfo | null> {
  cached ??= (async () => {
    if (process.env.JIRAN_OFFLINE === '1') return null;
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'jiran-website-build' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      return await findStableRelease(REPO, headers, fetch, AbortSignal.timeout(8000));
    } catch (err) {
      console.warn(`[release] 无法读取 ${REPO} 的发布信息，下载按钮将指向 ${RELEASES_URL}：${(err as Error).message}`);
      return null;
    }
  })();
  return cached;
}
