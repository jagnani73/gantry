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
 * `BarcodeDetector` is likewise not everywhere. Where it is missing the camera
 * still runs — pointing a phone at a code and having nothing happen is at least
 * honest about which half is unavailable — with the same field underneath.
 */

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
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

      const detector = barcodeDetector();
      if (!detector) {
        setCameraNote("This browser cannot read a code automatically — type the handle instead.");
        return;
      }
      // A quarter-second poll: fast enough that a code held up is caught before
      // the payer wonders, slow enough not to pin a phone CPU on every frame.
      timer = setInterval(() => {
        const source = videoRef.current;
        if (!source || source.readyState < 2) return;
        void detector
          .detect(source)
          .then((codes) => {
            for (const code of codes) {
              const handle = handleFromScan(code.rawValue);
              if (handle) {
                onFound(handle);
                return;
              }
            }
          })
          .catch(() => undefined);
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
