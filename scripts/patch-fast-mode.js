#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector is gated by a function that checks:
 *   !(authMethod !== "chatgpt" || featureRequirements.fast_mode === false)
 * This means API-key users never see the speed selector.
 *
 * This patch locates that gate function via AST and replaces
 * the return expression with !0, making fast mode always available.
 *
 * Target: permissions-mode-helpers-*.js (or any chunk with the pattern)
 *
 * Usage:
 *   node scripts/patch-fast-mode.js [platform]
 *   node scripts/patch-fast-mode.js --check
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

/**
 * Match the fast-mode gate pattern:
 *   !(authMethod !== "chatgpt" || X.fast_mode === !1)
 *
 * AST structure:
 *   UnaryExpression { operator: "!", argument:
 *     LogicalExpression { operator: "||",
 *       left:  BinaryExpression { operator: "!==" } containing "chatgpt"
 *       right: BinaryExpression { operator: "===" } containing "fast_mode"
 *     }
 *   }
 *
 * We replace the entire UnaryExpression with !0.
 */
function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "UnaryExpression" || node.operator !== "!" || !node.prefix)
      return;

    const arg = node.argument;
    if (!arg || arg.type !== "LogicalExpression" || arg.operator !== "||") return;

    const left = arg.left;
    const right = arg.right;

    // left: X.authMethod !== "chatgpt"
    if (!left || left.type !== "BinaryExpression" || left.operator !== "!==")
      return;
    const leftSrc = source.slice(left.start, left.end);
    if (!leftSrc.includes("authMethod") || !leftSrc.includes("chatgpt")) return;

    // right: Y.fast_mode === !1
    if (!right || right.type !== "BinaryExpression" || right.operator !== "===")
      return;
    const rightSrc = source.slice(right.start, right.end);
    if (!rightSrc.includes("fast_mode")) return;

    const exprSrc = source.slice(node.start, node.end);
    if (exprSrc === "!0") return;

    patches.push({
      id: "fast_mode_gate",
      start: node.start,
      end: node.end,
      replacement: "!0",
      original: exprSrc,
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("authMethod") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      if (source.includes("fast_mode")) {
        console.log("   [ok] fast_mode present but gate already patched or pattern changed");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] ${patches.length} match(es)`);
      for (const p of patches) {
        console.log(`     > [${p.id}] offset ${p.start}: ${p.original.slice(0, 80)}...`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * [${p.id}] offset ${p.start}: ${p.original.slice(0, 60)}... -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] ${patches.length} replacement(s)`);
    totalPatched += patches.length;
  }

  console.log(`\n  [done] ${totalPatched} total patch(es)`);
}

main();
