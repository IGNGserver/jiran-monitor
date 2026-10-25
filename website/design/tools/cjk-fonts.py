#!/usr/bin/env python3
"""
按站点实际用到的字生成 Noto Serif SC 子集。设计期运行，产物提交进仓库：
  src/assets/fonts/noto-serif-sc-{a,b}-{400,600}.woff2   两档子集 × 两个字重
  src/styles/fonts-cjk.css                               对应的 @font-face（unicode-range 精确到字）
  src/assets/fonts/noto-serif-sc.chars.json              每档收录的字，tests/fonts.spec.ts 用它校验覆盖

为什么：@fontsource/noto-serif-sc 按 unicode-range 切成约 100 片，页面上几百个汉字散落在 25～27 片里，
首页冷加载要拉近 1MB 字体。这里把用到的字从同一批分片里抽出来合并——字形原样保留，只是少了没用到的字。

两档：a = 英文页（含中文引文、印章）与所有脚本里出现的字（如首屏画布上的刻度数字），两种语言都会用到；
     b = 其余只在中文页 / 404 出现的字。英文页因此只下载 a 档。

用法（先 pnpm build 产出 dist/）：
  python3 design/tools/cjk-fonts.py dist .
依赖：fonttools、brotli（见 design/tools/requirements.txt）；字形来源是 node_modules 里锁定版本的 @fontsource/noto-serif-sc。
文案新增了汉字时 tests/fonts.spec.ts 会失败并列出缺字，重新 build 后再跑一次本脚本即可。
"""
import glob
import json
import os
import sys

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

WEIGHTS = ('400', '600')
FAMILY = 'Noto Serif SC'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def chars_of(paths):
    out = set()
    for p in paths:
        out.update(read(p))
    # 控制字符没有字形；ASCII 与其余字符一样按「字体里有就收」处理（竖排引文里的空格等也要用 Noto 的字宽）
    return {c for c in out if ord(c) >= 0x20}


def ranges(cps):
    """码位集合 → 紧凑的 unicode-range 写法"""
    cps = sorted(cps)
    out, start, prev = [], None, None
    for cp in cps:
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            out.append((start, prev))
            start = prev = cp
    if start is not None:
        out.append((start, prev))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def build(slices, chars, dest):
    parts = []
    for path, cmap in slices:
        need = chars & cmap
        if not need:
            continue
        font = TTFont(path)
        opts = subset.Options()
        opts.layout_features = ['*']  # 保留 vert / vrt2 等特性：竖排引文与题跋依赖它们
        opts.name_IDs = ['*']
        opts.name_languages = ['*']
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(text=''.join(sorted(need)))
        sub.subset(font)
        font.flavor = None
        parts.append(font)
    stamp = parts[0]['head'].created
    tmp = []
    for i, font in enumerate(parts):
        p = f'{dest}.part{i}.ttf'
        font.save(p)
        tmp.append(p)
    merged = Merger().merge(tmp)
    for p in tmp:
        os.remove(p)
    # 时间戳沿用源字体，让同样的输入产出逐字节相同的文件，避免无意义的二进制 diff
    merged.recalcTimestamp = False
    merged['head'].created = merged['head'].modified = stamp
    merged.flavor = 'woff2'
    merged.save(dest)


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: python3 design/tools/cjk-fonts.py <dist-dir> <repo-root>')
    dist, root = sys.argv[1], sys.argv[2]
    pkg = os.path.join(root, 'node_modules/@fontsource/noto-serif-sc')
    version = json.loads(read(os.path.join(pkg, 'package.json')))['version']

    html = glob.glob(os.path.join(dist, '**/*.html'), recursive=True)
    js = glob.glob(os.path.join(dist, '_astro/*.js'))
    en = [p for p in html if os.path.relpath(p, dist).startswith('en' + os.sep)]
    if not en or not js:
        sys.exit(f'{dist} 里没有找到英文页或脚本，先运行 pnpm build')
    seen_a = chars_of(en + js)
    seen_b = chars_of(html) - seen_a

    fonts_dir = os.path.join(root, 'src/assets/fonts')
    os.makedirs(fonts_dir, exist_ok=True)
    faces, tiers, absent = [], {}, set()
    for w in WEIGHTS:
        slices = []
        for path in sorted(glob.glob(os.path.join(pkg, f'files/noto-serif-sc-*-{w}-normal.woff2'))):
            slices.append((path, {chr(cp) for cp in TTFont(path).getBestCmap()}))
        cover = set().union(*(c for _, c in slices))
        a, b = seen_a & cover, seen_b & cover
        absent |= (seen_a | seen_b) - cover
        tiers[w] = {'a': a, 'b': b}
        for tier, chars in (('a', a), ('b', b)):
            if not chars:
                continue
            name = f'noto-serif-sc-{tier}-{w}.woff2'
            build(slices, chars, os.path.join(fonts_dir, name))
            faces.append(
                '@font-face {\n'
                f"  font-family: '{FAMILY}';\n"
                '  font-style: normal;\n'
                '  font-display: swap;\n'
                f'  font-weight: {w};\n'
                f"  src: url('../assets/fonts/{name}') format('woff2');\n"
                f'  unicode-range: {ranges(ord(c) for c in chars)};\n'
                '}\n'
            )
            size = os.path.getsize(os.path.join(fonts_dir, name))
            print(f'{name}: {len(chars)} 字, {size} bytes')

    if tiers['400'] != tiers['600']:
        sys.exit('两个字重的覆盖范围不一致，检查 @fontsource/noto-serif-sc 的分片')
    css = (
        '/* 由 design/tools/cjk-fonts.py 生成，不要手改。'
        f'字形来自 @fontsource/noto-serif-sc@{version}，只收站点用到的字。 */\n\n'
        + '\n'.join(faces)
    )
    with open(os.path.join(root, 'src/styles/fonts-cjk.css'), 'w', encoding='utf-8') as f:
        f.write(css)
    manifest = {
        'source': f'@fontsource/noto-serif-sc@{version}',
        'a': ''.join(sorted(tiers['400']['a'])),
        'b': ''.join(sorted(tiers['400']['b'])),
        'absent': ''.join(sorted(absent)),
    }
    with open(os.path.join(fonts_dir, 'noto-serif-sc.chars.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
