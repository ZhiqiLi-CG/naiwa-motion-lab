import { it } from "vitest";
import { checkSolver } from "./testSupport";

it("FABRIK reaches the wrist targets from rest and keeps the limbs out of the body on dances", () => checkSolver("fabrik-ik", "fabrik"), 30000);
