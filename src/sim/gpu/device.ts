/**
 * What this browser can run the GPU example on, probed once at start-up (initPhysics awaits `probeDevices()`), then
 * read synchronously by the blocks' available() / backend().
 *
 *   webgpu        a WebGPU adapter that is a real GPU (not the fallback or a software rasteriser)
 *   cpu-parallel  no usable GPU: the same algorithm on Web Workers over SharedArrayBuffer (needs cross-origin isolation)
 *   cpu-inline    neither: one thread, on the page's own thread (tests in Node; too slow for the page)
 */
import type { Text } from "../../i18n";
import { navigatorGpu, type GpuAdapter, type GpuDevice } from "./webgpu";

export type BackendKind = "webgpu" | "cpu-parallel" | "cpu-inline";

export interface GpuInfo {
  vendor: string;
  architecture: string;
  description: string;
  /** The limits this simulator depends on. */
  limits: { maxStorageBuffersPerShaderStage: number; maxComputeWorkgroupSizeX: number; maxBufferSize: number; maxStorageBufferBindingSize: number };
  timestamps: boolean;
}

export interface DeviceProbe {
  /** A usable GPU, or null with the reason in `gpuMissing`. */
  gpu: GpuInfo | null;
  gpuMissing: string | null;
  cpu: {
    /** crossOriginIsolated and SharedArrayBuffer present, and Workers exist. */
    parallel: boolean;
    threads: number;
    /** Workers the CPU-parallel backend starts: the cores less the page's own thread and the compositor. */
    workers: number;
  };
}

/** Adapters that are a CPU pretending to be a GPU. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render|\bwarp\b|software/i;
const MAX_WORKERS = 12;

let probe: DeviceProbe | null = null;
let pending: Promise<DeviceProbe> | null = null;
let adapter: GpuAdapter | null = null;
let device: Promise<GpuDevice> | null = null;
let forced: BackendKind | null = null;

/** Probe the GPU and the CPU once; later calls return the same result. Never rejects. */
export function probeDevices(): Promise<DeviceProbe> {
  return (pending ??= run().then((p) => (probe = p)));
}

/** The probe's result, or null before probeDevices() resolved. */
export function deviceProbe(): DeviceProbe | null {
  return probe;
}

/** Force a backend (the dev page's ?backend=, tests); null goes back to the probe's choice. */
export function forceBackend(kind: BackendKind | null): void {
  forced = kind;
}

/** The backend the GPU example uses here: the forced one if it can run, else the best that can. */
export function chooseBackend(): BackendKind {
  const p = probe;
  if (forced === "webgpu" && p?.gpu) return "webgpu";
  if (forced === "cpu-parallel" && p?.cpu.parallel) return "cpu-parallel";
  if (forced === "cpu-inline") return "cpu-inline";
  if (forced === null && p?.gpu) return "webgpu";
  return p?.cpu.parallel ? "cpu-parallel" : "cpu-inline";
}

/** null when the GPU example can run here at an interactive rate, else why not. */
export function unavailableReason(): Text | null {
  if (!probe || chooseBackend() !== "cpu-inline" || forced === "cpu-inline") return null;
  return {
    zh: `没有可用的 GPU（${probe.gpuMissing ?? "无 WebGPU"}），页面也没有跨源隔离（无 SharedArrayBuffer），无法用 CPU 并行`,
    en: `no usable GPU (${probe.gpuMissing ?? "no WebGPU"}) and the page is not cross-origin isolated (no SharedArrayBuffer), so no CPU-parallel fallback`,
  };
}

/** What the GPU example runs on here, for the Lab. */
export function backendLabel(): Text | string | null {
  if (!probe) return null;
  const kind = chooseBackend();
  if (kind === "webgpu" && probe.gpu) {
    const g = probe.gpu;
    const name = [g.vendor && g.vendor.toUpperCase(), g.architecture || g.description].filter(Boolean).join(" ");
    return name ? `WebGPU · ${name}` : "WebGPU";
  }
  if (kind === "cpu-parallel") {
    const n = probe.cpu.workers;
    return { zh: `CPU 并行 · ${n} 线程`, en: `CPU parallel · ${n} workers` };
  }
  return { zh: "CPU · 单线程", en: "CPU · 1 thread" };
}

/** The shared GPUDevice (created on first use, with the limits the simulator needs). */
export function gpuDevice(): Promise<GpuDevice> {
  if (!adapter) return Promise.reject(new Error("sim/gpu: no usable WebGPU adapter"));
  const a = adapter;
  return (device ??= a.requestDevice({
    label: "naiwa-mpm",
    requiredFeatures: a.features.has("timestamp-query") ? ["timestamp-query"] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(a.limits.maxStorageBufferBindingSize, 1 << 30),
      maxBufferSize: Math.min(a.limits.maxBufferSize, 1 << 30),
    },
  }).then((d) => {
    // A lost device (driver reset, tab in the background for long) is reported; the next simulator build retries.
    void d.lost.then((info) => {
      console.warn("sim/gpu: WebGPU device lost:", info.message);
      device = null;
    });
    return d;
  }));
}

async function run(): Promise<DeviceProbe> {
  const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number }; Worker?: unknown };
  const threads = g.navigator?.hardwareConcurrency ?? 1;
  const parallel = g.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined" && typeof g.Worker === "function";
  const cpu = { parallel, threads, workers: Math.max(1, Math.min(MAX_WORKERS, threads - 2)) };
  const { info, missing } = await probeGpu();
  return { gpu: info, gpuMissing: missing, cpu };
}

async function probeGpu(): Promise<{ info: GpuInfo | null; missing: string | null }> {
  const gpu = navigatorGpu();
  if (!gpu) return { info: null, missing: "no WebGPU" };
  try {
    const a = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!a) return { info: null, missing: "no WebGPU adapter" };
    const i = a.info ?? {};
    const text = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" ");
    if (i.isFallbackAdapter || a.isFallbackAdapter) return { info: null, missing: "fallback adapter" };
    if (SOFTWARE.test(text)) return { info: null, missing: `software adapter (${text})` };
    const limits = {
      maxStorageBuffersPerShaderStage: a.limits.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupSizeX: a.limits.maxComputeWorkgroupSizeX,
      maxBufferSize: a.limits.maxBufferSize,
      maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
    };
    if (limits.maxStorageBuffersPerShaderStage < 6) return { info: null, missing: "too few storage buffers" };
    adapter = a;
    return {
      info: {
        vendor: i.vendor ?? "", architecture: i.architecture ?? "", description: i.description ?? "", limits,
        timestamps: a.features.has("timestamp-query"),
      },
      missing: null,
    };
  } catch (e) {
    return { info: null, missing: `WebGPU error: ${(e as Error).message}` };
  }
}
