import { BlockSpace } from '../../block-generation';
import * as _ from 'lodash';

const MAP_SIZE = 128;

const getBlockSpaceDimensions = (block_space: BlockSpace) => {
  return block_space.reduce(
    (dimensions, block) => {
      if (block.x > dimensions.width) {
        dimensions.width = block.x + 1;
      }
      if (block.y > dimensions.height) {
        dimensions.height = block.y + 1;
      }
      if (block.z > dimensions.length) {
        dimensions.length = block.z + 1;
      }
      return dimensions;
    },
    { width: 0, height: 0, length: 0 }
  );
};

export const asNbtObject = (space: BlockSpace): object => {
  const { width, height, length } = getBlockSpaceDimensions(space);

  const palette: string[] = [];

  const addToPalette = (sid: string): number => {
    if (sid === 'minecraft:air') {
      return 0;
    }
    let id: number = palette.indexOf(sid);
    if (id === -1) {
      id = palette.length;
      palette.push(sid);
    }
    return id;
  };

  const index = space.reduce((index, block) => {
    index.set(`${block.x}:${block.y}:${block.z}`, block.id);
    return index;
  }, new Map<string, string>());

  const getSid = (x: number, y: number, z: number): string => {
    const id = index.get(`${x}:${y}:${z}`);
    if (!id || id === 'minecraft:air') {
      return 'minecraft:air';
    }
    return id;
  };

  const blocks = _.range(width).reduce((blocks, x) => {
    return _.range(length).reduce((blocks, z) => {
      return _.range(height).reduce((blocks, y) => {
        if (getSid(x, y, z) === 'minecraft:air') {
          return blocks;
        }
        blocks.push({
          pos: {
            type: 'list',
            value: {
              type: 'int',
              value: [x, y, z]
            }
          },
          state: {
            type: 'int',
            value: addToPalette(getSid(x, y, z))
          }
        });
        return blocks;
      }, blocks);
    }, blocks);
  }, [] as object[]);

  return {
    name: '',
    value: {
      size: {
        type: 'list',
        value: {
          type: 'int',
          value: [width, height, length]
        }
      },
      entities: {
        type: 'list',
        value: {
          type: 'end',
          value: []
        }
      },
      blocks: {
        type: 'list',
        value: {
          type: 'compound',
          value: blocks
        }
      },
      palette: {
        type: 'list',
        value: {
          type: 'compound',
          value: palette.map((s) => {
            return {
              Name: {
                type: 'string',
                value: s
              }
            };
          })
        }
      },
      DataVersion: {
        type: 'int',
        value: 2584
      }
    }
  };
};

/**
 * Split a BlockSpace into individual 128×128 map tile NBT objects.
 *
 * Returns a 2D array [tileZ][tileX] of NBT objects, each representing the
 * blocks inside its 128×128 tile. Tiles with no blocks will have a null entry.
 *
 * This mirrors the REFERENCE's approach of generating one NBT file per map section.
 */
export const asSplitNbtObjects = (space: BlockSpace, mapScaleX: number, mapScaleY: number): (object | null)[][] => {
  // Group blocks by tile coordinates
  const tiles = new Map<string, BlockSpace>();
  for (const block of space) {
    // Each map tile covers 128 blocks in X and Z.
    // The block space offsets every image block by +1 on the Z axis (reserving Z=0 for the
    // north support block), so tile membership must be computed from block.z - 1.
    const tileX = Math.floor(block.x / MAP_SIZE);
    const tileZ = Math.floor((block.z - 1) / MAP_SIZE);

    // Skip blocks that fall outside the expected tile grid (this also drops the
    // single north support block at Z=0, which is not part of any tile's image)
    if (tileX < 0 || tileX >= mapScaleX || tileZ < 0 || tileZ >= mapScaleY) {
      continue;
    }

    const key = `${tileZ}:${tileX}`;
    if (!tiles.has(key)) {
      tiles.set(key, []);
    }
    // Shift coordinates to be local to the tile (origin at 0,0,0)
    tiles.get(key)!.push({
      ...block,
      x: block.x - tileX * MAP_SIZE,
      z: block.z - 1 - tileZ * MAP_SIZE
    });
  }

  // Build the 2D array [tileZ][tileX]
  const result: (object | null)[][] = [];
  for (let tileZ = 0; tileZ < mapScaleY; tileZ++) {
    const row: (object | null)[] = [];
    for (let tileX = 0; tileX < mapScaleX; tileX++) {
      const key = `${tileZ}:${tileX}`;
      const tileBlocks = tiles.get(key);
      if (tileBlocks && tileBlocks.length > 0) {
        row.push(asNbtObject(tileBlocks));
      } else {
        row.push(null);
      }
    }
    result.push(row);
  }

  return result;
};
