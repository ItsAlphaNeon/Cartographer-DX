import { describe, it, expect } from 'vitest';

import { asSplitNbtObjects } from '../src/schema-generation/map';
import { BlockSpace } from '../src/block-generation';

/**
 * Mimics generateBlockSpace output: every image row at grid index i is placed at
 * z = i + 1 (reserving Z=0 for the north support block), each image block gets a
 * support block below it, and a single north support block is added per column.
 */
const buildBlockSpace = (width: number, height: number): BlockSpace => {
  const space: BlockSpace = [];
  for (let x = 0; x < width; x++) {
    for (let i = 0; i < height; i++) {
      space.push({ id: 'minecraft:white_carpet', hue: 1, x, y: 1, z: i + 1 });
      space.push({ id: 'minecraft:cobblestone', hue: 0, x, y: 0, z: i + 1 });
    }
    space.push({ id: 'minecraft:cobblestone', hue: 0, x, y: 1, z: 0 });
  }
  return space;
};

const tileBlocks = (tile: object | null): { pos: { value: { value: number[] } }; state: { value: number } }[] => {
  if (!tile) return [];
  const t = tile as any;
  return t.value.blocks.value.value;
};

const tilePalette = (tile: object | null): string[] => {
  if (!tile) return [];
  const t = tile as any;
  return t.value.palette.value.value.map((p: any) => p.Name.value);
};

describe('asSplitNbtObjects', () => {
  it('splits a 2x2 map into tiles that each contain exactly their 128 image rows', () => {
    const space = buildBlockSpace(256, 256); // 2x2 tiles
    const tiles = asSplitNbtObjects(space, 2, 2);

    for (let tileZ = 0; tileZ < 2; tileZ++) {
      for (let tileX = 0; tileX < 2; tileX++) {
        const tile = tiles[tileZ][tileX];
        expect(tile, `tile(${tileX},${tileZ}) should exist`).not.toBeNull();

        const palette = tilePalette(tile);
        const cobbleState = palette.indexOf('minecraft:cobblestone');
        const blocks = tileBlocks(tile);

        // Collect the local z rows that have image (non-cobblestone) blocks
        const imageZs = new Set<number>();
        for (const block of blocks) {
          const [, y, z] = block.pos.value.value;
          if (block.state.value === cobbleState) continue; // support / north block
          expect(y, 'image blocks should be at y=1').toBe(1);
          imageZs.add(z);
        }

        // Every local z 0..127 must be present and nothing beyond
        for (let z = 0; z < 128; z++) {
          expect(imageZs.has(z), `tile(${tileX},${tileZ}) is missing image row z=${z}`).toBe(true);
        }
        expect(imageZs.size, `tile(${tileX},${tileZ}) should have exactly 128 image rows`).toBe(128);
      }
    }
  });

  it('does not place the north support block inside any tile', () => {
    const space = buildBlockSpace(256, 256);
    const tiles = asSplitNbtObjects(space, 2, 2);

    const tile = tiles[0][0]!;
    const palette = tilePalette(tile);
    const cobbleState = palette.indexOf('minecraft:cobblestone');
    const blocks = tileBlocks(tile);

    const northAtZ0 = blocks.some((b) => {
      const [, y, z] = b.pos.value.value;
      return z === 0 && y === 1 && b.state.value === cobbleState;
    });
    expect(northAtZ0, 'north support block should be dropped from tiles').toBe(false);
  });
});
