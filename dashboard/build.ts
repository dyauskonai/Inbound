/**
 * Builds the ER dashboard into dist/, which the Inbound server serves at "/".
 * dist/ is committed so the server runs without Bun. Rebuild after editing src/:
 *
 *     npx -y bun@1.2.21 run build
 */
import { rm } from "fs/promises";
import tailwind from "bun-plugin-tailwind";

await rm("./dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./src/index.html"],
  outdir: "./dist",
  target: "browser",
  publicPath: "/static/dist/",
  plugins: [tailwind],
  minify: true,
  // The handover PDF's code loads only when someone makes one.
  splitting: true,
  // jsPDF loads these only to draw HTML and SVG, which the handover doesn't use.
  external: ["canvg", "dompurify", "html2canvas"],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  console.error("Dashboard build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
