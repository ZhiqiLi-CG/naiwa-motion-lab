/**
 * A user's block runs inside the page's frame loop, so its first exception is caught where it happens: the block's
 * definition is wrapped so that building it and every method of what it builds report the error (the lab then falls
 * back to the previous block) before passing it on. The rest of that frame is lost; the next one runs without it.
 */
import type { Text } from "../i18n";

interface Definition {
  id: string;
  create(...args: never[]): unknown;
  available?(): Text | null;
  backend?(): Text | string | null;
}

export type Report = (err: Error) => void;

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** The definition with `id`, its errors reported. */
export function guarded<D extends Definition>(def: D, id: string, report: Report): D {
  const create = def.create as (...args: unknown[]) => unknown;
  return {
    ...def,
    id,
    create: (...args: unknown[]) => {
      try {
        const built = create.apply(def, args);
        if (built instanceof Promise) {
          return built.then(
            (b) => wrap(b, report),
            (e) => {
              report(asError(e));
              throw e;
            },
          );
        }
        return wrap(built, report);
      } catch (e) {
        report(asError(e));
        throw e;
      }
    },
    // The lists call these while drawing: an error there must not take the Lab panel down.
    available: def.available
      ? () => {
          try {
            return def.available!();
          } catch (e) {
            report(asError(e));
            return { zh: `出错：${asError(e).message}`, en: `error: ${asError(e).message}` };
          }
        }
      : undefined,
    backend: def.backend
      ? () => {
          try {
            return def.backend!();
          } catch {
            return null;
          }
        }
      : undefined,
  };
}

/** The built block with each method reporting what it throws. */
function wrap<T>(block: T, report: Report): T {
  if (typeof block !== "object" || block === null) return block;
  const cache = new Map<PropertyKey, { fn: unknown; wrapped: unknown }>();
  return new Proxy(block as object, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function" || key === "constructor") return value;
      const hit = cache.get(key);
      if (hit && hit.fn === value) return hit.wrapped;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          report(asError(e));
          throw e;
        }
      };
      cache.set(key, { fn: value, wrapped });
      return wrapped;
    },
  }) as T;
}
