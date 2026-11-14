/**
 * 84 日量化账本波面点阵、4 设备车队信标与双通道脉冲流（Token 冰青 / Credits 香槟金）着色器。
 * 波面高度与 design/blender/build_meter.py 的 wave_height() 严格同源：
 * 所有粒子坐标均为 f(seed, uTime) 纯函数，零状态漂移。
 */

const WAVE_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uZ;
  uniform float uHalf;
  uniform float uPing;
  uniform vec4 uComp[3];   // dir.xy (normalized), k, amp
  uniform vec2 uCompB[3];  // speed, phase
  uniform vec4 uRipple;    // amp, k, speed, decay

  float waveHeight(vec2 p, out float r, out float ring, out float pong) {
    float h = 0.0;
    for (int i = 0; i < 3; i++) {
      h += uComp[i].w * sin(uComp[i].z * dot(uComp[i].xy, p) + uCompB[i].x * uTime + uCompB[i].y);
    }
    r = length(p);
    h += uRipple.x * sin(uRipple.y * r - uRipple.z * uTime) * exp(-uRipple.w * r);
    float fade = smoothstep(uHalf, uHalf * 0.36, uPing);
    ring = exp(-pow((r - uPing) * 1.85, 2.0)) * fade;
    pong = exp(-pow((r - max(0.0, uPing - 1.8)) * 2.2, 2.0)) * fade;
    return h;
  }
`;

export const seaVertex = /* glsl */ `
  ${WAVE_UNIFORMS}
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uLow;
  uniform vec3 uCyan;
  uniform vec3 uBrass;
  attribute vec2 aGrid;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 p = aGrid;
    float r;
    float ring;
    float pong;
    float h = waveHeight(p, r, ring, pong);

    vec3 pos = vec3(p.x, uZ + h + ring * 0.048 + pong * 0.024, -p.y);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float normH = (h + 0.24) / 0.48;
    float tCyan = smoothstep(0.32, 0.76, normH);
    float tBrass = smoothstep(0.78, 0.96, normH);
    vec3 base = mix(uLow, uCyan, tCyan);
    base = mix(base, uBrass, tBrass * 0.72);
    vColor = base + uCyan * ring * 1.25 + uBrass * pong * 0.55;

    float dist = -mv.z;
    float edge = 1.0 - smoothstep(uHalf * 0.62, uHalf, max(abs(p.x), abs(p.y)));
    vAlpha = clamp(1.0 - (dist - 4.0) / 20.0, 0.0, 1.0) * edge;
    gl_PointSize = uSize * uPixelRatio * (1.0 + ring * 0.75 + pong * 0.35) / dist;
  }
`;

export const seaFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.12, d) * vAlpha * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

/** 车队设备信标：在线节点呈清澈冰青脉冲，>10 分钟离线（Stale）节点诚实退为低频暗金微光。 */
export const beaconVertex = /* glsl */ `
  ${WAVE_UNIFORMS}
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uCyan;
  uniform vec3 uBrass;
  attribute vec4 aBeacon; // x, y, health (1=live cyan, 0.45=stale dim brass), phase
  varying vec3 vColor;
  varying float vAlpha;
  varying float vReply;

  void main() {
    vec2 p = aBeacon.xy;
    float r;
    float ring;
    float pong;
    float h = waveHeight(p, r, ring, pong);

    float live = step(0.75, aBeacon.z);
    float reply = clamp(ring * 1.35 + pong * 1.7, 0.0, 1.5) * mix(0.25, 1.0, live);
    vec3 pos = vec3(p.x, uZ + h + 0.045 + reply * 0.032, -p.y);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float pulse = mix(0.65, 0.84 + 0.16 * sin(uTime * 2.3 + aBeacon.w * 6.2831), live);
    vec3 base = mix(uBrass * 0.68, uCyan, live);
    vColor = base * (1.12 * pulse + reply * 1.05);
    vReply = reply;

    float dist = -mv.z;
    vAlpha = clamp(1.0 - (dist - 4.0) / 22.0, 0.0, 1.0);
    gl_PointSize = uSize * uPixelRatio * (mix(0.78, 1.0, live) + reply * 0.52) / dist;
  }
`;

export const beaconFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vReply;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = smoothstep(0.2, 0.04, d);
    float halo = exp(-pow((d - 0.36) * 14.0, 2.0)) * (0.4 + vReply * 0.45);
    float glow = smoothstep(0.5, 0.0, d) * 0.22;
    float a = clamp(core + halo + glow, 0.0, 1.0) * vAlpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export const beaconLineVertex = /* glsl */ `
  ${WAVE_UNIFORMS}
  attribute vec3 aLine; // x, y, healthMix
  varying float vAlpha;
  varying float vHealth;

  void main() {
    vec2 p = aLine.xy;
    float r;
    float ring;
    float pong;
    float h = waveHeight(p, r, ring, pong);
    vec3 pos = vec3(p.x, uZ + h + 0.032 + (ring + pong) * 0.028, -p.y);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    vAlpha = clamp(1.0 - (dist - 4.0) / 20.0, 0.0, 1.0) * (0.12 + (ring + pong) * 0.25);
    vHealth = aLine.z;
  }
`;

export const beaconLineFragment = /* glsl */ `
  uniform vec3 uCyan;
  uniform vec3 uBrass;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vHealth;

  void main() {
    vec3 col = mix(uBrass * 0.7, uCyan, step(0.75, vHealth));
    float a = vAlpha * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col * a, a);
  }
`;

/**
 * 双信号严格分流粒子流：
 *  - aKind = 0（冰青 Token 脉冲）：自设备信标与账本波面升起，汇入底部 L_ingest 中央零外泄孔径；
 *  - aKind = 1（香槟金原生 Credits 脉冲）：独立汇入第 4 层右前侧偏心 Credits 副盘（uCreditsTarget），绝不混入中央主轴！
 */
export const streamVertex = /* glsl */ `
  uniform float uTime;
  uniform float uZ;
  uniform float uPixelRatio;
  uniform float uSize;
  uniform vec3 uCreditsTarget;
  attribute vec4 aSeed; // 起始方位角, 起始半径, 速度, 相位
  attribute float aKind; // 0 = Token(cyan), 1 = Native Credits(brass)
  varying float vAlpha;
  varying float vKind;

  void main() {
    float raw = fract(uTime * aSeed.z + aSeed.w);
    float e = raw * raw * (3.0 - 2.0 * raw);

    float swirl = mix(1.15, 0.52, aKind);
    float ang = aSeed.x + e * swirl;
    float startX = cos(ang) * aSeed.y;
    float startZ = sin(ang) * aSeed.y;

    // Token 目标：中央孔径 (0, 0.02, 0) 带微半径；Credits 目标：偏心黄铜副盘 uCreditsTarget
    vec3 targetToken = vec3(cos(ang * 2.0) * 0.14, 0.02, sin(ang * 2.0) * 0.14);
    vec3 targetCredits = uCreditsTarget + vec3(cos(ang * 3.0) * 0.12, 0.0, sin(ang * 3.0) * 0.12);
    vec3 dest = mix(targetToken, targetCredits, aKind);

    float rEase = pow(e, mix(0.74, 0.88, aKind));
    float yEase = pow(e, mix(1.65, 1.25, aKind));
    vec3 pos = vec3(
      mix(startX, dest.x, rEase),
      mix(uZ + 0.06, dest.y, yEase),
      mix(startZ, dest.z, rEase)
    );

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    vAlpha = smoothstep(0.0, 0.14, raw) * smoothstep(1.0, 0.84, raw);
    vKind = aKind;
    gl_PointSize = uSize * uPixelRatio * mix(0.62 + e * 0.9, 0.82 + 0.5 * sin(raw * 3.14159), aKind) / -mv.z;
  }
`;

export const streamFragment = /* glsl */ `
  uniform vec3 uCyan;
  uniform vec3 uBrass;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vKind;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha * uOpacity;
    if (a < 0.003) discard;
    vec3 col = mix(uCyan, uBrass, vKind);
    gl_FragColor = vec4(col * a, a);
  }
`;
