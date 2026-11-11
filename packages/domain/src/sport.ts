/** All sports supported by PACE. Order is the canonical display order. */
export const SPORT_TYPES = [
  'running',
  'cycling',
  'walking',
  'hiking',
  'swimming',
  'triathlon',
] as const;
export type SportType = (typeof SPORT_TYPES)[number];

/** Segment kinds that can make up a multisport (triathlon) session, in race order. */
export const MULTISPORT_SEGMENT_TYPES = [
  'swim',
  'transition_1',
  'bike',
  'transition_2',
  'run',
] as const;
export type MultisportSegmentType = (typeof MULTISPORT_SEGMENT_TYPES)[number];

export type SwimMode = 'pool' | 'open_water';

export function isSportType(value: unknown): value is SportType {
  return typeof value === 'string' && (SPORT_TYPES as readonly string[]).includes(value);
}
