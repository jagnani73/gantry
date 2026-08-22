// Vendors ZXing's reader wasm into `public/`, so the QR fallback is served from
// our own origin instead of a CDN.
//
// The `barcode-detector` ponyfill defaults `locateFile` to a jsDelivr URL. That
// is the same trap this project already ruled on for fonts, which are
// self-hosted through `next/font` because a `fonts.googleapis.com` round trip in
// front of first paint is exactly what a venue hotspot or a captive portal
// breaks. Here it would be roughly 350-460KB of third-party fetch (measured off
// the 1.04MB binary: 349KB at brotli 11, 450KB gzipped, so the figure depends on
// what the host negotiates) standing between a payer and a code they are trying
// to scan. Same answer applies.
//
// RESOLVED THROUGH `barcode-detector`, never as a direct dependency. That
// package pins `zxing-wasm` to an exact version, and the wasm binary is only
// valid against the JS glue it shipped with — so a `zxing-wasm` entry in our own
// package.json could drift to a different version and produce a wasm that
// silently fails to instantiate. Asking the ponyfill's own dependency tree is
// what keeps the pair in step by construction.
//
// It is CHAINED into `dev` and `build` rather than living in a `prebuild` hook.
// Not because the hook would not fire — pnpm 11.15.1 runs `prebuild` fine (the
// default flipped to true in pnpm 9), and an earlier version of this comment
// claimed otherwise and was simply wrong — but because `enablePrePostScripts`
// is a setting, and one that lives in `pnpm-workspace.yaml`, i.e. a file this
// repo already has and nobody editing it would think of as touching the
// scanner. A step that a flag elsewhere can switch off is not a guarantee. The
// chained form is also visible in the Vercel build log, which is where you would
// go looking when an Apple payer reports a blind scanner.
//
// FAILS THE BUILD rather than warning. A missing wasm breaks the scanner only
// on the platforms that need the fallback, i.e. never on the machine that built
// it, which is the shape of bug that reaches a stage.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\ncopy-zxing-wasm: ${message}\n`);
  process.exit(1);
}

const require = createRequire(join(webRoot, "package.json"));

let ponyfill;
try {
  ponyfill = require.resolve("barcode-detector");
} catch (err) {
  // The code is carried out, because the likely causes need different fixes:
  // MODULE_NOT_FOUND really is "run pnpm install", while
  // ERR_PACKAGE_PATH_NOT_EXPORTED means a future version dropped its `require`
  // condition and this script needs rewriting, not reinstalling.
  fail(`\`barcode-detector\` could not be resolved (${err.code ?? "unknown"}). Run \`pnpm install\`.`);
}

// `zxing-wasm` is barcode-detector's dependency, not ours, so it is resolvable
// only from inside that package under pnpm's strict layout.
const fromPonyfill = createRequire(ponyfill);
let readerEntry;
try {
  readerEntry = fromPonyfill.resolve("zxing-wasm/reader");
} catch {
  fail("`zxing-wasm` could not be resolved from `barcode-detector`.");
}

// Walk up from the resolved entry to the package root — the dist layout differs
// between the cjs and es builds, so the entry's own directory is not a reliable
// base for the binary.
//
// The ascent must match on the package NAME, not on the mere presence of a
// package.json: dual-build packages drop a bare `{"type":"commonjs"}` marker in
// `dist/cjs`, and stopping at the first file found lands there — which reads a
// version of `undefined` and then reports the wasm as missing from a directory
// that was never supposed to hold it.
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

let packageRoot = dirname(readerEntry);
let manifest = readManifest(packageRoot);
while (manifest?.name !== "zxing-wasm") {
  const parent = dirname(packageRoot);
  if (parent === packageRoot) fail("could not find the `zxing-wasm` package root.");
  packageRoot = parent;
  manifest = readManifest(packageRoot);
}

const version = manifest.version;
const source = join(packageRoot, "dist", "reader", "zxing_reader.wasm");
if (!existsSync(source)) fail(`zxing-wasm@${version} has no dist/reader/zxing_reader.wasm`);

const target = join(webRoot, "public", "zxing_reader.wasm");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);

// VERIFIED against the digest the ponyfill itself exports, not against a
// version string, so the binary is pinned to the glue rather than to a number
// that happens to match. It catches a wasm/glue mismatch inside the resolved
// tree and a truncated or half-written copy — both of which fail at
// instantiation, in the browser, on Apple only, i.e. nowhere any check in this
// repo would ever look. What it does NOT catch is the bundler resolving a
// different copy than Node did: both sides of this comparison are Node's.
//
// The `/ponyfill` entry, not the package root: the root is the POLYFILL build
// and assigns `globalThis.BarcodeDetector` as a side effect of being required.
// Harmless in a build script, pointless, and the sort of thing that stops being
// harmless when someone reuses this file.
const { ZXING_WASM_SHA256 } = require("barcode-detector/ponyfill");
const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
if (typeof ZXING_WASM_SHA256 !== "string" || ZXING_WASM_SHA256.length === 0) {
  fail("`barcode-detector` no longer exports ZXING_WASM_SHA256; this check needs rewriting.");
}
if (digest !== ZXING_WASM_SHA256) {
  fail(`wasm digest ${digest} does not match the glue's ${ZXING_WASM_SHA256}`);
}

console.log(
  `copy-zxing-wasm: zxing-wasm@${version} -> public/zxing_reader.wasm ` +
    `(${(statSync(target).size / 1024).toFixed(0)} KB, sha256 ok)`,
);
