import * as defs from '../definitions';

type ErrorTuple = [factor: number, r: number, g: number, b: number];

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

  return [best1!, best2!, d1, d2];
};

// ---- Error Diffusion Patterns ----

type ErrorDiffusionPattern = {
  offsets: Array<[dx: number, dy: number, weight: number]>;
  divisor: number;
};

const PATTERNS: Record<string, ErrorDiffusionPattern> = {
  'floyd-steinberg': {
    offsets: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1]
    ],
    divisor: 16
  },
  burkes: {
    offsets: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2]
    ],
    divisor: 32
  },
  'sierra-lite': {
    offsets: [
      [1, 0, 2],
      [2, 0, 1],
      [-1, 1, 1]
    ],
    divisor: 4
  },
  stucki: {
    offsets: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1]
    ],
    divisor: 42
  },
  atkinson: {
    offsets: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1]
    ],
    divisor: 8
  },
  'min-avg-err': {
    offsets: [
      [1, 0, 7],
      [2, 0, 5],
      [-2, 1, 3],
      [-1, 1, 5],
      [0, 1, 7],
      [1, 1, 5],
      [2, 1, 3],
      [-2, 2, 1],
      [-1, 2, 3],
      [0, 2, 5],
      [1, 2, 3],
      [2, 2, 1]
    ],
    divisor: 48
  }
};
// ---- Error Diffusion Engine ----

const createErrorDiffusionDitherTransformer = (
  inner: defs.PixelTransformer,
  pattern: ErrorDiffusionPattern
): defs.PixelTransformer => {
  const errorCache = new Map<string, ErrorTuple[]>();

  const pushError = (tuple: ErrorTuple, x: number, y: number) => {
    const key = `${x}:${y}`;
    const tuples = errorCache.get(key);
    if (tuples) {
      return tuples.push(tuple);
    }
    errorCache.set(key, [tuple]);
  };

  return (pixel, payload) => {
    const key = `${payload.x}:${payload.y}`;
    const errors = errorCache.get(key) || [];
    errorCache.delete(key);

    const adjustedPixel = errors.reduce(
      (acc, [factor, r, g, b]) => ({
        r: acc.r + (r * factor) / pattern.divisor,
        g: acc.g + (g * factor) / pattern.divisor,
        b: acc.b + (b * factor) / pattern.divisor
      }),
      pixel
    );

    const newPixel = inner(adjustedPixel, payload);

    const rErr = adjustedPixel.r - newPixel.r;
    const gErr = adjustedPixel.g - newPixel.g;
    const bErr = adjustedPixel.b - newPixel.b;

    for (const [dx, dy, weight] of pattern.offsets) {
      pushError([weight, rErr, gErr, bErr], payload.x + dx, payload.y + dy);
    }

    return newPixel;
  };
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

/** @deprecated Use createDitherTransformer with 'floyd-steinberg' instead */
export const floydSteinbergDitherTransformer = (transformer: defs.PixelTransformer): defs.PixelTransformer => {
  return createErrorDiffusionDitherTransformer(transformer, PATTERNS['floyd-steinberg']);
};

export type DitherTransformerParams = {
  /**
   * The inner transformer (palette quantizer) used by error-diffusion algorithms.
   * Not used for ordered/Bayer algorithms (they quantize internally).
   */
  inner?: defs.PixelTransformer;
  /**
   * The dithering algorithm to use.
   */
  algorithm: DitherAlgorithm;
  /**
   * Flattened palette colors from the block palette. **Required for ordered/Bayer
   * algorithms** (bayer-2x2, bayer-4x4, ordered-3x3). Ignored for error diffusion.
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
 * For error-diffusion algorithms, the returned transformer wraps the provided
 * `inner` transformer and applies error propagation to improve perceived color
 * accuracy after palette quantization.
 *
 * For ordered/Bayer algorithms, the transformer **replaces** the inner quantizer
 * entirely — it directly picks between the two closest palette colors using the
 * dither matrix. This requires `paletteColors` to be provided.
 */
export const createDitherTransformer = (params: DitherTransformerParams): defs.PixelTransformer => {
  const { inner, algorithm, paletteColors, strength } = params;
  switch (algorithm) {
    case 'floyd-steinberg':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['floyd-steinberg']);
    case 'burkes':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['burkes']);
    case 'sierra-lite':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['sierra-lite']);
    case 'stucki':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['stucki']);
    case 'atkinson':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['atkinson']);
    case 'min-avg-err':
      return createErrorDiffusionDitherTransformer(inner!, PATTERNS['min-avg-err']);
    case 'bayer-2x2':
      return createOrderedDitherTransformer(paletteColors!, BAYER_2x2, strength ?? 48);
    case 'bayer-4x4':
      return createOrderedDitherTransformer(paletteColors!, BAYER_4x4, strength ?? 48);
    case 'ordered-3x3':
      return createOrderedDitherTransformer(paletteColors!, ORDERED_3x3, strength ?? 48);
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
