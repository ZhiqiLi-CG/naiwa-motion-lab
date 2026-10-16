// Write the test session (src/session/testSession.ts) for the character GLB:
//   npx vite-node tools/genesis-hd/make_test_session.ts [public/models/naiwa.glb] [out.session.json]
import { readFileSync, writeFileSync } from "node:fs";
import { makeTestSession, restSkeletonFromGlb } from "../../src/session/testSession";

const [glbPath = "public/models/naiwa.glb", out = ".cache/genesis-hd/test.session.json"] = process.argv.slice(2);
const glb = readFileSync(glbPath);
const session = makeTestSession(restSkeletonFromGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)));
const text = JSON.stringify(session);
writeFileSync(out, text);
console.log(`${out}: ${session.frameCount} frames, ${(text.length / 1024).toFixed(0)} KiB`);
