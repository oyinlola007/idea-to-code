// Zoom out, zoom in and back to the reading view, in the chart's bottom-right corner.
import { Panel, useViewport } from '@xyflow/react';
import { atZoomLimit, ZOOM_MAX, ZOOM_MIN } from '../layout/geometry.js';

interface Props {
  onZoom: (direction: 'in' | 'out') => void;
  onFit: () => void;
}

export function ZoomControls({ onZoom, onFit }: Props) {
  const { zoom } = useViewport();
  return <ZoomButtons zoom={zoom} onZoom={onZoom} onFit={onFit} />;
}

/** The buttons alone, for a given zoom: what the tests render. */
export function ZoomButtons({ zoom, onZoom, onFit }: Props & { zoom: number }) {
  const buttons = [
    {
      label: 'Zoom out',
      icon: 'zoom-out',
      disabled: atZoomLimit(zoom, ZOOM_MIN),
      run: () => {
        onZoom('out');
      },
    },
    {
      label: 'Zoom in',
      icon: 'zoom-in',
      disabled: atZoomLimit(zoom, ZOOM_MAX),
      run: () => {
        onZoom('in');
      },
    },
    { label: 'Fit', icon: 'screen-normal', disabled: false, run: onFit },
  ];
  return (
    <Panel position="bottom-right" className="zoom" role="group" aria-label="Zoom">
      {buttons.map((b) => (
        <button
          key={b.icon}
          type="button"
          className="icon-button"
          title={b.label}
          aria-label={b.label}
          disabled={b.disabled}
          onClick={b.run}
        >
          <span className={`codicon codicon-${b.icon}`} aria-hidden="true" />
        </button>
      ))}
    </Panel>
  );
}
