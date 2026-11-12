# Design system

Tokens: `packages/design-system/src/index.ts`. Components: `apps/mobile/src/components`.
Screens never hardcode colours, font sizes or spacing.

## Colour (dark — shipped)

| Token | Value | Use |
|---|---|---|
| background | #080B12 | App background |
| surface | #101725 | Cards, inputs, tab bar |
| surfaceElevated | #172235 | Selected states, secondary buttons |
| primary | #2878FF | Primary actions, latest chart bar |
| accent | #49A0FF | Key metrics, links, route line |
| accentSoft | #8ABFFF | Secondary emphasis |
| primaryMuted | rgba(40, 120, 255, 0.16) | Tint behind sport icons, change pills and step icons |
| textPrimary | #F4F7FC | Body text |
| textSecondary | #8995A8 | Labels, captions |
| divider | #243146 | Hairlines, borders |
| success / warning / error | #36C98A / #F4B84B / #F06B76 | Status |

A light theme with the same token names exists for a future toggle. Contrast is unit-tested
(WCAG AA: text ≥ 4.5:1, primary text on background ≥ 7:1).

## Typography

Inter (400/500/600/700). Metric styles (`display`, `metricLarge`, `metric`, `metricSmall`) use
**tabular numerals** so live numbers don't jitter. Dynamic Type is honoured with caps
(metrics ×1.3, text ×2) to keep the recording screen legible.

## Spacing, radius, touch

Spacing 2/4/8/12/16/24/32/48; radius 8/12/16/24/pill; minimum touch target 44 pt, large 64 pt,
record control 88 pt.

## Components

`Text`, `Button` (primary/secondary/ghost/danger, loading), `Input` (label, error, hint),
`Card`, `MetricTile`, `SectionHeader`, `ListRow`, `ToggleRow`, `Chip`, `Segmented`,
`ProgressBar`, `Banner`, `LoadingState`, `EmptyState`, `ErrorState`, `BarChart`, `RouteMap`,
`ActivityRow`. Icons: Ionicons only.

## Rules

- Blue is for primary actions and key metrics only; no extra accent colours.
- Recording screen: large statistics and controls first, map optional and secondary.
- Every control has an accessibility role and label; disabled "future release" items are labelled.
- Avoid gradients, glassmorphism and decorative charts.
