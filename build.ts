import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/cli/main.ts"],
  target: "bun",
  plugins: [solidPlugin],
  // The binary must not pick up bunfig.toml / .env from whatever directory it runs in.
  compile: { outfile: "./dist/sentinel", autoloadBunfig: false, autoloadDotenv: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Built dist/sentinel");
