import {
  BackSide,
  BoxGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Vector3,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * 与 Blender Cycles 暗室摄影棚（build_meter.py › stage()）严格同构的 PMREM 反射环境：
 * 纯无彩黑曜暗室中布置冷铂主轮廓柔光板、右侧香槟暖金窄条光与顶部柔光带，
 * 让拉丝不锈钢里程鼓、暗钛表圈、香槟黄铜副盘与蓝宝石表镜呈现真实金属光学质感。
 */
export function studioEnvironment(renderer: WebGLRenderer): Texture {
  const scene = new Scene();
  const room = new Mesh(
    new BoxGeometry(30, 30, 30),
    new MeshBasicMaterial({ color: new Color('#050608'), side: BackSide }),
  );
  scene.add(room);

  const target = new Vector3(0, 0.75, 0);
  const panel = (w: number, h: number, pos: [number, number, number], hex: string, power: number) => {
    const mat = new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(power), side: DoubleSide });
    const m = new Mesh(new PlaneGeometry(w, h), mat);
    m.position.set(...pos);
    m.lookAt(target);
    scene.add(m);
  };

  // Blender (x, y, z) -> Three (x, z, -y)
  panel(4.6, 3.3, [-4.6, 4.1, -3.4], '#e2eeff', 5.8); // 左后冷铂主轮廓柔光板
  panel(0.35, 5.0, [4.3, 1.4, -1.0], '#ffe0b2', 7.2); // 右侧香槟金窄条高光（擦亮黄铜副盘与钢鼓齿槽）
  panel(0.5, 7.0, [-0.5, 6.2, -0.3], '#ffffff', 1.5); // 顶部精密柔光带（点亮蓝宝石穹顶反射）
  panel(3.0, 2.3, [3.1, 0.3, -5.0], '#b8dcff', 4.2); // 右后冷色勾边光
  panel(6.0, 2.2, [1.4, 1.3, 6.0], '#d8e0ec', 0.65); // 正面微弱中性补光

  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      (o.material as MeshBasicMaterial).dispose();
    }
  });
  return rt.texture;
}
