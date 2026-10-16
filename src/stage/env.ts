/** Image-based lighting made in code: a gradient dome with soft light panels, prefiltered by PMREM (nothing is
 *  downloaded). Soft wrap-around light is what makes a vinyl toy look round and friendly. */
import * as THREE from "three";
import type { EnvLook } from "./palette";

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Rendered into PMREM's linear float target: no tone mapping or output conversion.
const DOME_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
varying vec3 vDir;
void main() {
  float e = normalize(vDir).y;
  vec3 c = e > 0.0 ? mix(uHorizon, uTop, smoothstep(0.0, 0.7, e)) : mix(uHorizon, uGround, smoothstep(0.0, -0.25, e));
  gl_FragColor = vec4(c, 1.0);
}`;

const linear = (hex: number, intensity: number) => new THREE.Color(hex).multiplyScalar(intensity);

export function buildEnvironment(renderer: THREE.WebGLRenderer, look: EnvLook): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];

  const domeGeo = new THREE.SphereGeometry(20, 48, 24);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: linear(look.top, look.domeIntensity) },
      uHorizon: { value: linear(look.horizon, look.domeIntensity) },
      uGround: { value: linear(look.ground, look.domeIntensity) },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
  });
  scene.add(new THREE.Mesh(domeGeo, domeMat));
  disposables.push(domeGeo, domeMat);

  const panelGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(panelGeo);
  for (const p of look.panels) {
    const mat = new THREE.MeshBasicMaterial({ color: linear(p.color, p.intensity), side: THREE.DoubleSide });
    const panel = new THREE.Mesh(panelGeo, mat);
    panel.position.set(...p.position);
    panel.scale.set(p.size[0], p.size[1], 1);
    panel.lookAt(0, 0.5, 0);
    scene.add(panel);
    disposables.push(mat);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04, 0.1, 50, { size: 256, position: new THREE.Vector3(0, 0.5, 0) });
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return target;
}
