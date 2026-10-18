import { it } from "vitest";
import { checkSolver } from "./testSupport";

it("CCD reaches the wrist targets from rest and keeps the limbs out of the body on dances", () => checkSolver("ccd-ik", "ccd"), 30000);
