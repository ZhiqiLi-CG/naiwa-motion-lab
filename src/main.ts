/** Integration: wires stage, character, simulation, motion, media and UI together (owned by the integrator). */
import { createStore } from "./store";

const store = createStore();
console.info("naiwa-playground boot", store.get().mode);
