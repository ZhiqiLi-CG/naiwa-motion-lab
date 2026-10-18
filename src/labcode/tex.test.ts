import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { texToText } from "./tex";

describe("texToText", () => {
  it("writes the learning pages' formulas readably", () => {
    expect(texToText("x = [p, v]")).toBe("x = [p, v]");
    expect(texToText("\\Delta t")).toBe("Δ t");
    expect(texToText("F = \\begin{bmatrix}1 & \\Delta t\\\\ 0 & 1\\end{bmatrix}")).toBe("F = [1 Δ t; 0 1]");
    expect(texToText("P^- = F P F^\\top + Q")).toBe("P⁻ = F P Fᵀ + Q");
    expect(texToText("\\hat x_k = x_k + C_k(\\hat x_{k+1} - x^-_{k+1})")).toBe("x̂ₖ = xₖ + Cₖ(x̂ₖ₊₁ - x⁻ₖ₊₁)");
    expect(texToText("C_k = P_k F^\\top (P^-_{k+1})^{-1}")).toBe("Cₖ = Pₖ Fᵀ (P⁻ₖ₊₁)⁻¹");
    expect(texToText("r = \\sigma_m^2 / \\text{visibility}")).toBe("r = σₘ² / visibility");
    expect(texToText("W = S + \\ell_1 u + \\ell_2 f")).toBe("W = S + ℓ₁ u + ℓ₂ f");
    expect(texToText("q_j = \\frac{E - P_j}{|E - P_j|}")).toBe("qⱼ = (E - Pⱼ)/(|E - Pⱼ|)");
    expect(texToText("\\min_\\theta \\|g - f(\\theta)\\|^2")).toBe("min_θ ‖g - f(θ)‖²");
  });

  it("leaves no backslash in any formula of the learning pages", () => {
    const dir = join(__dirname, "../../docs/learn/motion");
    for (const f of readdirSync(dir)) {
      const md = readFileSync(join(dir, f), "utf8");
      for (const m of md.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g)) {
        const text = texToText(m[1] ?? m[2]);
        expect(text, `${f}: ${m[0]}`).not.toMatch(/\\/);
      }
    }
  });
});
