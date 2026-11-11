import type { GeoPoint } from '@pace/domain';
import { computeBounds } from '@pace/gps-engine';
import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { loadConfig } from '@/config/env';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface RouteMapProps {
  /** Route segments (pauses and signal gaps are breaks between segments). */
  segments: readonly (readonly GeoPoint[])[];
  height?: number;
  style?: ViewStyle;
  /** Live mode: follow the latest point instead of fitting the whole route. */
  follow?: boolean;
}

/**
 * Map provider abstraction. Uses MapLibre with the configured, properly licensed style URL.
 * When no tile provider is configured (or tiles are unavailable) the route is still drawn as
 * vector geometry, so recording and review never depend on map tiles.
 */
export function RouteMap({ segments, height = 240, style, follow = false }: RouteMapProps) {
  const cfg = loadConfig();
  const styleUrl = cfg.ok ? cfg.config.mapStyleUrl : undefined;
  if (!styleUrl) return <RouteSketch segments={segments} height={height} style={style} />;
  return (
    <MapLibreRoute
      segments={segments}
      height={height}
      style={style}
      follow={follow}
      styleUrl={styleUrl}
    />
  );
}

function MapLibreRoute({
  segments,
  height,
  style,
  follow,
  styleUrl,
}: Required<Omit<RouteMapProps, 'style'>> & { style?: ViewStyle; styleUrl: string }) {
  const { colors, radius } = useTheme();
  const nonEmpty = segments.filter((s) => s.length > 0);
  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: nonEmpty
        .filter((s) => s.length > 1)
        .map((s, i) => ({
          type: 'Feature' as const,
          id: i,
          properties: {},
          geometry: {
            type: 'LineString' as const,
            coordinates: s.map((p) => [p.longitude, p.latitude]),
          },
        })),
    }),
    [nonEmpty],
  );
  const all = nonEmpty.flat();
  const bounds = computeBounds(all);
  const last = all[all.length - 1];
  return (
    <View
      style={[
        { height, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.surface },
        style,
      ]}
    >
      <Map
        style={{ flex: 1 }}
        mapStyle={styleUrl}
        attribution
        logo={false}
        compass={false}
        scaleBar={false}
      >
        {follow && last ? (
          <Camera initialViewState={{ center: [last.longitude, last.latitude], zoom: 15 }} />
        ) : bounds ? (
          <Camera
            initialViewState={{
              bounds: [
                bounds.minLongitude,
                bounds.minLatitude,
                bounds.maxLongitude,
                bounds.maxLatitude,
              ],
              padding: { top: 32, right: 32, bottom: 32, left: 32 },
            }}
          />
        ) : null}
        <GeoJSONSource id="route" data={geojson}>
          <Layer
            type="line"
            id="route-line"
            paint={{ 'line-color': colors.route, 'line-width': 4 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </GeoJSONSource>
      </Map>
    </View>
  );
}

/** Tile-free vector rendering of a route using a local equirectangular projection. */
export function RouteSketch({ segments, height = 240, style }: Omit<RouteMapProps, 'follow'>) {
  const { colors, radius, spacing } = useTheme();
  const all = segments.flat();
  const bounds = computeBounds(all);
  const width = 340;
  const pad = 16;
  if (!bounds || all.length < 2) {
    return (
      <View
        style={[
          {
            height,
            borderRadius: radius.lg,
            backgroundColor: colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          },
          style,
        ]}
      >
        <Text variant="bodySmall" color="secondary">
          No route recorded yet
        </Text>
      </View>
    );
  }
  const midLat = ((bounds.minLatitude + bounds.maxLatitude) / 2) * (Math.PI / 180);
  const spanX = Math.max(1e-9, (bounds.maxLongitude - bounds.minLongitude) * Math.cos(midLat));
  const spanY = Math.max(1e-9, bounds.maxLatitude - bounds.minLatitude);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const project = (p: GeoPoint): [number, number] => [
    pad +
      (p.longitude - bounds.minLongitude) * Math.cos(midLat) * scale +
      (width - 2 * pad - spanX * scale) / 2,
    height -
      pad -
      (p.latitude - bounds.minLatitude) * scale -
      (height - 2 * pad - spanY * scale) / 2,
  ];
  const first = project(all[0]!);
  const last = project(all[all.length - 1]!);
  return (
    <View
      style={[
        { height, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: 'hidden' },
        style,
      ]}
      accessibilityLabel="Route outline"
    >
      <Svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {segments.map((s, i) =>
          s.length > 1 ? (
            <Polyline
              key={i}
              points={s.map((p) => project(p).join(',')).join(' ')}
              fill="none"
              stroke={colors.route}
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null,
        )}
        <Circle cx={first[0]} cy={first[1]} r={5} fill={colors.success} />
        <Circle cx={last[0]} cy={last[1]} r={5} fill={colors.error} />
      </Svg>
      <Text
        variant="caption"
        color="secondary"
        style={{ position: 'absolute', bottom: spacing.xs, right: spacing.sm }}
      >
        Map tiles not configured
      </Text>
    </View>
  );
}
