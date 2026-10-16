/** The set: a sky dome and an endless floor with a lily-pad play mat. Both are unlit shaders so the floor melts into
 *  the horizon without a seam; the floor still takes the key light's shadow and the contact shadow. */
import * as THREE from "three";
import type { StageTheme } from "./palette";

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // on the far plane: behind everything, whatever the camera does
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uDecor;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(-0.02, 0.35, e));

  // A lat-long grid of cells, each with one bubble or star; faded near the zenith where the grid pinches.
  vec2 g = vec2(atan(d.x, d.z) * 7.0 / 3.14159265, e * 9.0);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash12(cell);
  vec2 o = vec2(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
  float r = length(f - o * 0.5);
  float fade = smoothstep(0.03, 0.15, e) * (1.0 - smoothstep(0.55, 0.85, e));
  float aa = fwidth(r) * 1.5;
  if (uStars > 0.5) {
    float size = 0.03 + 0.05 * h * h;
    float tw = 0.65 + 0.35 * sin(uTime * (1.5 + 2.0 * h) + h * 40.0);
    float star = (1.0 - smoothstep(size - aa, size + aa, r)) * step(0.45, h);
    float glow = exp(-r * r * 90.0) * 0.25 * step(0.45, h);
    col = mix(col, uDecor, clamp(star * tw + glow, 0.0, 1.0) * fade);
  } else {
    float size = 0.12 + 0.2 * h;
    float bubble = (1.0 - smoothstep(size - aa, size + aa, r)) * step(0.62, h);
    float ring = (1.0 - smoothstep(0.0, aa * 2.0, abs(r - size + 0.02))) * step(0.62, h);
    col = mix(col, uDecor, (bubble * 0.16 + ring * 0.18) * fade);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const FLOOR_VERT = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
varying vec3 vWorld;
void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
}`;

const FLOOR_FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform vec3 uFloor;
uniform vec3 uDot;
uniform vec3 uPad;
uniform vec3 uPadRim;
uniform vec3 uPadVein;
uniform vec3 uHorizon;
uniform vec3 uShadowTint;
uniform vec3 uContactTint;
uniform vec3 uPool;
uniform float uPoolStrength;
uniform vec2 uCenter;
uniform sampler2D uContactMap;
uniform vec4 uContactRect; // centre xz, size
varying vec3 vWorld;

void main() {
  vec2 p = vWorld.xz;
  vec3 col = uFloor;

  // Polka dots on staggered rows, fixed in the world so the floor shows motion when the camera follows.
  vec2 q = p / 0.42;
  q.x += 0.5 * mod(floor(q.y), 2.0);
  float rd = length(fract(q) - 0.5);
  float aaD = fwidth(rd);
  float dots = (1.0 - smoothstep(0.17 - aaD, 0.17 + aaD, rd)) * (1.0 - smoothstep(0.06, 0.16, aaD)) *
    (1.0 - smoothstep(3.0, 7.0, length(p - uCenter)));
  col = mix(col, uDot, dots);

  // Lily-pad mat: a disc with a notch towards the back and a few veins.
  float r = length(p);
  float aa = fwidth(r) * 1.2;
  float ang = atan(p.x, -p.y); // 0 = straight back (-z)
  float notch = (1.0 - smoothstep(0.17, 0.19, abs(ang))) * smoothstep(0.05, 0.12, r);
  float pad = (1.0 - smoothstep(1.1 - aa, 1.1 + aa, r)) * (1.0 - notch);
  float rim = smoothstep(0.98 - aa, 0.98 + aa, r);
  float veinDist = r * abs(sin(ang * 4.0)) / 4.0; // distance to the nearest of 8 radial lines
  float vein = (1.0 - smoothstep(0.012, 0.012 + aa, veinDist)) * smoothstep(0.15, 0.35, r) *
    (1.0 - smoothstep(0.8, 0.95, r));
  vec3 padCol = mix(mix(uPad, uPadVein, vein * 0.8), uPadRim, rim);
  col = mix(col, padCol, pad);

  // Warm pool of light around the frog.
  float pool = exp(-dot(p - uCenter, p - uCenter) / 2.2);
  col += uPool * pool * uPoolStrength;

  // Key light shadow (tinted, cartoon style) and the contact shadow right under things.
  col *= mix(uShadowTint, vec3(1.0), getShadowMask());
  vec2 cuv = (p - uContactRect.xy) / uContactRect.zw + 0.5;
  float inside = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
  float contact = texture2D(uContactMap, cuv).a * inside;
  col *= mix(vec3(1.0), uContactTint, contact);

  // Melt into the horizon.
  float far = smoothstep(5.0, 22.0, length(p - uCenter));
  col = mix(col, uHorizon, far);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface StageSet {
  readonly sky: THREE.Mesh;
  readonly floor: THREE.Mesh;
  apply(theme: StageTheme): void;
  update(time: number, camera: THREE.Camera, center: THREE.Vector3): void;
  setContact(map: THREE.Texture, centerX: number, centerZ: number, size: number): void;
  dispose(): void;
}

export function createSet(): StageSet {
  const c = () => ({ value: new THREE.Color() });
  const skyUniforms = { uTop: c(), uHorizon: c(), uDecor: c(), uStars: { value: 0 }, uTime: { value: 0 } };
  const skyGeo = new THREE.SphereGeometry(50, 48, 24);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = "stage-sky";
  sky.renderOrder = -10;
  sky.frustumCulled = false;

  const floorMat = new THREE.ShaderMaterial({
    lights: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        uFloor: c(),
        uDot: c(),
        uPad: c(),
        uPadRim: c(),
        uPadVein: c(),
        uHorizon: c(),
        uShadowTint: c(),
        uContactTint: c(),
        uPool: c(),
        uPoolStrength: { value: 0 },
        uCenter: { value: new THREE.Vector2() },
        uContactMap: { value: null },
        uContactRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
    ]),
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
  });
  const fu = floorMat.uniforms;
  const floorGeo = new THREE.CircleGeometry(48, 96).rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.name = "stage-floor";
  floor.receiveShadow = true;
  floor.renderOrder = -5;

  return {
    sky,
    floor,
    apply(t) {
      skyUniforms.uTop.value.set(t.skyTop);
      skyUniforms.uHorizon.value.set(t.skyHorizon);
      skyUniforms.uDecor.value.set(t.decorColor);
      skyUniforms.uStars.value = t.decor === "stars" ? 1 : 0;
      fu.uFloor.value.set(t.floor);
      fu.uDot.value.set(t.floorDot);
      fu.uPad.value.set(t.pad);
      fu.uPadRim.value.set(t.padRim);
      fu.uPadVein.value.set(t.padVein);
      fu.uHorizon.value.set(t.skyHorizon);
      fu.uShadowTint.value.set(t.shadowTint);
      fu.uContactTint.value.set(t.contactTint);
      fu.uPool.value.set(t.pool);
      fu.uPoolStrength.value = t.poolStrength;
    },
    update(time, camera, center) {
      skyUniforms.uTime.value = time;
      sky.position.copy(camera.position);
      (fu.uCenter.value as THREE.Vector2).set(center.x, center.z);
    },
    setContact(map, x, z, size) {
      fu.uContactMap.value = map;
      (fu.uContactRect.value as THREE.Vector4).set(x, z, size, size);
    },
    dispose() {
      skyGeo.dispose();
      skyMat.dispose();
      floorGeo.dispose();
      floorMat.dispose();
    },
  };
}
