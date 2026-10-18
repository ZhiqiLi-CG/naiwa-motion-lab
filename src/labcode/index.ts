/**
 * The in-page code lab: users edit, apply and compare their own blocks of the simulator and of motion transfer
 * (docs/simulator-api.md, docs/motion-api.md), with each block's learning page next to the code.
 *
 *   const codeLab = mountCodeLab({ host, store, spec: () => character?.spec ?? null, binding: () => motion.binding(), toast });
 *   await codeLab.ready;                          // before the simulation is built at boot
 *   openCodeLab({ kind: "simulator" });           // the Lab's "编辑代码 / Edit code"
 */
export { mountCodeLab, openCodeLab, type CodeLab, type CodeLabOptions, type CodeLabTarget } from "./panel";
export { LAB_ASSEMBLY } from "./lab";
export type { CoreKind } from "./catalog";
