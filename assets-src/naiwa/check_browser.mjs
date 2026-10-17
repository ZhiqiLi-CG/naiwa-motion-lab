// Load the actual delivery GLB with the repository's Three.js in headless Chrome.
// Run: node assets-src/naiwa/check_browser.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const html = `<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body><script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
try {
  const gltf=await new GLTFLoader().loadAsync('/naiwa.glb');
  const scene=new THREE.Scene();scene.background=new THREE.Color(0xf3f2ed);
  scene.add(gltf.scene);gltf.scene.updateMatrixWorld(true);
  const meshes=[];gltf.scene.traverse(o=>{if(o.isMesh) meshes.push(o)});
  const body=gltf.scene.getObjectByName('Body');
  const names=meshes.map(m=>m.name).sort();
  const expected=['Arms','Body','Eyes','Legs','MouthInside'];
  if(JSON.stringify(names)!==JSON.stringify(expected)) throw Error('Mesh names: '+names);
  if(meshes.some(m=>!m.isSkinnedMesh)) throw Error('Unskinned mesh');
  if(meshes.some(m=>(m.morphTargetInfluences||[]).some(w=>Math.abs(w)>1e-8))) throw Error('Nonzero default morph weights');
  const fleshSoftness={};
  for(const name of ['Body','Arms','Legs']) {
    const attr=gltf.scene.getObjectByName(name).geometry.getAttribute('_softness');
    if(!attr || attr.count!==gltf.scene.getObjectByName(name).geometry.attributes.position.count) throw Error('Missing Three _softness on '+name);
    const values=Array.from(attr.array);
    if(values.some(v=>!Number.isFinite(v)||v<0||v>1)) throw Error('Invalid softness on '+name);
    fleshSoftness[name]={count:attr.count,min:Math.min(...values),max:Math.max(...values)};
  }
  if(!body.material.map?.image) throw Error('Embedded belly texture failed to load');
  const box=new THREE.Box3().setFromObject(gltf.scene);
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(720,800);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
  document.body.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff,0x8b7957,2));
  const key=new THREE.DirectionalLight(0xfff8e7,3);key.position.set(-2,4,3);scene.add(key);
  const camera=new THREE.PerspectiveCamera(32,720/800,.01,20);camera.position.set(1.15,.85,2.05);camera.lookAt(0,.51,0);
  renderer.render(scene,camera);
  window.result={passed:true,mesh_names:names,all_skinned:true,neutral_morph_defaults:true,three_softness_attribute:true,
    flesh_softness:fleshSoftness,embedded_texture_loaded:true,animation_clips:gltf.animations.length,
    height_m:box.max.y-box.min.y,floor_y:box.min.y,
    skeleton_bones:body.skeleton.bones.map(b=>b.name),
    morph_names:Object.fromEntries(meshes.map(m=>[m.name,Object.keys(m.morphTargetDictionary||{})]))};
} catch(e) {window.result={passed:false,error:String(e),stack:e.stack};}
</script></body></html>`;

const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    let path;
    if(req.url==='/naiwa.glb') path=resolve(root,'public/models/naiwa.glb');
    else if(req.url?.startsWith('/three/')) {
      path=resolve(root,'node_modules/three',req.url.slice('/three/'.length));
      if(!path.startsWith(resolve(root,'node_modules/three')+'/')) throw Error('Invalid path');
    } else {res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'model/gltf-binary');
    res.end(await readFile(path));
  } catch(e){res.statusCode=500;res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage();await page.setViewport({width:720,height:800});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>window.result,{timeout:30000});
  const report=await page.evaluate(()=>window.result);
  report.glb_sha256=createHash('sha256').update(await readFile(resolve(root,'public/models/naiwa.glb'))).digest('hex');
  await writeFile(resolve(here,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
  if(!report.passed) throw Error(JSON.stringify(report));
  await page.screenshot({path:resolve(here,'renders/09_browser_rest.png')});
  console.log(JSON.stringify(report,null,2));
} finally {
  if(browser) await browser.close();
  await new Promise(r=>server.close(r));
}
