import { Transformations } from '../workers/api.worker';
import * as overlay from './selection-overlay';
import * as constants from '../constants';
import styled from 'styled-components';
import * as hooks from '../hooks';
import * as defs from '../defs';
import * as React from 'react';
import * as pixels from '@cartographer/pixels';
import Slider from './slider';
import * as _ from 'lodash';

import MultiButton from './multi-button';
import Tooltip from './tooltip';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: stretch;
`;

const CanvasContainer = styled.div`
  display: flex;
  flex-grow: 1;
  position: relative;
  padding: 10px;
  border: 2px dashed ${(props) => props.theme.bg4};
`;

const Canvas = styled.canvas`
  border: 1px solid ${(props) => props.theme.bg2};
`;

const Options = styled.div`
  display: flex;
  flex-direction: row;
  flex-grow: 1;
`;

const ResetButton = styled.span`
  cursor: pointer;
  font-weight: bold;
  font-size: 11px;
  color: ${(props) => props.theme.fg2};
  border: 1px dashed ${(props) => props.theme.fg3};
  padding: 2px 6px;
  align-self: flex-end;
  margin-top: 4px;

  :hover {
    color: ${(props) => props.theme.fg0};
    border-color: ${(props) => props.theme.fg2};
  }
`;

type Props = {
  image_data: ImageData;
  scale: defs.Scale;
  onBoundsChange: (bounds: defs.Bounds, raw_bounds: defs.Bounds) => void;

  transformations: Transformations;
  setTransformations: (transformations: Transformations) => void;
};

export const SourceImage: React.FC<Props> = (props) => {
  const [bounds, setBounds] = React.useState<defs.Bounds>();
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const api = hooks.withAPIWorker();

  const ratio_xy = props.image_data.height / props.image_data.width;
  const ratio_yx = props.image_data.width / props.image_data.height;

  let width: number, height: number, scale_factor: number;
  if (props.image_data.height > props.image_data.width) {
    height = constants.RENDER_IMAGE_MAX_SIZE;
    width = height * ratio_yx;
    scale_factor = props.image_data.height / height;
  } else {
    width = constants.RENDER_IMAGE_MAX_SIZE;
    height = width * ratio_xy;
    scale_factor = props.image_data.width / width;
  }

  const min_x = Math.ceil((props.scale.x * constants.SCALE_FACTOR) / scale_factor);
  const min_y = Math.ceil((props.scale.y * constants.SCALE_FACTOR) / scale_factor);

  const scaleAndNotify = (bounds: defs.Bounds) => {
    const scaled_bounds = bounds.map((item) => Math.floor(item * scale_factor)) as defs.Bounds;
    props.onBoundsChange(scaled_bounds, bounds);
  };

  const scaleAndNotifyDebounced = React.useCallback(_.debounce(scaleAndNotify, 100, { maxWait: 200 }), [
    props.image_data,
    props.scale
  ]);

  const updateBounds = (bounds: defs.Bounds) => {
    setBounds(bounds);
    scaleAndNotifyDebounced(bounds);
  };

  React.useEffect(() => {
    (async () => {
      if (!canvas.current || !api.current) {
        return;
      }

      const scale_canvas = new OffscreenCanvas(props.image_data.width, props.image_data.height);
      const scale_context = scale_canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

      scale_context.putImageData(props.image_data, 0, 0);

      canvas.current.setAttribute('width', width.toString());
      canvas.current.setAttribute('height', height.toString());

      const context = canvas.current.getContext('2d')!;
      context.drawImage(scale_canvas, 0, 0, width, height);
    })();
  }, [props.image_data, api.current]);

  React.useEffect(() => {
    const bounds: defs.Bounds = [0, 0, min_x, min_y];
    setBounds(bounds);
    scaleAndNotify(bounds);
  }, [min_x, min_y]);

  return (
    <Container>
      <CanvasContainer>
        <Canvas ref={canvas} style={{ width, height }} />

        {bounds ? (
          <overlay.SelectionOverlay
            bounds={bounds}
            scale={props.scale}
            min_x={min_x}
            min_y={min_y}
            onBoundsChange={updateBounds}
            canvas_dimensions={[width, height]}
          />
        ) : null}
      </CanvasContainer>

      <Options>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, marginRight: 15 }}>
          <Slider
            label="Saturation"
            style={{ marginTop: 10 }}
            value={props.transformations.saturation || 0}
            onChange={(value) => {
              props.setTransformations({
                ...props.transformations,
                saturation: value
              });
            }}
          />

          <ResetButton
            onClick={() => {
              props.setTransformations({
                ...props.transformations,
                saturation: 0
              });
            }}
          >
            Reset
          </ResetButton>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
          <Slider
            label="Brightness"
            style={{ marginTop: 10 }}
            value={props.transformations.brightness || 0}
            onChange={(value) => {
              props.setTransformations({
                ...props.transformations,
                brightness: value
              });
            }}
          />

          <ResetButton
            onClick={() => {
              props.setTransformations({
                ...props.transformations,
                brightness: 0
              });
            }}
          >
            Reset
          </ResetButton>
        </div>
      </Options>

      <Options>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
          <Tooltip
            style={{ marginTop: 5 }}
            direction="up"
            tooltip={[
              "Enabling dithering will introduce some intentional noise to the image with the aim of keeping as much of the original images' color as possible.",
              'This has varying levels of success depending on the input image and scaling/zooming applied. It is recommended to play with the image saturation when enabling this.',
              'Your milage may vary.'
            ]}
          >
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
              <span
                style={{
                  marginRight: 10,
                  color: 'rgba(255,255,255,0.65)',
                  fontSize: 11,
                  fontWeight: 'bold'
                }}
              >
                Dithering
              </span>
              <MultiButton
                selected={
                  props.transformations.dither
                    ? _.upperFirst(props.transformations.dither_algorithm || 'Floyd-Steinberg')
                    : 'None'
                }
                action_opens_picker
                onSelectionChange={(name) => {
                  if (name === 'None') {
                    props.setTransformations({
                      ...props.transformations,
                      dither: false
                    });
                  } else {
                    props.setTransformations({
                      ...props.transformations,
                      dither: true,
                      dither_algorithm: name.toLowerCase()
                    });
                  }
                }}
                actions={[
                  { name: 'None' },
                  ...pixels.transformers.DITHER_ALGORITHMS.map((alg) => ({
                    name: _.upperFirst(alg)
                  }))
                ]}
              />
            </div>
          </Tooltip>

          {props.transformations.dither &&
            props.transformations.dither_algorithm &&
            pixels.transformers.DITHER_ORDERED_ALGORITHMS.has(props.transformations.dither_algorithm as any) && (
              <Slider
                label="Strength"
                style={{ marginTop: 8 }}
                value={props.transformations.dither_strength ?? 48}
                min={0}
                max={255}
                onChange={(value) => {
                  props.setTransformations({
                    ...props.transformations,
                    dither_strength: value
                  });
                }}
              />
            )}
        </div>
      </Options>
    </Container>
  );
};

export default SourceImage;
