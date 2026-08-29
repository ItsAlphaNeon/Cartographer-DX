import * as defs from '../definitions';

export type DitherAlgorithm =
  | 'floyd-steinberg'
  | 'bayer-2x2'
  | 'bayer-4x4'
  | 'ordered-3x3'
  | 'min-avg-err'
  | 'burkes'
  | 'sierra-lite'
  | 'stucki'
  | 'atkinson';

// ---- Color Distance Helpers (matching REFERENCE) ----

const squaredEuclideanDistance = (a: defs.Pixel, b: defs.Pixel): number => {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
};

/**
 * Find the two closest palette colors to the given pixel, returning
 * them along with their squared distances from the target pixel.
 * Includes REFERENCE's edge-case guard: if distance(closest1, closest2)
 * ≤ distance(pixel, closest2), then closest2 is set to closest1 to
 * prevent spurious dithering between nearly-identical colors.
 */
const findTwoClosestColors = (
  pixel: defs.Pixel,
  paletteColors: defs.Pixel[]
): [closest1: defs.Pixel, closest2: defs.Pixel, dist1: number, dist2: number] => {
  let best1: defs.Pixel | null = null;
  let best2: defs.Pixel | null = null;
  let d1 = Infinity;
  let d2 = Infinity;

  for (const color of paletteColors) {
    const d = squaredEuclideanDistance(pixel, color);
    if (d < d1) {
      [best2, d2] = [best1, d1];
      [best1, d1] = [color, d];
    } else if (d < d2) {
      [best2, d2] = [color, d];
    }
  }

  // REFERENCE edge-case guard: if the two closest palette colors are
  // closer to each other than the second-closest is to the pixel,
  // they're effectively the same color — no dithering to be done.
  if (best2 !== null && squaredEuclideanDistance(best1!, best2!) <= d2) {
    best2 = best1;
    d2 = d1;
  }

  return [best1!, best2!, d1, d2];
};

// ---- Error Diffusion Patterns (REFERENCE 3×5 ditherMatrix format) ----

type ErrorDiffusionPattern = {
  matrix: number[][];
  divisor: number;
};

const ERROR_DIFFUSION_PATTERNS: Record<string, ErrorDiffusionPattern> = {
  'floyd-steinberg': {
    matrix: [
      [0, 0, 0, 7, 0],
      [0, 3, 5, 1, 0],
      [0, 0, 0, 0, 0]
    ],
    divisor: 16
  },
  'min-avg-err': {
    matrix: [
      [0, 0, 0, 7, 5],
      [3, 5, 7, 5, 3],
      [1, 3, 5, 3, 1]
    ],
    divisor: 48
  },
  burkes: {
    matrix: [
      [0.0, 0.0, 0.0, 8.0, 4.0],
      [2.0, 4.0, 8.0, 4.0, 2.0],
      [0.0, 0.0, 0.0, 0.0, 0.0]
    ],
    divisor: 32
  },
  'sierra-lite': {
    matrix: [
      [0, 0, 0, 2, 0],
      [0, 1, 1, 0, 0],
      [0, 0, 0, 0, 0]
    ],
    divisor: 4
  },
  stucki: {
    matrix: [
      [0.0, 0.0, 0.0, 8.0, 4.0],
      [2.0, 4.0, 8.0, 4.0, 2.0],
      [1.0, 2.0, 4.0, 2.0, 1.0]
    ],
    divisor: 42
  },
  atkinson: {
    matrix: [
      [0, 0, 0, 1, 1],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 0, 0]
    ],
    divisor: 8
  }
};
/**
 * Apply error-diffusion dithering directly to a flat RGBA buffer (ImageData.data).
 *
 * Processes pixels left-to-right, top-to-bottom in scanline order — matching
 * REFERENCE's approach exactly. For each pixel:
 *   1. Finds the closest palette color
 *   2. Writes it to the buffer
 *   3. Computes quantization error (original − chosen)
 *   4. Propagates error × weight/divisor to neighboring pixels' RGBA values
 *      in the same buffer (these modified values are seen by later pixels).
 *
 * The error is propagated according to a 3×5 dither matrix where the current
 * pixel is at [row=1][col=2]:
 *   Row 0 (dy=0): columns dx=+1, dx=+2
 *   Row 1 (dy=1): columns dx=−2, dx=−1, dx=0, dx=+1, dx=+2
 *   Row 2 (dy=2): columns dx=−2, dx=−1, dx=0, dx=+1, dx=+2
 */
export const applyErrorDiffusionToBuffer = (
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  paletteColors: defs.Pixel[],
  algorithm: DitherAlgorithm
): void => {
  const patternInfo = ERROR_DIFFUSION_PATTERNS[algorithm];
  if (!patternInfo) {
    throw new Error(`Unknown error diffusion algorithm: ${algorithm}`);
  }
  const { matrix, divisor } = patternInfo;

  // Pre-convert palette to a flat array for fast access
  const palette = paletteColors.map((c) => ({ r: c.r, g: c.g, b: c.b }));

  // Find the closest palette color by squared Euclidean distance
  const findClosest = (r: number, g: number, b: number): { r: number; g: number; b: number } => {
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const dr = r - c.r;
      const dg = g - c.g;
      const db = b - c.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return palette[bestIdx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      const oldR = buffer[i];
      const oldG = buffer[i + 1];
      const oldB = buffer[i + 2];

      const closest = findClosest(oldR, oldG, oldB);

      // Write quantized color
      buffer[i] = closest.r;
      buffer[i + 1] = closest.g;
      buffer[i + 2] = closest.b;
      buffer[i + 3] = 255;

      const errR = oldR - closest.r;
      const errG = oldG - closest.g;
      const errB = oldB - closest.b;

      // Propagate error using 3×5 dither matrix (REFERENCE-compatible)
      // Row 0: same row, to the right
      if (x + 1 < width) {
        const w0 = matrix[0][3] / divisor;
        buffer[i + 4] += errR * w0;
        buffer[i + 5] += errG * w0;
        buffer[i + 6] += errB * w0;

        if (x + 2 < width) {
          const w1 = matrix[0][4] / divisor;
          buffer[i + 8] += errR * w1;
          buffer[i + 9] += errG * w1;
          buffer[i + 10] += errB * w1;
        }
      }

      // Row 1: 1 row down
      if (y + 1 < height) {
        const nextRowOff = width * 4;

        if (x > 0) {
          const w2 = matrix[1][1] / divisor;
          buffer[i + nextRowOff - 4] += errR * w2;
          buffer[i + nextRowOff - 3] += errG * w2;
          buffer[i + nextRowOff - 2] += errB * w2;

          if (x > 1) {
            const w3 = matrix[1][0] / divisor;
            buffer[i + nextRowOff - 8] += errR * w3;
            buffer[i + nextRowOff - 7] += errG * w3;
            buffer[i + nextRowOff - 6] += errB * w3;
          }
        }

        const w4 = matrix[1][2] / divisor;
        buffer[i + nextRowOff] += errR * w4;
        buffer[i + nextRowOff + 1] += errG * w4;
        buffer[i + nextRowOff + 2] += errB * w4;

        if (x + 1 < width) {
          const w5 = matrix[1][3] / divisor;
          buffer[i + nextRowOff + 4] += errR * w5;
          buffer[i + nextRowOff + 5] += errG * w5;
          buffer[i + nextRowOff + 6] += errB * w5;

          if (x + 2 < width) {
            const w6 = matrix[1][4] / divisor;
            buffer[i + nextRowOff + 8] += errR * w6;
            buffer[i + nextRowOff + 9] += errG * w6;
            buffer[i + nextRowOff + 10] += errB * w6;
          }
        }
      }

      // Row 2: 2 rows down
      if (y + 2 < height) {
        const twoRowsOff = width * 8;

        if (x > 0) {
          const w7 = matrix[2][1] / divisor;
          buffer[i + twoRowsOff - 4] += errR * w7;
          buffer[i + twoRowsOff - 3] += errG * w7;
          buffer[i + twoRowsOff - 2] += errB * w7;

          if (x > 1) {
            const w8 = matrix[2][0] / divisor;
            buffer[i + twoRowsOff - 8] += errR * w8;
            buffer[i + twoRowsOff - 7] += errG * w8;
            buffer[i + twoRowsOff - 6] += errB * w8;
          }
        }

        const w9 = matrix[2][2] / divisor;
        buffer[i + twoRowsOff] += errR * w9;
        buffer[i + twoRowsOff + 1] += errG * w9;
        buffer[i + twoRowsOff + 2] += errB * w9;

        if (x + 1 < width) {
          const w10 = matrix[2][3] / divisor;
          buffer[i + twoRowsOff + 4] += errR * w10;
          buffer[i + twoRowsOff + 5] += errG * w10;
          buffer[i + twoRowsOff + 6] += errB * w10;

          if (x + 2 < width) {
            const w11 = matrix[2][4] / divisor;
            buffer[i + twoRowsOff + 8] += errR * w11;
            buffer[i + twoRowsOff + 9] += errG * w11;
            buffer[i + twoRowsOff + 10] += errB * w11;
          }
        }
      }
    }
  }
};

// ---- Ordered / Bayer Dithering ----

const BAYER_2x2 = [
  [1, 3],
  [4, 2]
];

const BAYER_4x4 = [
  [1, 9, 3, 11],
  [13, 5, 15, 7],
  [4, 12, 2, 10],
  [16, 8, 14, 6]
];

const ORDERED_3x3 = [
  [1, 7, 4],
  [5, 8, 3],
  [6, 2, 9]
];

/**
 * Create an ordered/Bayer dithering transformer that directly picks between
 * the two closest palette colors using the dither matrix (matching REFERENCE).
 *
 * REFERENCE formula (mapCanvas.jsworker lines 282-289):
 *   if ((dist1 * (size + 1)) / dist2 > matrixValue) → pick second-closest
 *   else → pick closest
 *
 * The `strength` parameter (0–255) interpolates between "no dithering"
 * (strength=0, always pick closest) and "full REFERENCE dithering"
 * (strength=255, use the matrix comparison as-is).
 */
const createOrderedDitherTransformer = (
  paletteColors: defs.Pixel[],
  matrix: number[][],
  strength: number
): defs.PixelTransformer => {
  const w = matrix.length;
  const h = matrix[0].length;
  const size = w * h;

  return (pixel, payload) => {
    const [closest1, closest2, dist1, dist2] = findTwoClosestColors(pixel, paletteColors);

    // Early exit for zero strength — always pick closest (no dithering)
    if (strength <= 0) {
      return closest1;
    }

    const matrixValue = matrix[payload.x % w][payload.y % h];
    // REFERENCE: (dist1 * (size + 1)) / dist2 > matrixValue → pick second-closest
    const fullDitherRatio = (dist1 * (size + 1)) / dist2;
    // Strength factor: 0 = no dither, 1 = full REFERENCE dither
    const factor = Math.min(strength / 255, 1);
    // Blend between always-closest (ratio=0) and the REFERENCE comparison
    const blendedRatio = fullDitherRatio * factor;
    return blendedRatio > matrixValue ? closest2 : closest1;
  };
};

// ---- Public API ----

export type DitherTransformerParams = {
  /**
   * The dithering algorithm to use. Only ordered/Bayer algorithms are
   * supported here; error-diffusion algorithms use `applyErrorDiffusionToBuffer`.
   */
  algorithm: DitherAlgorithm;
  /**
   * Flattened palette colors from the block palette. Required for ordered/Bayer
   * algorithms (bayer-2x2, bayer-4x4, ordered-3x3).
   */
  paletteColors?: defs.Pixel[];
  /**
   * Dithering strength (0–255), used by ordered/Bayer algorithms to control how
   * aggressively the matrix influences color selection.
   * - 0 = no dithering (always pick the closest color)
   * - 255 = full REFERENCE-matching dithering
   * Defaults to 48 if not set.
   */
  strength?: number;
};

/**
 * Create a dithering transformer using the specified algorithm.
 *
 * Only supports ordered/Bayer algorithms (bayer-2x2, bayer-4x4, ordered-3x3).
 * Error-diffusion algorithms are handled separately via `applyErrorDiffusionToBuffer`
 * which operates on a flat RGBA buffer at the target resolution.
 *
 * For ordered/Bayer algorithms, the transformer directly picks between the two
 * closest palette colors using the dither matrix, requiring `paletteColors`.
 */
export const createDitherTransformer = (params: DitherTransformerParams): defs.PixelTransformer => {
  const { algorithm, paletteColors, strength } = params;
  switch (algorithm) {
    case 'bayer-2x2':
      return createOrderedDitherTransformer(paletteColors!, BAYER_2x2, strength ?? 48);
    case 'bayer-4x4':
      return createOrderedDitherTransformer(paletteColors!, BAYER_4x4, strength ?? 48);
    case 'ordered-3x3':
      return createOrderedDitherTransformer(paletteColors!, ORDERED_3x3, strength ?? 48);
    default:
      throw new Error(
        `createDitherTransformer does not support '${algorithm}'. ` +
          `Use applyErrorDiffusionToBuffer for error-diffusion algorithms.`
      );
  }
};

/** Ordered list of all available dithering algorithms */
export const DITHER_ALGORITHMS: DitherAlgorithm[] = [
  'floyd-steinberg',
  'burkes',
  'sierra-lite',
  'stucki',
  'atkinson',
  'min-avg-err',
  'bayer-2x2',
  'bayer-4x4',
  'ordered-3x3'
];

/** Algorithms that use the ordered/Bayer pattern (supports strength slider) */
export const DITHER_ORDERED_ALGORITHMS: ReadonlySet<DitherAlgorithm> = new Set<DitherAlgorithm>([
  'bayer-2x2',
  'bayer-4x4',
  'ordered-3x3'
]);
