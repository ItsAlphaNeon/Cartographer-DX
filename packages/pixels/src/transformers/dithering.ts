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
  [0, 2],
  [3, 1]
];

const BAYER_4x4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

const ORDERED_3x3 = [
  [0, 7, 5],
  [3, 1, 8],
  [6, 4, 2]
];

const createOrderedDitherTransformer = (inner: defs.PixelTransformer, matrix: number[][]): defs.PixelTransformer => {
  const matrixHeight = matrix.length;
  const matrixWidth = matrix[0].length;
  const matrixSize = matrixWidth * matrixHeight;

  return (pixel, payload) => {
    const threshold = (matrix[payload.y % matrixHeight][payload.x % matrixWidth] + 0.5) / matrixSize;
    const noise = (threshold - 0.5) * 255;
    const noisyPixel = {
      r: Math.max(0, Math.min(255, pixel.r + noise)),
      g: Math.max(0, Math.min(255, pixel.g + noise)),
      b: Math.max(0, Math.min(255, pixel.b + noise))
    };
    return inner(noisyPixel, payload);
  };
};

// ---- Public API ----

/** @deprecated Use createDitherTransformer with 'floyd-steinberg' instead */
export const floydSteinbergDitherTransformer = (transformer: defs.PixelTransformer): defs.PixelTransformer => {
  return createErrorDiffusionDitherTransformer(transformer, PATTERNS['floyd-steinberg']);
};

/**
 * Create a dithering transformer using the specified algorithm.
 *
 * The returned transformer wraps the provided inner transformer and applies
 * dithering (error-diffusion or ordered/Bayer) to improve perceived color
 * accuracy after palette quantization.
 */
export const createDitherTransformer = (
  inner: defs.PixelTransformer,
  algorithm: DitherAlgorithm
): defs.PixelTransformer => {
  switch (algorithm) {
    case 'floyd-steinberg':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['floyd-steinberg']);
    case 'burkes':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['burkes']);
    case 'sierra-lite':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['sierra-lite']);
    case 'stucki':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['stucki']);
    case 'atkinson':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['atkinson']);
    case 'min-avg-err':
      return createErrorDiffusionDitherTransformer(inner, PATTERNS['min-avg-err']);
    case 'bayer-2x2':
      return createOrderedDitherTransformer(inner, BAYER_2x2);
    case 'bayer-4x4':
      return createOrderedDitherTransformer(inner, BAYER_4x4);
    case 'ordered-3x3':
      return createOrderedDitherTransformer(inner, ORDERED_3x3);
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
