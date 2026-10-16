/** Contact shadow: the scene seen from the floor upwards, as darkness that fades with height, blurred. It grounds
 *  the frog's feet and the balls far better than the key light's shadow alone. Small target, two blur passes. */
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";

const RES = 256;

export interface ContactShadow {
  readonly texture: THREE.Texture;
  /** Size of the square it covers (meters) and its centre (snapped to texels so it does not shimmer). */
  readonly size: number;
  readonly center: THREE.Vector2;
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D[], around: THREE.Vector3): void;
  dispose(): void;
}

export function createContactShadow(size = 3, height = 0.9, darkness = 0.85): ContactShadow {
  const opts = { type: THREE.HalfFloatType, depthBuffer: false } as const;
  const rtA = new THREE.WebGLRenderTarget(RES, RES, opts);
  const rtB = new THREE.WebGLRenderTarget(RES, RES, opts);
  rtA.texture.generateMipmaps = false;
  rtB.texture.generateMipmaps = false;

  const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
  cam.rotation.x = Math.PI / 2; // looking up: image right = +x, image up = +z

  const depthMat = new THREE.MeshDepthMaterial();
  // No depth test and blended: overlapping layers (belly over feet) add up, which reads as soft occlusion.
  depthMat.depthTest = false;
  depthMat.depthWrite = false;
  depthMat.transparent = true;
  depthMat.onBeforeCompile = (shader) => {
    const from = "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );";
    if (!shader.fragmentShader.includes(from)) throw new Error("contact shadow: depth shader changed");
    shader.fragmentShader = shader.fragmentShader.replace(
      from,
      `gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 1.6 ) * ${darkness.toFixed(3)} );`,
    );
  };

  const blurH = new THREE.ShaderMaterial(HorizontalBlurShader);
  const blurV = new THREE.ShaderMaterial(VerticalBlurShader);
  blurH.depthTest = blurV.depthTest = false;
  const quad = new FullScreenQuad(blurH);
  const center = new THREE.Vector2();
  const texel = size / RES;
  const clear = new THREE.Color(0, 0, 0);
  const saved = new THREE.Color();

  const blur = (renderer: THREE.WebGLRenderer, amount: number) => {
    quad.material = blurH;
    blurH.uniforms.tDiffuse.value = rtA.texture;
    blurH.uniforms.h.value = amount / RES;
    renderer.setRenderTarget(rtB);
    quad.render(renderer);
    quad.material = blurV;
    blurV.uniforms.tDiffuse.value = rtB.texture;
    blurV.uniforms.v.value = amount / RES;
    renderer.setRenderTarget(rtA);
    quad.render(renderer);
  };

  return {
    texture: rtA.texture,
    size,
    center,
    render(renderer, scene, hide, around) {
      center.set(Math.round(around.x / texel) * texel, Math.round(around.z / texel) * texel);
      cam.position.set(center.x, 0, center.y);
      cam.updateMatrixWorld();

      const background = scene.background;
      const visible = hide.map((o) => o.visible);
      for (const o of hide) o.visible = false;
      scene.background = null;
      scene.overrideMaterial = depthMat;
      renderer.getClearColor(saved);
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(clear, 0);

      renderer.setRenderTarget(rtA);
      renderer.clear();
      renderer.render(scene, cam);
      blur(renderer, 3.5);
      blur(renderer, 1.4);

      renderer.setRenderTarget(null);
      renderer.setClearColor(saved, alpha);
      scene.overrideMaterial = null;
      scene.background = background;
      hide.forEach((o, i) => (o.visible = visible[i]));
    },
    dispose() {
      rtA.dispose();
      rtB.dispose();
      depthMat.dispose();
      blurH.dispose();
      blurV.dispose();
      quad.dispose();
    },
  };
}
