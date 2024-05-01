import binaryen from "binaryen";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const { status, error } = spawnSync(
  "cargo",
  ["build", "--target", "wasm32-unknown-unknown", "--release"],
  { stdio: "inherit" },
);

if (error !== undefined) throw error;
if (status !== null && status !== 0) process.exit(status);

const moduleBytes = await readFile(
  "target/wasm32-unknown-unknown/release/demangle.wasm",
);
const module = binaryen.readBinary(new Uint8Array(moduleBytes.buffer));

binaryen.setOptimizeLevel(2); // -O2
binaryen.setShrinkLevel(2); // -Oz
module.optimize();

const outputBytes = module.emitBinary();
module.dispose();

await writeFile("src/demangle/demangle.wasm", outputBytes);
