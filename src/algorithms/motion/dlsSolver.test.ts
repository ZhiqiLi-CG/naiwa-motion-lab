import { it } from "vitest";
import { checkSolver } from "./testSupport";

it("damped least squares reaches the wrist targets from rest and keeps the limbs out of the body on dances", () => checkSolver("dls-ik", "dls"), 30000);
