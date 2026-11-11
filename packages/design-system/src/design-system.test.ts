import { contrastRatio, darkColors, lightColors } from './index';

describe('design tokens', () => {
  it.each([
    ['dark', darkColors],
    ['light', lightColors],
  ])('%s theme meets WCAG AA contrast for text', (_name, c) => {
    expect(contrastRatio(c.textPrimary, c.background)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the approved brand palette', () => {
    expect(darkColors.background).toBe('#080B12');
    expect(darkColors.primary).toBe('#2878FF');
    expect(darkColors.accent).toBe('#49A0FF');
  });
});
