import { describe, expect, it } from 'vitest';
import { LaserOverlay } from '../src/effects/LaserOverlay';

describe('LaserOverlay', () => {
  it('places a stationary laser at the target center, including former text targets', () => {
    const overlay = LaserOverlay({
      geometry: { x: 20, y: 30, w: 40, h: 20, centerX: 40, centerY: 40 },
      avoidCoveringTarget: true,
    });

    expect(overlay.props.initial).toMatchObject({ left: '40%', top: '40%' });
    expect(overlay.props.animate).toMatchObject({ left: '40%', top: '40%' });
  });

  it('moves between the centers of consecutive targets', () => {
    const overlay = LaserOverlay({
      geometry: { x: 60, y: 50, w: 20, h: 20, centerX: 70, centerY: 60 },
      previousGeometry: { x: 10, y: 20, w: 20, h: 20, centerX: 20, centerY: 30 },
      avoidCoveringTarget: true,
      previousAvoidCoveringTarget: true,
    });

    expect(overlay.props.initial).toMatchObject({ left: '20%', top: '30%' });
    expect(overlay.props.animate).toMatchObject({ left: '70%', top: '60%' });
  });
});
