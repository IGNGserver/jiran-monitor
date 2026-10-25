/**
 * 水面着色器：每只壶一片圆形水面。水滴落点由 CPU 按同一套 f(种子, 时间) 解析出来，
 * 以 (x, z, 落下时刻, 强度) 传入；这里只把它们画成向外扩散、逐渐变淡的同心涟漪。
 * 涟漪是整个场景里「计入」那一刻的视觉回声。
 */
export const MAX_HITS = 16;

export const waterVertex = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vP;
  void main() {
    vP = position.xy;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

export const waterFragment = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  #define MAX_HITS ${MAX_HITS}
  uniform float uTime;
  uniform float uRadius;
  uniform vec4 uHits[MAX_HITS];
  uniform vec3 uDeep;
  uniform vec3 uLight;
  varying vec2 vP;
  void main() {
    float r = length(vP) / uRadius;
    // 中心深、靠壶壁处带一圈亮边（弯月面反光）
    vec3 col = mix(uDeep, uLight, 0.12 + 0.28 * smoothstep(0.55, 1.0, r));
    col = mix(col, uLight, 0.10 * (0.5 + 0.5 * vP.y / uRadius));
    float ring = 0.0;
    for (int i = 0; i < MAX_HITS; i++) {
      vec4 h = uHits[i];
      float age = uTime - h.z;
      if (h.w <= 0.0 || age < 0.0 || age > 2.4) continue;
      float fade = 1.0 - age / 2.4;
      float d = length(vP - h.xy);
      float w = 0.010 + age * 0.012;
      float rr = age * 0.34;
      ring += exp(-pow((d - rr) / w, 2.0)) * fade * fade * h.w;
      ring += 0.55 * exp(-pow((d - rr * 0.62) / w, 2.0)) * fade * fade * fade * h.w;
    }
    col = mix(col, uLight, clamp(ring, 0.0, 1.0) * 0.75);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;
