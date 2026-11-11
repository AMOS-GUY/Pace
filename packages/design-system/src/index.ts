/**
 * PACE design tokens. Screens never hardcode colours, sizes or fonts — they read from here,
 * so the brand can be tuned in one place. Dark is the primary experience; light is defined
 * with the same token names so it can be enabled later without touching screens.
 */

export interface ColorTokens {
  background: string;
  surface: string;
  surfaceElevated: string;
  primary: string;
  primaryPressed: string;
  accent: string;
  accentSoft: string;
  textPrimary: string;
  textSecondary: string;
  textOnPrimary: string;
  divider: string;
  success: string;
  warning: string;
  error: string;
  overlay: string;
  /** Route polyline on maps. */
  route: string;
  /** Recording indicator. */
  recording: string;
}

export const darkColors: ColorTokens = {
  background: '#080B12',
  surface: '#101725',
  surfaceElevated: '#172235',
  primary: '#2878FF',
  primaryPressed: '#1F63D6',
  accent: '#49A0FF',
  accentSoft: '#8ABFFF',
  textPrimary: '#F4F7FC',
  textSecondary: '#8995A8',
  textOnPrimary: '#FFFFFF',
  divider: '#243146',
  success: '#36C98A',
  warning: '#F4B84B',
  error: '#F06B76',
  overlay: 'rgba(8, 11, 18, 0.72)',
  route: '#49A0FF',
  recording: '#F06B76',
};

/** Future light theme: same semantics, contrast-checked against white surfaces. */
export const lightColors: ColorTokens = {
  background: '#F5F7FB',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  primary: '#1F63D6',
  primaryPressed: '#184FAB',
  accent: '#2878FF',
  accentSoft: '#5A9BFF',
  textPrimary: '#0B1220',
  textSecondary: '#55627A',
  textOnPrimary: '#FFFFFF',
  divider: '#DDE3EE',
  success: '#1E9E68',
  warning: '#B97A0F',
  error: '#C93C49',
  overlay: 'rgba(11, 18, 32, 0.5)',
  route: '#1F63D6',
  recording: '#C93C49',
};

export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export interface TextStyleToken {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  /** Tabular numerals keep live metrics from jittering as digits change. */
  tabular?: boolean;
}

export const typography = {
  display: {
    fontFamily: fontFamily.bold,
    fontSize: 64,
    lineHeight: 70,
    letterSpacing: -1.5,
    tabular: true,
  },
  metricLarge: {
    fontFamily: fontFamily.bold,
    fontSize: 44,
    lineHeight: 50,
    letterSpacing: -1,
    tabular: true,
  },
  metric: {
    fontFamily: fontFamily.semibold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.5,
    tabular: true,
  },
  metricSmall: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 26, tabular: true },
  title: { fontFamily: fontFamily.bold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  heading: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 26 },
  subheading: { fontFamily: fontFamily.semibold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 24 },
  bodySmall: { fontFamily: fontFamily.regular, fontSize: 14, lineHeight: 20 },
  label: { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18, letterSpacing: 0.4 },
  caption: { fontFamily: fontFamily.regular, fontSize: 12, lineHeight: 16 },
} as const satisfies Record<string, TextStyleToken>;

export type TypographyVariant = keyof typeof typography;

export const elevation = {
  none: { shadowOpacity: 0, shadowRadius: 0, shadowOffsetY: 0, elevation: 0 },
  card: { shadowOpacity: 0.25, shadowRadius: 12, shadowOffsetY: 4, elevation: 3 },
  modal: { shadowOpacity: 0.4, shadowRadius: 24, shadowOffsetY: 12, elevation: 8 },
} as const;

/** Minimum touch target (Apple HIG 44pt); recording controls use the larger size. */
export const touchTarget = { min: 44, large: 64, record: 88 } as const;

export const motion = { fast: 120, normal: 220, slow: 360 } as const;

export interface Theme {
  mode: 'dark' | 'light';
  colors: ColorTokens;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  elevation: typeof elevation;
  touchTarget: typeof touchTarget;
  motion: typeof motion;
}

export const darkTheme: Theme = {
  mode: 'dark',
  colors: darkColors,
  spacing,
  radius,
  typography,
  elevation,
  touchTarget,
  motion,
};
export const lightTheme: Theme = {
  mode: 'light',
  colors: lightColors,
  spacing,
  radius,
  typography,
  elevation,
  touchTarget,
  motion,
};

/** WCAG relative luminance contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}
