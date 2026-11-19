import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";

// Playwright loads these assets via computed paths that esbuild cannot follow,
// so rewrite them to static requires. This keeps the bundle self-contained,
// which is what lets it run inside a Node SEA binary.
const rewrites = [
  [/require\([\w.]+\.join\(packageRoot, "package\.json"\)\)/g, 'require("../package.json")'],
  [/require\([\w.]+\.join\(packageRoot, "browsers\.json"\)\)/g, 'require("../browsers.json")'],
  [/[\w.]+\.readFileSync\([\w.]+\.join\(__dirname, "webp_codec\.wasm"\)\)/g, 'require("./webp_codec.wasm")'],
];

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "build/app/cli.cjs",
  loader: { ".wasm": "binary" },
  plugins: [{
    name: "embed-playwright-assets",
    setup(builder) {
      builder.onLoad({ filter: /\/playwright-core\/lib\/(?:coreBundle|package|serverRegistry)\.js$/ }, async ({ path }) => {
        let contents = await readFile(path, "utf8");
        for (const [pattern, replacement] of rewrites) contents = contents.replace(pattern, replacement);
        return { contents, loader: "js", resolveDir: dirname(path) };
      });
    },
  }],
});
