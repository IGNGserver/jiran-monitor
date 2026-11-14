"""计然「时序账本计量核 JR-01（Chrono-Ledger Core）」—— Blender 参数化构建脚本（设计源资产）。

由 design/meter.json 驱动，生成五层同轴 + 偏心副盘的精密光学计量仪器：
  01 ingest   防抖采集与零外泄光阑（59 路径向光纤槽 + 12 叶提示词剥离机械光阑 + 4 组跨端总线桥）
  02 prism    五维分光棱镜与出处刻度（石英五棱分光环 + Input/Output/Cache R·W/Uncached 五路导光轨 + 精确/推算双刻线）
  03 drum     同轴双鼓里程表与单价差速轮（外圈拉丝钢 Token 步进鼓 drum_outer + 内圈香槟黄铜单价差速轮 drum_inner）
  04 credits  偏心悬臂原生积分副盘（主轴光纤屏蔽直通 + 右前偏心香槟黄铜 Credits 独立计量盘 credits_rotor + 密钥锁芯）
  05 quota    蓝宝石双弧配额表圈与计然冠冕（168 小时 ISO 周一刻度圈 + 开口双圆弧导光环 + 中央 T 字擒纵桥 + 信号原点）

同时在底部构建 84 日量化账本波面点阵与 4 设备车队信标（含 >10m 离线置灰节点），用于 Cycles AgX 静帧母版渲染。

用法（Blender 4.2 LTS / 5.x）：
  blender -b -P design/blender/build_meter.py -- \
    --spec design/meter.json --glb meter_raw.glb \
    --renders masters --samples 96 --blend design/blender/jiran_meter.blend
"""

import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

TAU = math.tau


# ---------------------------------------------------------------- spec / util

def cli_args():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def load_spec():
    if "SPEC" in globals():
        return globals()["SPEC"]
    argv = cli_args()
    path = argv[argv.index("--spec") + 1] if "--spec" in argv else "design/meter.json"
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def hex_lin(value, alpha=1.0):
    value = value.lstrip("#")
    srgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


def M(x=0.0, y=0.0, z=0.0, rz=0.0, rx=0.0, ry=0.0):
    return (Matrix.Translation((x, y, z))
            @ Matrix.Rotation(rz, 4, "Z")
            @ Matrix.Rotation(ry, 4, "Y")
            @ Matrix.Rotation(rx, 4, "X"))


def polar(r, a, z=0.0, extra=0.0):
    """在半径 r、方位角 a 处放置零件，零件局部 +X 指向径向外侧。"""
    return M(r * math.cos(a), r * math.sin(a), z, rz=a + extra)


# ---------------------------------------------------------------- materials

def make_materials(pal):
    def principled(name, color, metallic=0.0, rough=0.5, emit=None, strength=0.0,
                   transmission=0.0, ior=1.45, coat=0.0):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = hex_lin(color)
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["IOR"].default_value = ior
        bsdf.inputs["Transmission Weight"].default_value = transmission
        bsdf.inputs["Coat Weight"].default_value = coat
        if emit:
            bsdf.inputs["Emission Color"].default_value = hex_lin(emit)
            bsdf.inputs["Emission Strength"].default_value = strength
        return mat

    return {
        "anodized": principled("anodized", pal["anodized"], 1.0, 0.32),
        "graphite": principled("graphite", pal["graphite"], 0.65, 0.42),
        "steel": principled("steel", pal["steel"], 1.0, 0.19),
        "alu": principled("alu", "#929ba6", 1.0, 0.27),
        "mirror": principled("mirror", "#e3e8f0", 1.0, 0.045),
        "brass_metal": principled("brass_metal", "#d49b45", 1.0, 0.22, coat=0.35),
        "copper": principled("copper", pal["copper"], 1.0, 0.25),
        "silicon": principled("silicon", "#151a24", 0.78, 0.11, coat=1.0),
        "black": principled("black", "#07080b", 0.0, 0.60),
        "tick": principled("tick", pal["platinum"], 0.0, 0.42, emit=pal["platinum"], strength=0.72),
        "reticle": principled("reticle", pal["platinum"], 0.0, 0.48, emit=pal["platinum"], strength=0.22),
        "cyan": principled("cyan", pal["cyan"], 0.0, 0.35, emit=pal["cyan"], strength=7.8),
        "brass": principled("brass", pal["brass"], 0.0, 0.38, emit=pal["brass"], strength=5.6),
        "danger": principled("danger", pal["danger"], 0.0, 0.40, emit=pal["danger"], strength=4.2),
        "glass": principled("glass", "#f5f9ff", 0.0, 0.035, transmission=1.0, ior=1.52),
    }


# ---------------------------------------------------------------- bmesh primitives

def add_box(bm, sx, sy, sz, matrix):
    bmesh.ops.create_cube(bm, size=1.0, matrix=matrix @ Matrix.Diagonal((sx, sy, sz, 1.0)))


def add_cyl(bm, r, h, z, seg=96, matrix=None):
    base = matrix if matrix is not None else Matrix.Identity(4)
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r, radius2=r, depth=h,
                          matrix=base @ Matrix.Translation((0, 0, z + h / 2)))


def add_cone_frustum(bm, r1, r2, h, z, seg=96, matrix=None):
    base = matrix if matrix is not None else Matrix.Identity(4)
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r1, radius2=r2, depth=h,
                          matrix=base @ Matrix.Translation((0, 0, z + h / 2)))


def add_annulus(bm, r0, r1, z0, z1, seg=160, a0=0.0, a1=TAU, center=(0.0, 0.0)):
    """环形实体（或圆弧段）：支持偏心圆心 center=(cx, cy)。"""
    cx, cy = center
    full = abs((a1 - a0) - TAU) < 1e-6
    n = seg if full else max(6, int(seg * abs(a1 - a0) / TAU))
    rings = []
    for i in range(n if full else n + 1):
        a = a0 + (a1 - a0) * i / n
        c, s = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((cx + r * c, cy + r * s, z)) for r, z in
                      ((r0, z0), (r1, z0), (r1, z1), (r0, z1))])
    count = len(rings)
    for i in range(count if full else count - 1):
        p, q = rings[i], rings[(i + 1) % count]
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new((p[k], q[k], q[k2], p[k2]))
    if not full:
        bm.faces.new(tuple(reversed(rings[0])))
        bm.faces.new(tuple(rings[-1]))


def add_torus(bm, R, r, z, seg=128, rseg=14, a0=0.0, a1=TAU, center=(0.0, 0.0)):
    """完整圆环或开口圆管段（圆角端盖），用于高精密导光圆弧。"""
    cx, cy = center
    full = abs((a1 - a0) - TAU) < 1e-6
    n = seg if full else max(8, int(seg * abs(a1 - a0) / TAU))
    grid = []
    for i in range(n if full else n + 1):
        a = a0 + (a1 - a0) * i / n
        ca, sa = math.cos(a), math.sin(a)
        row = []
        for j in range(rseg):
            b = TAU * j / rseg
            d = R + r * math.cos(b)
            row.append(bm.verts.new((cx + d * ca, cy + d * sa, z + r * math.sin(b))))
        grid.append(row)
    count = len(grid)
    for i in range(count if full else count - 1):
        p, q = grid[i], grid[(i + 1) % count]
        for j in range(rseg):
            j2 = (j + 1) % rseg
            bm.faces.new((p[j], q[j], q[j2], p[j2]))
    if not full:
        bm.faces.new(tuple(reversed(grid[0])))
        bm.faces.new(tuple(grid[-1]))


# ---------------------------------------------------------------- builder

class Builder:
    """按 (组, 材质) 累积几何；组名如 'drum' 或 'drum/outer'。"""

    def __init__(self, pivots=None):
        self.parts = {}
        self.pivots = pivots or {}

    def bm(self, group, mat, bevel=True):
        key = (group, mat)
        if key not in self.parts:
            self.parts[key] = (bmesh.new(), bevel)
        return self.parts[key][0]


# ---------------------------------------------------------------- 5 layers of JR-01

def layer_ingest(b, h):
    """01 防抖采集与零外泄光阑：59 路来源光纤口 + 4 组跨端采集桥 + 12 叶机械剥离光阑。"""
    anod = b.bm("ingest", "anodized")
    add_annulus(anod, 0.85, 1.0, 0.0, 0.068)
    add_annulus(anod, 0.85, 1.0, 0.168, h)
    # 精密不锈钢下沿基准圈
    add_annulus(b.bm("ingest", "steel"), 0.992, 1.004, 0.064, 0.072)
    add_annulus(b.bm("ingest", "steel"), 0.846, 0.862, h - 0.012, h + 0.002)

    g = b.bm("ingest", "graphite")
    add_annulus(g, 0.85, 0.962, 0.068, 0.168)
    add_cyl(g, 0.85, 0.155, 0.0)

    # 外圈 59 路光纤接入槽：前 52 路代表本地 Token 用量源（冰青），后 7 路代表纯配额源（香槟金）
    ports = b.bm("ingest", "black", bevel=False)
    for i in range(59):
        ang = TAU * i / 59 - math.radians(118)
        add_box(ports, 0.028, 0.044, 0.054, polar(0.962, ang, 0.118))
        led = "cyan" if i < 52 else "brass"
        add_box(b.bm("ingest", led, bevel=False), 0.012, 0.015, 0.010, polar(0.972, ang, 0.154))

    # 中央 12 叶「零提示词外泄」光学可变光阑（模拟剥离原始对话正文、仅放行整数计数的机械快门）
    iris_blade = b.bm("ingest", "anodized")
    iris_edge = b.bm("ingest", "steel")
    for i in range(12):
        ang = TAU * i / 12
        # 偏转切向叶片形成精密相机光圈叠片感
        blade_m = polar(0.50, ang, 0.172 + (i % 2) * 0.004, extra=math.radians(38))
        add_box(iris_blade, 0.36, 0.105, 0.014, blade_m)
        add_box(iris_edge, 0.34, 0.008, 0.016, blade_m @ M(0, -0.048, 0.001))

    # 中央清澈孔径环（仅整数 Token 脉冲通过）
    add_annulus(b.bm("ingest", "mirror"), 0.21, 0.255, 0.16, 0.208)
    add_annulus(b.bm("ingest", "cyan", bevel=False), 0.202, 0.212, 0.188, 0.198)
    add_cyl(b.bm("ingest", "silicon"), 0.202, 0.02, 0.155)

    # 四组主机/WSL 防抖采样桥模块（1.5s chokidar debounce + \\wsl$ 门控探针）
    for i in range(4):
        ang = TAU * i / 4 - math.radians(45)
        add_box(b.bm("ingest", "alu"), 0.15, 0.095, 0.038, polar(0.75, ang, 0.205))
        add_box(b.bm("ingest", "cyan", bevel=False), 0.095, 0.009, 0.006, polar(0.75, ang, 0.226) @ M(0, -0.02, 0))
        add_box(b.bm("ingest", "cyan", bevel=False), 0.095, 0.009, 0.006, polar(0.75, ang, 0.226) @ M(0, 0.02, 0))


def layer_prism(b, h):
    """02 五维分光棱镜与出处刻度：Input / Output / Cache R·W / Uncached 五路导光轨 + 精确/推算游标。"""
    # 五根开放式精雕暗钛立柱，充分暴露内部光学分光台
    for i in range(5):
        a0 = TAU * i / 5 - math.radians(26)
        add_annulus(b.bm("prism", "anodized"), 0.935, 1.0, 0.0, h, a0=a0, a1=a0 + math.radians(24))

    # 底部镀膜硅晶圆光学基准盘
    add_cyl(b.bm("prism", "graphite"), 0.94, 0.026, 0.0)
    add_cyl(b.bm("prism", "silicon"), 0.78, 0.012, 0.026)

    # 顶部游标出处刻度环（半圈连续单刻线 = exact 上游精确值；对侧双点刻线 = estimated 推算披露，无伪精确 ~）
    add_annulus(b.bm("prism", "steel"), 0.88, 0.945, h - 0.022, h)
    ticks = b.bm("prism", "tick", bevel=False)
    for i in range(90):
        ang = TAU * i / 90
        if i < 58:
            length = 0.042 if i % 5 == 0 else 0.024
            add_box(ticks, length, 0.005, 0.004, polar(0.912, ang, h + 0.002))
        elif i % 2 == 0:
            add_box(ticks, 0.012, 0.005, 0.004, polar(0.896, ang, h + 0.002))
            add_box(ticks, 0.012, 0.005, 0.004, polar(0.924, ang, h + 0.002))

    # 中央五棱石英分光核心（5 段镜面反射座 + 透射玻璃核）
    add_cyl(b.bm("prism", "mirror"), 0.24, 0.13, 0.038, seg=5)
    add_cyl(b.bm("prism", "glass", bevel=False), 0.20, 0.155, 0.042, seg=10)
    add_annulus(b.bm("prism", "cyan", bevel=False), 0.238, 0.252, 0.158, 0.168, seg=60)

    # 五路径向准直导光槽（对应 Input / Output / Cache Read / Cache Write / Uncached Input）
    rail_lengths = (0.52, 0.44, 0.56, 0.38, 0.34)
    for i, rlen in enumerate(rail_lengths):
        ang = TAU * i / 5 + math.radians(10)
        mid_r = 0.28 + rlen / 2
        # 铝制准直导轨槽
        add_box(b.bm("prism", "alu"), rlen, 0.078, 0.048, polar(mid_r, ang, 0.068))
        add_box(b.bm("prism", "black", bevel=False), rlen - 0.03, 0.044, 0.022, polar(mid_r, ang, 0.088))
        # 冰青光束芯 + 铜质准直光栅环
        beam_col = "cyan" if i != 1 else "brass"
        add_box(b.bm("prism", beam_col, bevel=False), rlen - 0.05, 0.016, 0.012, polar(mid_r, ang, 0.098))
        for k in range(3):
            rr = 0.35 + k * 0.14
            if rr < 0.28 + rlen - 0.03:
                add_box(b.bm("prism", "copper"), 0.016, 0.092, 0.064, polar(rr, ang, 0.076))
        # 玻璃棱镜压盖
        add_box(b.bm("prism", "glass", bevel=False), rlen - 0.04, 0.056, 0.014, polar(mid_r, ang, 0.112))


def layer_drum(b, h):
    """03 同轴双鼓里程表与单价差速轮：外鼓 drum_outer（Token 步进） + 内轮 drum_inner（models.dev 单价折算）。"""
    # 固定上下暗钛端盖托架
    add_annulus(b.bm("drum", "anodized"), 0.94, 1.0, 0.0, 0.036)
    add_annulus(b.bm("drum", "anodized"), 0.94, 1.0, h - 0.036, h)
    for i in range(4):
        ang = TAU * i / 4 + math.radians(18)
        add_box(b.bm("drum", "anodized"), 0.045, 0.08, h, polar(0.97, ang, h / 2))

    # --- 可旋转外鼓：drum/outer -> Three.js 节点 drum_outer ---
    outer_s = b.bm("drum/outer", "steel")
    add_annulus(outer_s, 0.81, 0.918, 0.034, h - 0.034, seg=144)
    # 外壁 72 道精密滚花直槽与阶梯刻度肋
    flutes = b.bm("drum/outer", "alu", bevel=False)
    drum_ticks = b.bm("drum/outer", "tick", bevel=False)
    for i in range(72):
        ang = TAU * i / 72
        add_box(flutes, 0.012, 0.014, h - 0.09, polar(0.920, ang, h / 2))
        major = i % 6 == 0
        t_h = 0.065 if major else 0.032
        add_box(drum_ticks, 0.005, 0.005 if major else 0.003, t_h, polar(0.923, ang, h - 0.075))
    # 外鼓冰青同步基准带
    add_annulus(b.bm("drum/outer", "cyan", bevel=False), 0.916, 0.924, h * 0.48, h * 0.52, seg=128)

    # --- 可反向微旋内差速轮：drum/inner -> Three.js 节点 drum_inner ---
    inner_b = b.bm("drum/inner", "brass_metal")
    add_annulus(inner_b, 0.48, 0.75, 0.055, h - 0.055, seg=120)
    add_annulus(b.bm("drum/inner", "graphite"), 0.52, 0.71, h - 0.054, h - 0.032, seg=96)
    # 48 齿精密斜齿轮圈（代表 models.dev 单价与多币种汇率差速乘算）
    teeth = b.bm("drum/inner", "brass_metal", bevel=False)
    for i in range(48):
        ang = TAU * i / 48
        add_box(teeth, 0.036, 0.022, 0.08, polar(0.762, ang, h * 0.5))
    # 6 枚行星小齿轮与香槟金读数标点
    for i in range(6):
        ang = TAU * i / 6
        px, py = 0.615 * math.cos(ang), 0.615 * math.sin(ang)
        add_cyl(b.bm("drum/inner", "steel"), 0.062, 0.032, h - 0.034, seg=36, matrix=M(px, py))
        add_cyl(b.bm("drum/inner", "brass", bevel=False), 0.018, 0.012, h - 0.012, seg=24, matrix=M(px, py))

    # 中央固定单调基线轴（baseline ≠ display 差额锚点）
    add_cyl(b.bm("drum", "graphite"), 0.44, h, 0.0)
    add_annulus(b.bm("drum", "mirror"), 0.32, 0.445, h - 0.018, h + 0.002)

    # 正前方（面向 Hero 相机 azimuth=-26°，即约 -72° 处）静态蓝宝石放大读数窗框
    win_ang = math.radians(-72)
    add_box(b.bm("drum", "steel"), 0.055, 0.28, h - 0.02, polar(0.955, win_ang, h / 2))
    add_box(b.bm("drum", "glass", bevel=False), 0.022, 0.22, h - 0.07, polar(0.968, win_ang, h / 2))
    add_box(b.bm("drum", "cyan", bevel=False), 0.012, 0.006, h - 0.06, polar(0.980, win_ang, h / 2))


def layer_credits(b, h):
    """04 偏心悬臂原生积分副盘：主轴 Token 光导管直通 + 右前偏心香槟金 Credits 副盘（绝不混算）。"""
    # 外框：在副盘方向（-52°）留出精密悬臂开口，其余圆弧为拉丝铝与暗钛护圈
    sub_ang = math.radians(-52)
    sub_r = 0.56
    cx, cy = sub_r * math.cos(sub_ang), sub_r * math.sin(sub_ang)
    b.pivots["credits_rotor"] = (cx, cy, 0.0)

    add_annulus(b.bm("credits", "anodized"), 0.91, 1.0, 0.0, h * 0.82,
                a0=sub_ang + math.radians(42), a1=sub_ang + TAU - math.radians(42))
    add_cyl(b.bm("credits", "graphite"), 0.91, 0.032, 0.0)

    # 主同轴通道（0,0）：全封闭电磁/光学屏蔽筒，将 Token 光信号无污染送往顶层表圈
    add_cyl(b.bm("credits", "anodized"), 0.26, h, 0.0)
    add_annulus(b.bm("credits", "steel"), 0.255, 0.285, h - 0.028, h)
    add_annulus(b.bm("credits", "cyan", bevel=False), 0.16, 0.185, h - 0.008, h + 0.004)
    add_cyl(b.bm("credits", "silicon"), 0.16, 0.02, h - 0.022)

    # 左后侧对重区：3 枚 AES-256-GCM 密钥环静态加密锁芯柱（呼应 Hub 凭据加密不回读）
    for k in range(3):
        ang = sub_ang + math.pi + math.radians((k - 1) * 34)
        vx, vy = 0.62 * math.cos(ang), 0.62 * math.sin(ang)
        add_cyl(b.bm("credits", "steel"), 0.115, h * 0.78, 0.032, seg=48, matrix=M(vx, vy))
        add_cyl(b.bm("credits", "graphite"), 0.088, 0.022, 0.032 + h * 0.78, seg=48, matrix=M(vx, vy))
        add_box(b.bm("credits", "cyan", bevel=False), 0.075, 0.010, 0.008, M(vx, vy, 0.056 + h * 0.78, rz=ang))

    # --- 偏心悬臂原生积分（Credits）副盘总成（中心位于 cx, cy，突出外缘至 r ≈ 0.96） ---
    # 悬臂托架与物理隔离槽（视觉强调：独立表头，绝不折入 USD/Tokens）
    add_cyl(b.bm("credits", "anodized"), 0.39, 0.075, 0.018, seg=96, matrix=M(cx, cy))
    add_annulus(b.bm("credits", "brass_metal"), 0.335, 0.392, 0.072, h + 0.012, seg=112, center=(cx, cy))
    add_cyl(b.bm("credits", "black"), 0.335, 0.024, 0.072, seg=96, matrix=M(cx, cy))

    # 副盘 24 枚香槟金精密刻度
    sub_ticks = b.bm("credits", "brass", bevel=False)
    for i in range(24):
        a = TAU * i / 24
        major = i % 6 == 0
        tl = 0.048 if major else 0.024
        tw = 0.007 if major else 0.004
        tx = cx + (0.312 - tl / 2) * math.cos(a)
        ty = cy + (0.312 - tl / 2) * math.sin(a)
        add_box(sub_ticks, tl, tw, 0.005, M(tx, ty, 0.100, rz=a))

    # 可绕自身偏心轴旋转的三辐香槟金摆轮指针：credits/rotor -> 节点 credits_rotor（局部坐标以 0,0 为中心！）
    rotor_b = b.bm("credits/rotor", "brass_metal")
    add_annulus(rotor_b, 0.21, 0.245, 0.112, 0.136, seg=84)
    add_cyl(b.bm("credits/rotor", "steel"), 0.042, 0.055, 0.096, seg=36)
    for k in range(3):
        sa = TAU * k / 3
        add_box(rotor_b, 0.18, 0.018, 0.014, polar(0.125, sa, 0.124))
    # 指针尖端高亮香槟金光点
    add_box(b.bm("credits/rotor", "brass", bevel=False), 0.15, 0.010, 0.008, polar(0.19, 0.0, 0.142))
    add_cyl(b.bm("credits/rotor", "brass", bevel=False), 0.018, 0.012, 0.148, seg=24)

    # 副盘独立蓝宝石小表镜
    add_cyl(b.bm("credits", "glass", bevel=False), 0.332, 0.014, h - 0.004, seg=84, matrix=M(cx, cy))


def layer_quota(b, h):
    """05 蓝宝石双弧配额表圈与计然冠冕：与产品图标严格同构的双段开口导光弧 + T 字中轴桥 + 信号原点。"""
    # 外圈暗钛精密斜切表圈
    add_annulus(b.bm("quota", "anodized"), 0.80, 1.0, 0.0, h)
    add_annulus(b.bm("quota", "steel"), 0.765, 0.802, 0.0, h - 0.016)
    add_cyl(b.bm("quota", "black"), 0.768, 0.022, 0.0)

    # 表圈顶面 168 格精密刻度（7 天 × 24 小时 = 168h，对应全球统一 ISO 周一零点起算周窗口）
    ticks = b.bm("quota", "tick", bevel=False)
    for i in range(168):
        ang = TAU * i / 168
        day_mark = i % 24 == 0
        six_h = i % 6 == 0
        length = 0.105 if day_mark else (0.062 if six_h else 0.032)
        width = 0.009 if day_mark else (0.005 if six_h else 0.0028)
        mat_t = b.bm("quota", "cyan", bevel=False) if i == 42 else ticks  # 12 点钟（90°）ISO-Monday 冰青零点基准标
        add_box(mat_t, length, width, 0.004, polar(0.822 + length / 2, ang, h + 0.002))

    # 表盘内暗刻同心十字分划网
    reticle = b.bm("quota", "reticle", bevel=False)
    for r in (0.22, 0.42, 0.68):
        add_annulus(reticle, r, r + 0.0025, 0.023, 0.025, seg=128)
    add_box(reticle, 1.42, 0.0022, 0.002, M(z=0.024))
    add_box(reticle, 0.0022, 1.42, 0.002, M(z=0.024))

    # --- 计然标志性冠冕几何（俯视时与 assets/icon.png 及 Mark.astro 严格同构！） ---
    # 1. 左侧开口计量圆弧（98° -> 206°，代表 5 小时滚动配额窗口）：冰青色悬浮导光圆弧 + 精密钢托
    R_arc = 0.56
    z_arc = 0.078
    add_torus(b.bm("quota", "cyan", bevel=False), R_arc, 0.022, z_arc, seg=96, rseg=16,
              a0=math.radians(98), a1=math.radians(206))
    add_annulus(b.bm("quota", "steel"), R_arc - 0.016, R_arc + 0.016, 0.024, 0.048, seg=96,
                a0=math.radians(98), a1=math.radians(206))

    # 2. 左下信号原点（225°，7:30 方向）：镶嵌在精钢碗座中的冰青发光原点球
    orb_ang = math.radians(225)
    ox, oy = 0.54 * math.cos(orb_ang), 0.54 * math.sin(orb_ang)
    add_annulus(b.bm("quota", "steel"), 0.048, 0.074, 0.022, 0.062, seg=48, center=(ox, oy))
    orb_bm = b.bm("quota", "cyan", bevel=False)
    bmesh.ops.create_uvsphere(orb_bm, u_segments=36, v_segments=24, radius=0.048, matrix=M(ox, oy, z_arc))

    # 3. 右侧开口计量圆弧（-90° -> +82°，代表 26 家订阅与周配额弧）+ 中央 T 字擒纵桥！
    add_torus(b.bm("quota", "cyan", bevel=False), R_arc, 0.022, z_arc, seg=120, rseg=16,
              a0=math.radians(-90), a1=math.radians(82))
    add_annulus(b.bm("quota", "steel"), R_arc - 0.016, R_arc + 0.016, 0.024, 0.048, seg=120,
                a0=math.radians(-90), a1=math.radians(82))

    # 中央 T 字精密擒纵桥：竖轴从 6 点钟 (0, -0.56) 延伸至 (0, +0.055)，横梁 (-0.25..+0.25, +0.055)
    stem_len = 0.56 + 0.055
    stem_mid_y = (-0.56 + 0.055) / 2
    add_box(b.bm("quota", "steel"), 0.046, stem_len, 0.032, M(0.0, stem_mid_y, 0.042))
    add_box(b.bm("quota", "cyan", bevel=False), 0.034, stem_len, 0.024, M(0.0, stem_mid_y, z_arc))
    # T 字横梁
    bar_w = 0.50
    add_box(b.bm("quota", "steel"), bar_w, 0.046, 0.032, M(0.0, 0.055, 0.042))
    add_box(b.bm("quota", "cyan", bevel=False), bar_w - 0.02, 0.034, 0.024, M(0.0, 0.055, z_arc))
    # T 字中心宝石轴承压盖
    add_cyl(b.bm("quota", "mirror"), 0.052, 0.016, z_arc + 0.012, seg=48, matrix=M(0.0, 0.055))

    # 外圈右上三段香槟金 + 一枚朱砂红 <20% 临界预警弧标
    for k in range(3):
        a0 = math.radians(22 + k * 14)
        col = "danger" if k == 2 else "brass"
        add_annulus(b.bm("quota", col, bevel=False), 0.935, 0.952, h + 0.001, h + 0.007, seg=64, a0=a0, a1=a0 + math.radians(9))

    # 拱形防眩蓝宝石光学表镜（覆盖整个表盘，产生真实边缘折射与柔光条反射）
    dome = b.bm("quota/dome", "glass", bevel=False)
    bmesh.ops.create_uvsphere(dome, u_segments=96, v_segments=48, radius=0.785,
                              matrix=M(z=h - 0.022) @ Matrix.Diagonal((1, 1, 0.42, 1)))
    bmesh.ops.delete(dome, geom=[v for v in dome.verts if v.co.z < h - 0.023], context="VERTS")


LAYERS = {
    "ingest": layer_ingest,
    "prism": layer_prism,
    "drum": layer_drum,
    "credits": layer_credits,
    "quota": layer_quota,
}


# ---------------------------------------------------------------- assemble

def build():
    spec = load_spec()
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            coll.remove(item)
    col = bpy.context.scene.collection
    mats = make_materials(spec["palette"])

    root = bpy.data.objects.new("JR01", None)
    col.objects.link(root)
    z = 0.0
    empties = {}
    sub_name_map = {
        ("drum", "outer"): "drum_outer",
        ("drum", "inner"): "drum_inner",
        ("credits", "rotor"): "credits_rotor",
    }

    for layer in spec["layers"]:
        lid, h = layer["id"], layer["h"]
        empty = bpy.data.objects.new(f"L_{lid}", None)
        empty.location = (0, 0, z)
        empty.parent = root
        empty["label"] = layer["labelZh"]
        col.objects.link(empty)
        empties[lid] = empty

        b = Builder()
        LAYERS[lid](b, h)

        for (group, mname), (bm, bevel) in b.parts.items():
            parent = empty
            if "/" in group:
                sub = group.split("/")[1]
                sub_name = sub_name_map.get((lid, sub), f"{lid}_{sub}")
                if sub_name not in empties:
                    e = bpy.data.objects.new(sub_name, None)
                    e.location = b.pivots.get(sub_name, (0.0, 0.0, 0.0))
                    e.parent = empty
                    col.objects.link(e)
                    empties[sub_name] = e
                parent = empties[sub_name]

            name = f"{group.replace('/', '_')}_{mname}"
            me = bpy.data.meshes.new(name)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(me)
            bm.free()
            me.materials.append(mats[mname])
            me.shade_smooth()
            if hasattr(me, "set_sharp_from_angle"):
                me.set_sharp_from_angle(angle=math.radians(32))
            ob = bpy.data.objects.new(name, me)
            ob.parent = parent
            col.objects.link(ob)
            if bevel:
                mod = ob.modifiers.new("bevel", "BEVEL")
                mod.width = 0.0032
                mod.segments = 2
                mod.limit_method = "ANGLE"
                mod.angle_limit = math.radians(40)
                mod.harden_normals = True
        z += h + spec["seam"]
    return root


# ---------------------------------------------------------------- ledger wave & fleet beacons

def wave_height(w, x, y, t=0.0):
    """与站点着色器（src/scripts/meter/shaders.ts）严格同源的 84 日账本波面高度函数。"""
    h = 0.0
    for c in w["components"]:
        dx, dy = c["dir"]
        n = math.hypot(dx, dy)
        h += c["amp"] * math.sin(c["k"] * (dx * x + dy * y) / n + c["speed"] * t + c["phase"])
    r = math.hypot(x, y)
    rp = w["ripple"]
    h += rp["amp"] * math.sin(rp["k"] * r - rp["speed"] * t) * math.exp(-rp["decay"] * r)
    return h


def build_sea():
    """84 日量化账本波面点阵与 4 设备车队信标（仅用于 Blender Cycles 静帧渲染；站点端由 GLSL 实时驱动）。"""
    spec = load_spec()
    w = spec["waves"]
    for name in ("sea", "sea_beacons_cyan", "sea_beacons_brass", "sea_beacon_lines"):
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name])
    n, size = w["res"], w["size"]
    me = bpy.data.meshes.new("sea")
    coords, heights = [], []
    for i in range(n):
        for j in range(n):
            x = -size / 2 + size * i / (n - 1)
            y = -size / 2 + size * j / (n - 1)
            h = wave_height(w, x, y)
            coords.append((x, y, w["z"] + h))
            heights.append(h)
    me.vertices.add(len(coords))
    me.vertices.foreach_set("co", [c for v in coords for c in v])
    attr = me.attributes.new("h", "FLOAT", "POINT")
    attr.data.foreach_set("value", heights)
    ob = bpy.data.objects.new("sea", me)
    bpy.context.scene.collection.objects.link(ob)

    mat = bpy.data.materials.get("sea_dot") or bpy.data.materials.new("sea_dot")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    attr_n = nt.nodes.new("ShaderNodeAttribute")
    attr_n.attribute_name = "h"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30
    ramp.color_ramp.elements[0].color = hex_lin("#4c5360")
    ramp.color_ramp.elements[1].position = 0.74
    ramp.color_ramp.elements[1].color = hex_lin(spec["palette"]["cyan"])
    el_brass = ramp.color_ramp.elements.new(0.92)
    el_brass.color = hex_lin(spec["palette"]["brass"])
    scale = nt.nodes.new("ShaderNodeMapRange")
    scale.inputs["From Min"].default_value = -0.24
    scale.inputs["From Max"].default_value = 0.24
    cam = nt.nodes.new("ShaderNodeCameraData")
    fade = nt.nodes.new("ShaderNodeMapRange")
    fade.inputs["From Min"].default_value = 4.0
    fade.inputs["From Max"].default_value = 22.0
    fade.inputs["To Min"].default_value = 2.1
    fade.inputs["To Max"].default_value = 0.0
    nt.links.new(attr_n.outputs["Fac"], scale.inputs["Value"])
    nt.links.new(scale.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    nt.links.new(cam.outputs["View Distance"], fade.inputs["Value"])
    nt.links.new(fade.outputs["Result"], emit.inputs["Strength"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

    tree = bpy.data.node_groups.get("sea_points") or bpy.data.node_groups.new("sea_points", "GeometryNodeTree")
    tree.nodes.clear()
    tree.interface.clear()
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gin = tree.nodes.new("NodeGroupInput")
    gout = tree.nodes.new("NodeGroupOutput")
    m2p = tree.nodes.new("GeometryNodeMeshToPoints")
    m2p.inputs["Radius"].default_value = 0.0105
    setm = tree.nodes.new("GeometryNodeSetMaterial")
    setm.inputs["Material"].default_value = mat
    tree.links.new(gin.outputs[0], m2p.inputs["Mesh"])
    tree.links.new(m2p.outputs["Points"], setm.inputs["Geometry"])
    tree.links.new(setm.outputs["Geometry"], gout.inputs[0])
    mod = ob.modifiers.new("points", "NODES")
    mod.node_group = tree

    def emit_mat(mname, color, strength):
        m = bpy.data.materials.get(mname) or bpy.data.materials.new(mname)
        m.use_nodes = True
        mnt = m.node_tree
        mnt.nodes.clear()
        mout = mnt.nodes.new("ShaderNodeOutputMaterial")
        mem = mnt.nodes.new("ShaderNodeEmission")
        mem.inputs["Color"].default_value = hex_lin(color)
        mem.inputs["Strength"].default_value = strength
        mnt.links.new(mem.outputs["Emission"], mout.inputs["Surface"])
        return m

    mat_b_cyan = emit_mat("sea_beacon_cyan_mat", spec["palette"]["cyan"], 2.0)
    mat_b_brass = emit_mat("sea_beacon_brass_mat", spec["palette"]["brass"], 1.8)
    mat_b_line = emit_mat("sea_beacon_line_mat", spec["palette"]["cyan"], 0.38)

    bm_cyan = bmesh.new()
    bm_brass = bmesh.new()
    bm_line = bmesh.new()
    for cl in spec.get("clusters", []):
        nodes = cl["nodes"]
        for x, y, health in nodes:
            hz = w["z"] + wave_height(w, x, y) + 0.035
            target_bm = bm_cyan if health > 0.75 else bm_brass
            add_cyl(target_bm, 0.032, 0.01, 0.0, seg=28, matrix=M(x, y, hz))
            ring_tmp = bmesh.new()
            add_annulus(ring_tmp, 0.068, 0.078, 0.0, 0.004, seg=40, center=(x, y))
            bmesh.ops.translate(ring_tmp, verts=ring_tmp.verts, vec=(0, 0, hz))
            tmp_me = bpy.data.meshes.new("_ring_tmp")
            ring_tmp.to_mesh(tmp_me)
            ring_tmp.free()
            target_bm.from_mesh(tmp_me)
            bpy.data.meshes.remove(tmp_me)
        for i in range(len(nodes)):
            for j in range(i + 1, len(nodes)):
                x0, y0, _ = nodes[i]
                x1, y1, _ = nodes[j]
                steps = 8
                for s in range(steps):
                    t0, t1 = s / steps, (s + 1) / steps
                    ax, ay = x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0
                    bx, by = x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1
                    az = w["z"] + wave_height(w, ax, ay) + 0.028
                    bz = w["z"] + wave_height(w, bx, by) + 0.028
                    dv = Vector((bx - ax, by - ay, bz - az))
                    mid = Vector(((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2))
                    rot = dv.normalized().to_track_quat("X", "Z").to_matrix().to_4x4()
                    add_box(bm_line, dv.length * 0.92, 0.0035, 0.0025, Matrix.Translation(mid) @ rot)

    for bname, bm_src, bmat in (
        ("sea_beacons_cyan", bm_cyan, mat_b_cyan),
        ("sea_beacons_brass", bm_brass, mat_b_brass),
        ("sea_beacon_lines", bm_line, mat_b_line),
    ):
        bme = bpy.data.meshes.new(bname)
        bm_src.to_mesh(bme)
        bm_src.free()
        bme.materials.append(bmat)
        bob = bpy.data.objects.new(bname, bme)
        bpy.context.scene.collection.objects.link(bob)

    return ob


def set_sea_visible(vis):
    for name in ("sea", "sea_beacons_cyan", "sea_beacons_brass", "sea_beacon_lines"):
        ob = bpy.data.objects.get(name)
        if ob:
            ob.hide_render = not vis


def explode(factor):
    """factor = 0 组装态；1 = 每层之间额外拉开 spec['explode'] 米。"""
    spec = load_spec()
    z = 0.0
    for i, layer in enumerate(spec["layers"]):
        bpy.data.objects[f"L_{layer['id']}"].location.z = z + i * spec["explode"] * factor
        z += layer["h"] + spec["seam"]


def stage(distance=8.1, elevation=16.0, azimuth=-26.0, lens=40, target=(0, 0, 0.62),
          res=(2560, 1440), dof=None, shift=(0.0, 0.0)):
    """纯黑曜暗室摄影棚：左后冷铂轮廓柔光板 + 右侧香槟暖金窄条光 + 顶部柔光带，无任何廉价海军蓝底雾。"""
    spec = load_spec()
    for ob in [o for o in bpy.data.objects if o.type in {"CAMERA", "LIGHT"}]:
        bpy.data.objects.remove(ob)
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = hex_lin(spec["palette"]["void"])
    bg.inputs["Strength"].default_value = 1.0

    def area(name, loc, size, energy, color, shape="RECTANGLE", size_y=None):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = hex_lin(color)[:3]
        data.shape = shape
        data.size = size
        if size_y:
            data.size_y = size_y
        ob = bpy.data.objects.new(name, data)
        ob.location = loc
        scene.collection.objects.link(ob)
        direction = Vector(target) - Vector(loc)
        ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return ob

    area("rim_left", (-4.6, 3.4, 4.1), 3.1, 1040, "#e2eeff")
    area("strip_right", (4.3, 1.0, 1.4), 0.30, 520, "#ffe0b2", size_y=4.4)
    area("top_strip", (-0.5, 0.3, 6.2), 0.40, 340, "#ffffff", size_y=6.2)
    area("front_fill", (1.4, -6.0, 1.3), 5.2, 120, "#d8e0ec")
    area("rim_back", (3.1, 5.0, 0.3), 2.3, 780, "#b8dcff")

    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = lens
    cam_data.sensor_width = 36
    cam_data.sensor_fit = "AUTO"
    cam_data.shift_x, cam_data.shift_y = shift
    if dof:
        cam_data.dof.use_dof = True
        cam_data.dof.focus_distance = dof[0]
        cam_data.dof.aperture_fstop = dof[1]
    cam = bpy.data.objects.new("cam", cam_data)
    el, az = math.radians(elevation), math.radians(azimuth)
    t = Vector(target)
    cam.location = t + distance * Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    return cam


def render(path, engine="CYCLES", samples=96):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES" if engine == "CYCLES" else "BLENDER_EEVEE"
    if engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            prefs.compute_device_type = "OPTIX"
            prefs.get_devices()
            gpu_found = any(d.type != "CPU" for d in prefs.devices)
            if gpu_found:
                for d in prefs.devices:
                    d.use = True
                scene.cycles.device = "GPU"
            else:
                scene.cycles.device = "CPU"
        except Exception:
            scene.cycles.device = "CPU"
    else:
        scene.eevee.taa_render_samples = samples
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "16" if engine == "CYCLES" else "8"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def render_masters(out_dir, samples=96):
    """生成站点所需的 3 张 Cycles AgX 母版（机位与 src/scripts/meter/director.ts 首帧严格对齐）。"""
    os.makedirs(out_dir, exist_ok=True)
    spec = load_spec()
    h = spec["camera"]["hero"]
    shots = []
    explode(0.0)
    if "sea" not in bpy.data.objects:
        build_sea()
    set_sea_visible(True)

    # 1. 首屏横版（模型偏右 shiftX，留出左侧大字标题暗室空间）
    stage(distance=h["distance"], elevation=h["elevation"], azimuth=h["azimuth"], lens=h["lens"],
          target=tuple(h["target"]), res=(2560, 1440), shift=(-h.get("shiftX", 0.0), 0.0))
    shots.append(render(os.path.join(out_dir, "hero.png"), samples=samples))

    # 2. 首屏竖版（移动端：距离 ×1.14，模型上移让出下半屏文案）
    stage(distance=h["distance"] * 1.14, elevation=h["elevation"], azimuth=h["azimuth"], lens=h["lens"],
          target=tuple(h["target"]), res=(1080, 1920), shift=(0.0, -0.18))
    shots.append(render(os.path.join(out_dir, "hero-portrait.png"), samples=samples))

    # 3. 五层爆炸剖面视图（无 WebGL / prefers-reduced-motion 时的静态高精度剖面图）
    explode(1.0)
    set_sea_visible(False)
    bases, z = [], 0.0
    for layer in spec["layers"]:
        bases.append(z)
        z += layer["h"] + spec["seam"]
    mid = bases[2] + 2 * spec["explode"] + spec["layers"][2]["h"] / 2
    stage(distance=10.2, elevation=21, azimuth=-32, lens=h["lens"], target=(0, 0, mid), res=(1400, 1600))
    shots.append(render(os.path.join(out_dir, "exploded.png"), samples=samples))

    explode(0.0)
    set_sea_visible(True)
    stage(distance=h["distance"], elevation=h["elevation"], azimuth=h["azimuth"], lens=h["lens"],
          target=tuple(h["target"]), res=(2560, 1440), shift=(-h.get("shiftX", 0.0), 0.0))
    return shots


def export_glb(path):
    bpy.ops.object.select_all(action="DESELECT")
    root = bpy.data.objects["JR01"]
    for ob in [root, *root.children_recursive]:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        use_selection=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_materials="EXPORT",
    )


if __name__ == "__main__":
    build()
    argv = cli_args()
    if "--glb" in argv:
        export_glb(argv[argv.index("--glb") + 1])
    samples = int(argv[argv.index("--samples") + 1]) if "--samples" in argv else 96
    if "--renders" in argv:
        render_masters(argv[argv.index("--renders") + 1], samples=samples)
    if "--blend" in argv:
        if "sea" not in bpy.data.objects:
            build_sea()
            h = load_spec()["camera"]["hero"]
            stage(distance=h["distance"], elevation=h["elevation"], azimuth=h["azimuth"], lens=h["lens"],
                  target=tuple(h["target"]), res=(2560, 1440), shift=(-h.get("shiftX", 0.0), 0.0))
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(argv[argv.index("--blend") + 1]), compress=True)
