/**
 * The learning pages' formulas as plain text: the page has no math typesetter, so the TeX the pages use (Greek
 * letters, fractions, matrices, hats, scripts, a few operators) becomes readable Unicode: `\hat x_{k+1}` → `x̂ₖ₊₁`,
 * `\frac{a}{b}` → `a/b`, `\begin{bmatrix}1 & t\\ 0 & 1\end{bmatrix}` → `[1 t; 0 1]`. Unknown commands keep their name.
 */

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ",
  chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ",
  Psi: "Ψ", Omega: "Ω", ell: "ℓ", partial: "∂", nabla: "∇", infty: "∞", cdot: "·", times: "×", pm: "±", le: "≤",
  leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", to: "→", rightarrow: "→", leftarrow: "←",
  Rightarrow: "⇒", mapsto: "↦", in: "∈", sum: "Σ", prod: "Π", int: "∫", top: "ᵀ", circ: "∘", lVert: "‖", rVert: "‖",
  "|": "‖", lvert: "|", rvert: "|", langle: "⟨", rangle: "⟩", quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ",
  "!": "", " ": " ", min: "min", max: "max", arg: "arg", argmin: "argmin", argmax: "argmax", log: "log", exp: "exp",
  sin: "sin", cos: "cos", tan: "tan", det: "det", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", dots: "…",
  ldots: "…", cdots: "⋯", "{": "{", "}": "}", "%": "%", "#": "#", "&": "&", _: "_",
};
const ACCENTS: Record<string, string> = { hat: "̂", widehat: "̂", bar: "̄", overline: "̅", dot: "̇", ddot: "̈", tilde: "̃", vec: "⃗" };
const PLAIN = new Set(["text", "mathrm", "mathbf", "mathit", "mathsf", "mathcal", "mathbb", "boldsymbol", "operatorname", "textrm", "textbf"]);
const DROP = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "displaystyle", "limits"]);
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", T: "ᵀ", k: "ᵏ", t: "ᵗ", ᵀ: "ᵀ", "*": "*", "′": "′" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };

/** Readable text for a TeX formula. */
export function texToText(src: string): string {
  let i = 0;
  /** One group `{…}`, one command, or one character. */
  function atom(): string {
    skipSpace();
    if (i >= src.length) return "";
    const c = src[i];
    if (c === "{") {
      i++;
      const out = until("}");
      i++;
      return out;
    }
    if (c === "\\") return command();
    i++;
    return c;
  }
  function skipSpace() {
    while (i < src.length && src[i] === " ") i++;
  }
  /** Everything up to the closing character (not consumed), at this nesting level. */
  function until(close: string): string {
    let out = "";
    while (i < src.length && src[i] !== close) out += piece();
    return out;
  }
  function script(map: Record<string, string>, mark: string): string {
    const body = atom();
    const chars = [...body];
    if (chars.length && chars.every((ch) => ch in map)) return chars.map((ch) => map[ch]).join("");
    return chars.length === 1 ? `${mark}${body}` : `${mark}(${body})`;
  }
  function command(): string {
    i++;
    const m = /^[A-Za-z]+/.exec(src.slice(i));
    const name = m ? m[0] : src[i] ?? "";
    i += name.length || 1;
    if (name === "\\") return "; ";
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = atom(), b = atom();
      const wrap = (s: string) => (/^[\p{L}\p{N}.ᵀ̀-ͯ]+$/u.test(s) ? s : `(${s})`);
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (name === "sqrt") return `√(${atom()})`;
    if (name === "begin" || name === "end") {
      const env = atom();
      if (/matrix/.test(env)) return name === "begin" ? "[" : "]";
      return env === "cases" ? (name === "begin" ? "{ " : "") : "";
    }
    if (name in ACCENTS) {
      const body = atom();
      return [...body].length === 1 ? body + ACCENTS[name] : `${body}${ACCENTS[name]}`;
    }
    if (PLAIN.has(name)) return atom();
    if (DROP.has(name)) return "";
    if (name in SYMBOLS) return SYMBOLS[name];
    return name;
  }
  function piece(): string {
    const c = src[i];
    if (c === "\\") return command();
    if (c === "{") return atom();
    if (c === "^") {
      i++;
      return script(SUP, "^");
    }
    if (c === "_") {
      i++;
      return script(SUB, "_");
    }
    if (c === "&") {
      i++;
      return " ";
    }
    i++;
    return c;
  }
  let out = "";
  while (i < src.length) out += src[i] === "}" ? (i++, "") : piece();
  return out.replace(/[ \t]+/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]").replace(/ ; /g, "; ").replace(/;\s*\]/g, "]").trim();
}
