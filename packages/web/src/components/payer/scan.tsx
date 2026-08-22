"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isValidHandle } from "@gantry/shared";
import { Label } from "@/components/primitives";
import { MerchantTile } from "./merchant-tile";
import { OverlayHeader, OverlayScreen } from "./overlay";
import { usePayer } from "./payer-context";

/**
 * The in-app scanner, and the reason it can never be the only way in.
 *
 * On stage the payer uses the PHONE'S OWN camera app, which opens
 * `/pay/<handle>` directly — this screen exists for someone already inside the
 * app. It also cannot always work: `getUserMedia` requires a secure context, so
 * over plain HTTP on a LAN address (which is exactly how this is served at a
 * venue) the browser refuses outright. A dead viewfinder would read as a broken
 * app, so the fallback is a handle field and it is always visible.
 *
 * `BarcodeDetector` is likewise not everywhere — see `barcodeDetector` below for
 * what fills the gap and what it costs. Where even that fails the camera still
 * runs, because pointing a phone at a code and having nothing happen is at least
 * honest about which half is unavailable, with the same field underneath.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  /** Optional in practice as well as in the type: it queries the platform's
   * detection service, and older Chromium builds shipped the constructor
   * without it. See the native branch below for why it is worth asking. */
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * How long the fallback's wasm may take to load before we call it unavailable.
 *
 * `WebAssembly.instantiateStreaming(fetch(url))` has NO timeout, so a captive
 * portal that accepts the connection and never answers leaves the load pending
 * for ever rather than failing. That is the venue network this app is built
 * for, and an unbounded wait there is worse than a failure: the promise never
 * settles, so nothing is logged, nothing is rendered, and the viewfinder sits
 * live and blind. Same reasoning as the agent's `AGENT_LLM_TIMEOUT_MS`.
 */
const READER_LOAD_TIMEOUT_MS = 10_000;

/**
 * Consecutive decode rejections before the reader is declared dead.
 *
 * A rejection is not "no code in this frame" — that is an empty array. It means
 * the decoder itself failed, and its module promise is CACHED, so once it
 * starts failing it fails identically for ever and the loop can never recover.
 * Four at 250ms is one second: long enough that a transient hiccup costs
 * nothing, short enough that a payer is told before they give up.
 */
const DECODE_FAILURE_LIMIT = 4;

/**
 * Where the fallback fetches its wasm, as a value whose IDENTITY is the cache key.
 *
 * The library compares `overrides` field-by-field with `===`, so this function's
 * identity decides whether a second call reuses the compiled module or throws it
 * away. Both behaviours are wanted, at different times, and neither a hoisted
 * constant nor a fresh closure per call gives both:
 *
 * - Stable across SUCCESSES, or "Scan again" (which re-runs the effect, and so
 *   re-enters `barcodeDetector`) drops the cache and re-fetches, re-compiles and
 *   re-instantiates ~1MB — a visible stall on an iPhone, for nothing.
 * - NEW after a failure, because the cache stores the rejected promise too. A
 *   permanently hoisted identity would hand that same rejection to every later
 *   attempt, so a payer who hit one bad load could never retry without a full
 *   page reload.
 *
 * Hence: rebuilt only when a load has failed.
 *
 * The path is root-absolute, which assumes no `basePath`/`assetPrefix` in
 * next.config.ts. There is none today; adding one without changing this puts us
 * back on a 404, which the awaited load below at least reports.
 */
function makeLocateFile() {
  return (path: string, prefix: string) =>
    path.endsWith(".wasm") ? "/zxing_reader.wasm" : prefix + path;
}
let locateFile = makeLocateFile();

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * A QR reader, native where there is one and a ponyfill everywhere else.
 *
 * `BarcodeDetector` is a Chromium API and Safari has never shipped it. On iOS
 * every browser is WebKit underneath — the DMA has permitted alternative
 * engines in the EU since 17.4, but none has shipped at any scale — so Chrome,
 * Firefox and Edge on an iPhone lack it exactly as Safari does. This screen
 * therefore worked on Android and silently read nothing on any iPhone or iPad,
 * which is not a detection bug so much as those platforms having no detector at
 * all. (Scoped to iOS deliberately: Chrome on macOS is an Apple device and does
 * have the API, and the reverse also holds — see the native branch below, where
 * some desktop Chromium builds expose it without a working service.)
 *
 * `barcode-detector` is a ponyfill of that exact API over ZXing-C++ compiled to
 * wasm, so the polling loop below is unchanged: its `detect()` takes an
 * `HTMLVideoElement` directly, like the native one, and takes the same
 * `{ formats: ["qr_code"] }`.
 *
 * NATIVE FIRST, and the import is dynamic, so a browser that already has the
 * API downloads none of it — the wasm is 350-460KB over the wire depending on
 * the encoding the host negotiates, and it would be pure waste on a platform
 * that never had the bug. It is paid once, when the scanner is opened rather
 * than when the app loads.
 *
 * The wasm is served from OUR origin (`public/zxing_reader.wasm`, vendored by
 * `scripts/copy-zxing-wasm.mjs`). The library's default is a jsDelivr URL, and a
 * third-party fetch standing in front of a payer scanning to pay is the same
 * thing the fonts are self-hosted to avoid.
 */
async function barcodeDetector(): Promise<BarcodeDetectorLike | null> {
  const native = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (native) {
    try {
      /* ASKED, not assumed. `window.BarcodeDetector` is a binding to a platform
         service, and Chromium exposes the binding on platforms where that
         service is absent — the constructor then succeeds and every `detect()`
         rejects at call time, which the loop below would swallow for ever.
         `getSupportedFormats()` is the standard probe: it returns `[]` when the
         service is unavailable, so an empty or qr-less list sends us to the
         ponyfill that is already sitting in the bundle. A build old enough to
         lack the static is trusted, which is the pre-existing behaviour. */
      const formats = await native.getSupportedFormats?.();
      if (formats === undefined || formats.includes("qr_code")) {
        return new native({ formats: ["qr_code"] });
      }
      console.warn("gantry: the native BarcodeDetector offers no qr_code; using the fallback", formats);
    } catch (err) {
      // Nothing is discarded. This is the one place that knows WHY the app is
      // about to spend 440KB on a browser that advertised the API.
      console.warn("gantry: the native BarcodeDetector is unusable; using the fallback", err);
    }
  }
  try {
    const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
    /* AWAITED, and that is the whole point of this line.
       `new BarcodeDetector()` kicks the wasm load off itself and swallows the
       rejection (`prepareZXingModule({fireImmediately:true}).catch(() => {})`
       inside the constructor), so it CANNOT throw for a missing, 404ing or
       un-instantiable wasm. Constructing first therefore returns a detector
       that looks fine and rejects inside every `detect()` — which the loop
       below swallowed, at 4Hz, for ever. Measured: a 404 wasm gave a non-null
       detector and `NotSupportedError: Barcode detection service unavailable`
       from a cached promise that never retries. That is the original bug with
       a download attached. Awaiting the module surfaces the failure HERE,
       where the note below can be shown. */
    await withTimeout(
      prepareZXingModule({ overrides: { locateFile }, fireImmediately: true }),
      READER_LOAD_TIMEOUT_MS,
      "the QR reader",
    );
    return new BarcodeDetector({ formats: ["qr_code"] });
  } catch (err) {
    // A NEW identity, so the next attempt re-instantiates rather than being
    // handed this same rejection out of the cache. See `makeLocateFile`.
    locateFile = makeLocateFile();
    // The chunk, the wasm or the network. Reported, never swallowed: the note
    // this produces is the only thing standing between a payer and a viewfinder
    // that will never fire.
    console.warn("gantry: the QR reader could not be loaded", err);
    return null;
  }
}

/** A scanned string → the handle it points at, or null. Accepts a bare handle so
 * a payer can read one off a standee and type it. */
export function handleFromScan(value: string): string | null {
  const trimmed = value.trim();
  if (isValidHandle(trimmed)) return trimmed;
  try {
    const path = new URL(trimmed).pathname;
    const match = /^\/(?:pay|m)\/([^/?#]+)/.exec(path);
    if (!match) return null;
    const handle = decodeURIComponent(match[1]!);
    return isValidHandle(handle) ? handle : null;
  } catch {
    return null;
  }
}

type CameraState = "starting" | "live" | "unavailable";

export function Scan() {
  const { merchant, ensureMerchant, merchantError, retryMerchant, closeOverlays, replaceOverlay } =
    usePayer();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [camera, setCamera] = useState<CameraState>("starting");
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const onFound = useCallback(
    (handle: string) => {
      setDetected(handle);
      ensureMerchant(handle);
    },
    [ensureMerchant],
  );

  useEffect(() => {
    if (detected) return; // stop the camera once there is something to confirm
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCamera("unavailable");
        setCameraNote(
          window.isSecureContext
            ? "This browser will not give a web page the camera."
            : "Browsers only allow the camera over HTTPS, and this page is not on it.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch {
        if (cancelled) return;
        setCamera("unavailable");
        setCameraNote("The camera is unavailable or permission was declined.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      setCamera("live");

      // Awaited, so on iOS the ponyfill's chunk and wasm load here rather than
      // at app start. The camera is already live behind this, and that ordering
      // is the point: the viewfinder is up while the reader loads, so what a
      // slow network delays is scanning rather than the whole screen. The wait
      // is bounded but not short — up to READER_LOAD_TIMEOUT_MS.
      const detector = await barcodeDetector();
      if (cancelled) return;
      if (!detector) {
        /* NOT "this browser cannot read a code". Every reachable cause here is
           a load that failed — the chunk, the wasm, or a network that never
           answered — and telling a payer their phone is incapable is both
           false and an instruction to stop trying. Same distinction this file
           already draws for the registry lookup below: what we could not do,
           never what does not exist. */
        setCameraNote("We couldn't load the code reader. Type the handle instead.");
        return;
      }
      // A quarter-second poll: fast enough that a code held up is caught before
      // the payer wonders, slow enough not to pin a phone CPU on every frame.
      //
      // `decoding` is a floor under that, not a nicety. The native detector
      // answers in single-digit milliseconds, but the wasm fallback measured
      // 129ms on a desktop for one 512px frame — so on an older phone a decode
      // can outlast the interval, and an unguarded `setInterval` would then
      // stack decodes faster than they retire, on the one screen where the CPU
      // is already decoding camera frames. Skipping while one is outstanding
      // means a decode can only start on a free tick, so the real period is
      // `250 × ceil(decode / 250)` and not the `max(250, decode)` it looks
      // like: a 400ms decode runs every 500ms, not every 400.
      let decoding = false;
      let failures = 0;
      timer = setInterval(() => {
        const source = videoRef.current;
        if (!source || source.readyState < 2 || decoding) return;
        decoding = true;
        void detector
          .detect(source)
          .then((codes) => {
            failures = 0;
            for (const code of codes) {
              const handle = handleFromScan(code.rawValue);
              if (handle) {
                onFound(handle);
                return;
              }
            }
          })
          .catch((err: unknown) => {
            /* A rejection is NOT "no code in this frame" — that is an empty
               array, and it is the overwhelmingly common outcome. This is the
               decoder itself failing, and because its module promise is cached
               the failure is permanent: the same rejection is handed to every
               later call and the loop can never recover. Swallowing it was how
               a dead reader looked exactly like an empty viewfinder.

               Counted rather than reported on the first one, because a single
               bad frame should cost nothing. Past the limit the loop stops
               rather than spinning at 4Hz against something that will never
               answer. */
            failures += 1;
            if (failures < DECODE_FAILURE_LIMIT || cancelled) return;
            if (timer) clearInterval(timer);
            timer = null;
            console.warn("gantry: the QR reader stopped answering", err);
            setCameraNote("The code reader stopped working. Type the handle instead.");
          })
          .finally(() => {
            decoding = false;
          });
      }, 250);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [detected, onFound]);

  const manualHandle = handleFromScan(manual);
  const record = detected ? merchant(detected) : undefined;
  // `record === null` is the registry answering "no such handle"; this is the
  // lookup never having got an answer at all. The scanner must not collapse the
  // two — a hotspot dropping one request would otherwise tell the payer the
  // standee in front of them belongs to no shop.
  const lookupFailed = detected ? merchantError(detected) : null;

  return (
    <OverlayScreen tone="ink">
      <OverlayHeader
        onBack={closeOverlays}
        backLabel="Close the scanner"
        glyph="✕"
        title="Scan to pay"
        tone="ink"
      />

      <div className="flex flex-1 flex-col items-center justify-center gap-6.5 px-8">
        <div className="relative flex size-59 items-center justify-center rounded-hero border-2 border-paper/25">
          <video
            ref={videoRef}
            muted
            playsInline
            className={`size-42.5 rounded-nav object-cover ${camera === "live" ? "" : "hidden"}`}
          />
          {camera === "live" ? null : (
            <div className="stripe-placeholder flex size-42.5 items-center justify-center rounded-nav opacity-15">
              <Label size="col-header" tone="inherit" className="text-paper/50">
                {camera === "starting" ? "Camera" : "No camera"}
              </Label>
            </div>
          )}
        </div>
        <p className="text-center text-body text-paper/66">
          Point at any Gantry code. You don&apos;t need an account, and you won&apos;t pay gas.
        </p>
        {cameraNote ? <p className="text-center text-fine text-paper/40">{cameraNote}</p> : null}
      </div>

      <div className="shrink-0 px-5 pb-11">
        {detected ? (
          <>
            <button
              type="button"
              onClick={() => replaceOverlay({ kind: "pay", handle: detected })}
              className="focus-ring-inverse flex w-full items-center gap-3.5 rounded-card bg-surface p-4 text-left transition-colors hover:bg-fill-hover-card"
            >
              <MerchantTile name={record?.displayName ?? detected} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-card-title-sm text-ink">
                  {record?.displayName ?? detected}
                </span>
                <span className="mt-0.5 block truncate text-meta-sm text-muted">
                  {record === null ? "No shop is registered at this handle" : (record?.location ?? `@${detected}`)}
                </span>
              </span>
              <span className="text-body font-medium text-accent">Pay →</span>
            </button>
            <div className="mt-3 flex items-center justify-center gap-2 text-fine text-paper/42">
              {/* Never claim a registration we have not read back — which means
                  four answers, not two: read and present, read and absent, not
                  read yet, and could not be read. */}
              <span>
                {record === null
                  ? "No shop at this handle"
                  : record
                    ? "Code detected · registered on-chain"
                    : lookupFailed
                      ? "Code detected · couldn't reach the registry"
                      : "Code detected · checking the registry…"}
              </span>
              <span aria-hidden>·</span>
              {lookupFailed ? (
                <button
                  type="button"
                  onClick={() => retryMerchant(detected)}
                  className="focus-ring-inverse rounded-badge text-accent-soft underline-offset-2 hover:underline"
                >
                  Retry
                </button>
              ) : null}
              {/* A wrong code is otherwise a dead end: the only other control on
                  this screen closes the scanner entirely. */}
              <button
                type="button"
                onClick={() => setDetected(null)}
                className="focus-ring-inverse rounded-badge text-accent-soft underline-offset-2 hover:underline"
              >
                Scan again
              </button>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="Or type the shop's handle"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-label="Shop handle"
              className="focus-ring-inverse h-12 min-w-0 flex-1 rounded-control-m bg-paper/12 px-3.5 font-mono text-mono text-paper placeholder:font-sans placeholder:text-paper/40"
            />
            <button
              type="button"
              disabled={!manualHandle}
              onClick={() => manualHandle && onFound(manualHandle)}
              className="focus-ring-inverse h-12 shrink-0 rounded-control-m bg-paper px-5 text-btn-sm text-ink transition-colors disabled:bg-paper/12 disabled:text-paper/40"
            >
              Open
            </button>
          </div>
        )}
      </div>
    </OverlayScreen>
  );
}
