/** The simulation's balls: one instanced draw of glossy candy spheres, a stable colour per ball slot. */
import * as THREE from "three";
import { BALL_COLORS } from "./palette";

export interface Balls {
  /** Holds the instanced mesh (replaced when more balls than its capacity arrive). */
  readonly object: THREE.Group;
  /** xyz + radius per ball. */
  set(balls: Float32Array): void;
  dispose(): void;
}

export function createBalls(): Balls {
  const geo = new THREE.SphereGeometry(1, 32, 20);
  const mat = new THREE.MeshPhysicalMaterial({
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    sheen: 0.4,
    sheenRoughness: 0.5,
  });
  const object = new THREE.Group();
  object.name = "stage-balls";
  const m = new THREE.Matrix4();
  const color = new THREE.Color();

  const make = (capacity: number) => {
    const im = new THREE.InstancedMesh(geo, mat, capacity);
    im.castShadow = true;
    im.receiveShadow = true;
    im.count = 0;
    im.frustumCulled = false; // its bounds would need recomputing every frame
    for (let i = 0; i < capacity; i++) im.setColorAt(i, color.set(BALL_COLORS[i % BALL_COLORS.length]));
    object.add(im);
    return im;
  };
  let mesh = make(64);

  return {
    object,
    set(balls) {
      const n = Math.floor(balls.length / 4);
      if (n > mesh.instanceMatrix.count) {
        const grown = make(Math.max(n, mesh.instanceMatrix.count * 2));
        object.remove(mesh);
        mesh.dispose();
        mesh = grown;
      }
      for (let i = 0; i < n; i++) {
        const r = balls[i * 4 + 3];
        m.makeScale(r, r, r).setPosition(balls[i * 4], balls[i * 4 + 1], balls[i * 4 + 2]);
        mesh.setMatrixAt(i, m);
      }
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
