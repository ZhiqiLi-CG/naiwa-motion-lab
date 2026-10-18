/** The built-in retargeting blocks and the default retargeter assembled from them. */
import { registerRetargetBlock, registerRetargeter } from "../registry";
import { frogBody } from "./frogBody";
import { oneEuroFilter } from "./oneEuroFilter";
import { personDirections } from "./personDirections";
import { plantedRotations } from "./plantedRotations";
import { projectedDirections } from "./projectedDirections";

export const DEFAULT_RETARGETER = "direction-copy";

let registered = false;
/** Register the built-ins (once). */
export function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  for (const def of [oneEuroFilter, frogBody, personDirections, projectedDirections, plantedRotations]) registerRetargetBlock(def, "builtin");
  registerRetargeter({
    id: DEFAULT_RETARGETER,
    name: { zh: "方向拷贝 + 身体约束", en: "Direction copy under body constraints" },
    summary: {
      zh: "One Euro 滤波后拷贝人的躯干和四肢方向，再把四肢逐段投影到奶蛙身体之外、限制关节弯曲，脚踩在地上。",
      en: "One Euro filtering, then the person's torso and limb directions copied onto the frog, each limb segment projected out of its body under joint limits, feet on the floor.",
    },
    blocks: {
      filter: oneEuroFilter.id, constraints: frogBody.id, goal: personDirections.id, solver: projectedDirections.id, output: plantedRotations.id,
    },
  }, "builtin");
}
