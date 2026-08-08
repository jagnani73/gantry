import QRCode from "qrcode";

/**
 * The QR as geometry rather than as markup.
 *
 * `QRCode.toString({ type: "svg" })` would be shorter, but it bakes `#000000`
 * into the output — a hex, in a design system whose one rule is that hexes live
 * in globals.css — and it has to be injected with `dangerouslySetInnerHTML`.
 * Building the path from the module matrix instead means the modules are painted
 * by `fill-ink` like everything else, and the SVG is ordinary React.
 *
 * Modules are emitted as one path of unit squares rather than as a grid of
 * elements: a CSS grid of divs leaves sub-pixel seams between cells at
 * fractional sizes, and a seam through a finder pattern is a code that will not
 * scan — which is the entire product.
 */
export interface QrMatrix {
  /** SVG path data in module units. */
  path: string;
  /** Modules per side, excluding the quiet zone. */
  size: number;
}

export function qrMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = modules.size;
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (modules.data[row * size + col]) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  return { path: parts.join(""), size };
}

/** Modules of blank border around the code. The spec asks for four; the standee
 * already sits on white, so two keeps the printed code large without risking a
 * reader that insists on a quiet zone. */
export const QR_QUIET_ZONE = 2;
