/**
 * 首屏「计算遥测核心（Computational Telemetry Core）」自定义 GLSL 着色器：
 * 1. gridVertex / gridFragment：带径向脉冲波与 fwidth 抗锯齿刻度的空间遥测坐标底面；
 * 2. coreVertex / coreFragment：球面经纬抗锯齿网格 + 扫描波 + 双阶 Fresnel 光学计量核；
 * 3. arcVertex / arcFragment：与计然图标同构的电光青—钴蓝渐变计量圆弧着色器。
 */

export const gridVertex = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  varying float vWave;

  void main() {
    vec3 p = position;
    float r = length(p.xz);
    float pulse = sin(r * 2.35 - uTime * 1.65) * exp(-r * 0.24);
    float crossWave = cos(p.x * 1.2 + uTime * 0.6) * sin(p.z * 1.2 - uTime * 0.5) * 0.04;
    float h = pulse * 0.08 + crossWave;
    p.y += h;
    vWave = pulse;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const gridFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBg;
  uniform vec3 uCyan;
  uniform vec3 uCobalt;
  varying vec3 vWorld;
  varying float vWave;

  float gridLine(vec2 coord, float scale, float width) {
    vec2 p = coord * scale;
    vec2 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec2(0.0001));
    float d = min(g.x, g.y);
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    vec2 xz = vWorld.xz;
    float dist = length(xz);

    float minor = gridLine(xz, 1.65, 1.1) * 0.22;
    float major = gridLine(xz, 0.33, 1.4) * 0.56;

    float ringCoord = dist * 0.55;
    float ringLine = (1.0 - smoothstep(0.0, 1.3, abs(fract(ringCoord) - 0.5) / max(fwidth(ringCoord), 0.0005))) * 0.34;
    float scan = exp(-pow(mod(dist - uTime * 1.75, 7.5) - 1.2, 2.0) * 3.2) * 0.42;

    float fade = exp(-dist * dist * 0.019);
    float glow = exp(-dist * 0.45) * 0.3;

    vec3 lineCol = mix(uCobalt, uCyan, clamp(vWave * 1.5 + 0.5, 0.0, 1.0));
    float intensity = (minor + major + ringLine + scan) * fade + glow;
    vec3 col = mix(uBg, lineCol, clamp(intensity, 0.0, 0.92));
    float alpha = clamp(intensity * 1.12, 0.0, 0.85) * smoothstep(13.5, 2.2, dist);

    gl_FragColor = vec4(col, alpha);
  }
`;

export const coreVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const coreFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uCobalt;
  uniform vec3 uCyan;
  uniform vec3 uViolet;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec3 vLocal;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
          mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
          mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }

  float aaLine(float coord, float width) {
    float d = abs(fract(coord - 0.5) - 0.5) / max(fwidth(coord), 0.0005);
    return 1.0 - smoothstep(0.0, width, d);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndotv = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - ndotv, 2.35);
    float hotRim = pow(1.0 - ndotv, 5.4);

    // 归一化局部球面经纬坐标
    vec3 dir = normalize(vLocal);
    float lat = asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265; // [-0.5, 0.5]
    float lon = atan(dir.z, dir.x) / (2.0 * 3.14159265) + uTime * 0.022;

    // 抗锯齿经纬刻度线（赤道附近收敛，极点淡出避免奇点伪影）
    float poleFade = smoothstep(0.48, 0.18, abs(lat));
    float latGrid = aaLine(lat * 9.0, 1.15) * 0.36;
    float lonGrid = aaLine(lon * 18.0, 1.1) * 0.28 * poleFade;
    float equator = exp(-pow(lat * 16.0, 2.0)) * 0.45;

    // 周期性遥测纬度扫描波
    float scanPos = mod(uTime * 0.26, 1.4) - 0.7;
    float scanWave = exp(-pow((lat - scanPos) * 14.0, 2.0)) * 0.52;

    // 三维程序化流场体密度
    vec3 q = dir * 2.8 + vec3(uTime * 0.24, -uTime * 0.3, uTime * 0.19);
    float n = noise3(q) * 0.65 + noise3(q * 2.2 - uTime * 0.36) * 0.35;

    vec3 col = mix(uDeep, uCobalt * 0.72, smoothstep(0.28, 0.82, n));
    col = mix(col, uViolet * 0.65, smoothstep(0.58, 0.92, noise3(q * 1.5 + 4.1)) * 0.38);

    float wire = clamp(latGrid + lonGrid + equator + scanWave, 0.0, 1.0);
    col += mix(uCobalt, uCyan, 0.68) * wire * (0.42 + 0.58 * fresnel);

    // 双阶光学边缘辉光
    col = mix(col, uCyan, fresnel * 0.78);
    col += vec3(0.78, 0.95, 1.0) * hotRim * 0.72;

    gl_FragColor = vec4(col, 0.97);
  }
`;

export const arcVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const arcFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uPhase;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 1.8);
    float coreLight = pow(max(dot(N, V), 0.0), 0.65);

    vec3 base = mix(uColorA, uColorB, smoothstep(0.05, 0.95, vUv.x));
    float pulsePos = fract(uTime * 0.28 + uPhase);
    float pulse = exp(-pow((vUv.x - pulsePos) * 6.5, 2.0)) * 0.55;

    // 两端圆润收光
    float endCap = smoothstep(0.0, 0.04, vUv.x) * smoothstep(1.0, 0.96, vUv.x);
    vec3 col = base * (0.52 + 0.55 * coreLight) + vec3(0.65, 0.92, 1.0) * (rim * 0.45 + pulse);

    gl_FragColor = vec4(col, 0.96 * max(endCap, 0.65));
  }
`;
