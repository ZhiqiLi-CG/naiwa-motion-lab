/**
 * The part of the WebGPU API this simulator uses, typed locally: the project's TypeScript lib has no WebGPU types and
 * we add no dependency for them. Kept minimal and module-scoped (no globals), so real @webgpu/types can replace it.
 */

export interface GpuAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

export interface GpuAdapter {
  readonly info?: GpuAdapterInfo;
  /** Older Chrome: on the adapter itself. */
  readonly isFallbackAdapter?: boolean;
  readonly features: ReadonlySet<string>;
  readonly limits: Record<string, number>;
  requestDevice(desc?: { requiredFeatures?: string[]; requiredLimits?: Record<string, number>; label?: string }): Promise<GpuDevice>;
}

export interface Gpu {
  requestAdapter(options?: { powerPreference?: "high-performance" | "low-power" }): Promise<GpuAdapter | null>;
}

export interface GpuBuffer {
  readonly size: number;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export type GpuBindGroupLayout = object;
export type GpuBindGroup = object;
export type GpuShaderModule = object;
export type GpuPipelineLayout = object;
export type GpuQuerySet = object & { destroy(): void };

export interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}

export interface GpuComputePass {
  setPipeline(p: GpuComputePipeline): void;
  setBindGroup(index: number, group: GpuBindGroup, dynamicOffsets?: number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}

export interface GpuCommandEncoder {
  beginComputePass(desc?: {
    timestampWrites?: { querySet: GpuQuerySet; beginningOfPassWriteIndex?: number; endOfPassWriteIndex?: number };
  }): GpuComputePass;
  copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void;
  clearBuffer(buffer: GpuBuffer, offset?: number, size?: number): void;
  resolveQuerySet(q: GpuQuerySet, first: number, count: number, dst: GpuBuffer, dstOffset: number): void;
  finish(): object;
}

export interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset?: number, size?: number): void;
  submit(commands: object[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

export interface GpuDevice {
  readonly queue: GpuQueue;
  readonly limits: Record<string, number>;
  readonly features: ReadonlySet<string>;
  readonly lost: Promise<{ reason: string; message: string }>;
  createBuffer(desc: { size: number; usage: number; label?: string; mappedAtCreation?: boolean }): GpuBuffer;
  createShaderModule(desc: { code: string; label?: string }): GpuShaderModule & {
    getCompilationInfo?(): Promise<{ messages: readonly { type: string; message: string; lineNum: number }[] }>;
  };
  createBindGroupLayout(desc: {
    entries: {
      binding: number;
      visibility: number;
      buffer: { type: "uniform" | "storage" | "read-only-storage"; hasDynamicOffset?: boolean };
    }[];
    label?: string;
  }): GpuBindGroupLayout;
  createPipelineLayout(desc: { bindGroupLayouts: GpuBindGroupLayout[]; label?: string }): GpuPipelineLayout;
  createComputePipelineAsync(desc: {
    layout: "auto" | GpuPipelineLayout;
    compute: { module: GpuShaderModule; entryPoint: string };
    label?: string;
  }): Promise<GpuComputePipeline>;
  createBindGroup(desc: {
    layout: GpuBindGroupLayout;
    entries: { binding: number; resource: { buffer: GpuBuffer; offset?: number; size?: number } }[];
  }): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  createQuerySet(desc: { type: "timestamp"; count: number }): GpuQuerySet;
  pushErrorScope(filter: "validation" | "out-of-memory" | "internal"): void;
  popErrorScope(): Promise<{ message: string } | null>;
  destroy(): void;
}

/** GPUBufferUsage and GPUMapMode, as numbers (the globals are absent outside browsers). */
export const BUFFER = {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008, INDEX: 0x0010, VERTEX: 0x0020,
  UNIFORM: 0x0040, STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
} as const;
export const MAP_READ = 0x0001;
export const SHADER_STAGE_COMPUTE = 0x4;

export function navigatorGpu(): Gpu | null {
  const nav = (globalThis as { navigator?: { gpu?: Gpu } }).navigator;
  return nav?.gpu ?? null;
}
