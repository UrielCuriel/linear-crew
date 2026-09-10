#!/usr/bin/env bun

import { $ } from "bun";

await $`rm -rf dist`;

const builds = await Promise.all([
  Bun.build({
    entrypoints: ["src/cli.ts"],
    outdir: "dist",
    naming: "cli.js",
    target: "bun",
    format: "esm",
    splitting: true,
    packages: "external",
  }),
  Bun.build({
    entrypoints: ["src/integrations/opencode-plugin.ts"],
    outdir: "dist",
    naming: "opencode-plugin.js",
    target: "bun",
    format: "esm",
    packages: "external",
  }),
]);

const failures = builds.flatMap((build) => build.logs);
if (builds.some((build) => !build.success)) {
  for (const failure of failures) console.error(failure);
  throw new Error("Linear Crew build failed");
} else {
  console.log("Built dist/cli.js and dist/opencode-plugin.js for the Bun runtime.");
}
