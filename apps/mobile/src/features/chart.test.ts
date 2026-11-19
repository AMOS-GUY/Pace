import { axisLabels } from './chart';

const weeks = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${String(((i * 7) % 28) + 1).padStart(2, '0')}/09`);
const CHAR = 0.62 * 12; // caption: Inter 12 px

/** Labels never overlap each other and stay inside the chart. */
function expectReadable(width: number, labels: ReturnType<typeof axisLabels>, text: string[]) {
  for (const l of labels) {
    expect(l.left).toBeGreaterThanOrEqual(0);
    expect(l.left + l.width).toBeLessThanOrEqual(width + 1e-9);
    expect(l.width).toBeGreaterThanOrEqual(text[l.index]!.length * CHAR); // never truncated
  }
  for (let i = 1; i < labels.length; i++) {
    expect(labels[i]!.left).toBeGreaterThanOrEqual(
      labels[i - 1]!.left + labels[i - 1]!.width - 1e-9,
    );
  }
}

describe('axisLabels', () => {
  // Card content widths: iPhone SE (320 pt screen) to Pro Max (440 pt), and larger text.
  for (const screen of [320, 375, 402, 440]) {
    for (const scale of [1, 1.35]) {
      it(`12 weekly labels on a ${screen} pt screen at text scale ${scale} fit untruncated`, () => {
        const width = screen - 2 * 16 - 2 * 16; // screen and card padding
        const text = weeks(12);
        const labels = axisLabels(text, width, 4, CHAR * scale);
        expect(labels.length).toBeGreaterThan(1);
        expectReadable(width, labels, text);
      });
    }
  }

  it('always labels the latest (highlighted) bar', () => {
    const text = weeks(12);
    expect(axisLabels(text, 300, 4, CHAR).at(-1)?.index).toBe(11);
  });

  it('labels every bar when there is room', () => {
    const text = ['2024', '2025', '2026'];
    expect(axisLabels(text, 300, 4, CHAR).map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('copes with nothing to draw', () => {
    expect(axisLabels([], 300, 4, CHAR)).toEqual([]);
    expect(axisLabels(['a'], 0, 4, CHAR)).toEqual([]);
  });
});
