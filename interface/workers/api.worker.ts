import * as generation from '@cartographer/generation';
import * as pixels from '@cartographer/pixels';
import * as constants from '../constants';
import * as comlink from 'comlink';
import * as defs from '../defs';

export type DitherSettings = {
  dither: boolean;
  dither_algorithm?: string;
};

export type Transformations = {
  saturation?: number;
  brightness?: number;
  dither?: boolean;
  dither_algorithm?: string;
  dither_strength?: number;
};
export type GenerationParams = {
  image_data: ImageData;

  bounds: defs.Bounds;
  scale: defs.Scale;

  palette: pixels.BlockPalette;
  color_spectrum: pixels.BlockColorSpectrum;

  transformations?: Transformations;

  /** When true, export will produce split per-map-tile files instead of a single merged file */
  split?: boolean;
};

const baseImagePipeline = (params: GenerationParams) => {
  const [x, y, dx, dy] = params.bounds;

  const canvas = new OffscreenCanvas(params.image_data.width, params.image_data.height);
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  context.putImageData(params.image_data, 0, 0);

  const image_data = context.getImageData(x, y, dx, dy);

  const palette_transformer = pixels.conversion.createColorPaletteTransformer(params);
  const transformations = params.transformations || {};

  // Determine which dither algorithm is being used
  const algorithm = (transformations.dither_algorithm as pixels.transformers.DitherAlgorithm) || 'floyd-steinberg';
  const isOrdered = pixels.transformers.DITHER_ORDERED_ALGORITHMS.has(algorithm);
  const isErrorDiffusion = transformations.dither && !isOrdered;

  const targetWidth = params.scale.x * constants.SCALE_FACTOR;
  const targetHeight = params.scale.y * constants.SCALE_FACTOR;
  const colorTransformer = pixels.transformers.createColorTransformer(transformations);

  if (isErrorDiffusion) {
    // --- Error-diffusion path ---
    // Step 1: Downscale + apply color correction (no palette quantization yet)
    const scaledGrid = pixels.conversion.scaleAndProcessImageData({
      image_data,
      target_width: targetWidth,
      target_height: targetHeight,
      transformers: [colorTransformer]
    });

    // Step 2: Convert to flat RGBA buffer
    const buffer = pixels.conversion.pixelGridToFlatBuffer(scaledGrid, targetWidth, targetHeight);

    // Step 3: Get flattened palette colors
    const flattened = Object.values(
      pixels.conversion.flattenColors(params.palette, params.color_spectrum)
    ) as pixels.Pixel[];

    // Step 4: Apply error diffusion directly on the buffer
    // (quantizes to palette and propagates error to neighboring pixels)
    pixels.transformers.applyErrorDiffusionToBuffer(buffer, targetWidth, targetHeight, flattened, algorithm);

    // Step 5: Convert back to PixelGrid
    return pixels.conversion.flatBufferToPixelGrid(buffer, targetWidth, targetHeight);
  }

  // For ordered/Bayer algorithms, we need the flattened palette colors
  // so the transformer can pick between the two closest colors directly
  let transformer: pixels.PixelTransformer;
  if (transformations.dither && isOrdered) {
    const flattened = Object.values(
      pixels.conversion.flattenColors(params.palette, params.color_spectrum)
    ) as pixels.Pixel[];
    transformer = pixels.transformers.createDitherTransformer({
      algorithm,
      paletteColors: flattened,
      strength: transformations.dither_strength ?? 48
    });
  } else {
    transformer = palette_transformer;
  }

  return pixels.conversion.scaleAndProcessImageData({
    image_data,
    target_width: targetWidth,
    target_height: targetHeight,
    transformers: [colorTransformer, transformer]
  });
};

const generatePreview = (params: GenerationParams) => {
  const color_converted = baseImagePipeline(params);

  const ratio_xy = params.scale.y / params.scale.x;
  const ratio_yx = params.scale.x / params.scale.y;
  let width, height;
  if (params.scale.x > params.scale.y) {
    width = constants.RENDER_IMAGE_MAX_SIZE;
    height = Math.round(width * ratio_xy);
  } else {
    height = constants.RENDER_IMAGE_MAX_SIZE;
    width = Math.round(height * ratio_yx);
  }

  return pixels.conversion.convertPixelGridToImageData(color_converted, width, height);
};

type BlockGenerationParams = GenerationParams & {
  staircase_alg: generation.block_generation.StaircaseAlgorithm;
  support_block_id: string;
};

const generateBlockSpaceFromImageData = (params: BlockGenerationParams) => {
  const color_converted = baseImagePipeline(params);

  const blocks = pixels.conversion.convertPixelGridToMCBlocks(color_converted, params.palette);
  return generation.block_generation.generateBlockSpace({
    block_grid: blocks,
    support_block_id: params.support_block_id,
    staircase_alg: params.staircase_alg
  });
};

export const generateLightmaticaSchema = async (params: BlockGenerationParams) => {
  const block_space = generateBlockSpaceFromImageData(params);
  const mapScaleX = params.scale.x;
  const mapScaleY = params.scale.y;

  if (params.split) {
    // Generate individual schemas per map tile and bundle into a zip
    const JSZip = await import('jszip');
    const zip = new JSZip.default();

    const tiles = generation.schema_generation.litematica.generateSplitLitematicaSchemas(
      block_space,
      mapScaleX,
      mapScaleY
    );

    for (let tileZ = 0; tileZ < tiles.length; tileZ++) {
      for (let tileX = 0; tileX < (tiles[0]?.length ?? 0); tileX++) {
        const tile = tiles[tileZ]?.[tileX];
        if (tile) {
          const serialized = await generation.serialization.serializeNBTData(tile);
          zip.file(`map_x${tileX}_z${tileZ}.litematic`, serialized);
        }
      }
    }

    return await zip.generateAsync({ type: 'uint8array' });
  } else {
    const schema = generation.schema_generation.litematica.generateLitematicaSchema(block_space);
    return await generation.serialization.serializeNBTData(schema);
  }
};

export const generateMapNBT = async (params: BlockGenerationParams) => {
  const block_space = generateBlockSpaceFromImageData(params);
  const mapScaleX = params.scale.x;
  const mapScaleY = params.scale.y;

  if (params.split) {
    // Generate individual NBT files per map tile and bundle into a zip
    const JSZip = await import('jszip');
    const zip = new JSZip.default();

    const tiles = generation.schema_generation.map.asSplitNbtObjects(block_space, mapScaleX, mapScaleY);

    for (let tileZ = 0; tileZ < tiles.length; tileZ++) {
      for (let tileX = 0; tileX < (tiles[0]?.length ?? 0); tileX++) {
        const tile = tiles[tileZ]?.[tileX];
        if (tile) {
          const serialized = await generation.serialization.serializeNBTData(tile);
          zip.file(`map_x${tileX}_z${tileZ}.nbt`, serialized);
        }
      }
    }

    return await zip.generateAsync({ type: 'uint8array' });
  } else {
    const map = generation.schema_generation.map.asNbtObject(block_space);
    return await generation.serialization.serializeNBTData(map);
  }
};

export const generateMapJSON = async (params: BlockGenerationParams) => {
  const block_space = generateBlockSpaceFromImageData(params);
  return Buffer.from(JSON.stringify(block_space));
};

export const generateMaterialsList = async (params: BlockGenerationParams) => {
  const block_space = generateBlockSpaceFromImageData(params);

  return block_space.reduce((counts: Record<string, number>, block) => {
    counts[block.id] = (counts[block.id] || 0) + 1;
    return counts;
  }, {});
};

const API = {
  generatePreview: generatePreview,
  generateLitematicaSchema: generateLightmaticaSchema,
  generateMapNBT: generateMapNBT,
  generateMapJSON: generateMapJSON,
  generateMaterialsList: generateMaterialsList
};

export type API = typeof API;

comlink.expose(API);
