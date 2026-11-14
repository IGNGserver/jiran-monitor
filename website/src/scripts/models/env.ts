import * as THREE from 'three';
import { SPEC } from './spec';

/**
 * 构建克制、通透的暗室摄影棚反射环境贴图（PMREM）：
 * 顶部铂白柔光箱勾勒词元切块倒角高光，左侧冰青轮廓光呼应 Token 信号，右侧暖金补光映照成本与 Credits。
 */
export function buildStudioEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const studio = new THREE.Scene();
  studio.background = new THREE.Color(SPEC.palette.void);

  const addPanel = (
    color: string,
    intensity: number,
    size: [number, number],
    pos: [number, number, number],
    lookAt: [number, number, number] = [0, 0, 0],
  ) => {
    const c = new THREE.Color(color).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), mat);
    mesh.position.set(...pos);
    mesh.lookAt(...lookAt);
    studio.add(mesh);
  };

  // 主顶柔光带（塑造词元圆角边缘干净的银白高光）
  addPanel(SPEC.palette.platinum, 2.35, [9, 5.5], [0.6, 6.2, 1.8]);
  // 左后侧冰青轮廓灯带
  addPanel(SPEC.palette.cyan, 1.85, [6.5, 3.2], [-5.6, 2.8, -2.4]);
  // 右前侧香槟暖金补光板
  addPanel(SPEC.palette.brass, 1.35, [5.2, 2.8], [5.2, 2.2, 2.4]);
  // 前方低强度辅光（防止暗部死黑）
  addPanel('#b9c6db', 0.72, [7.0, 2.6], [0, 1.6, 6.4]);
  // 底部石墨漫反射地台
  addPanel('#101622', 0.45, [12, 12], [0, -4.5, 0]);

  const rt = pmrem.fromScene(studio, 0.035);
  pmrem.dispose();
  studio.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  return rt.texture;
}
