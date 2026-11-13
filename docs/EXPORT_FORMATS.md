# What PACE's exports contain

PACE has two exports:
- **GPX per activity:** for other apps.
- **Portable export:** a ZIP of `data.json`, CSV files and one GPX per activity.

GPX is a route format: it cannot carry everything PACE records. The portable export keeps
everything.

## GPX export

| Data | In the GPX? | How |
|---|---|---|
| Route points (position, elevation, time) | Yes | `<trkpt>`, one `<trkseg>` per recording segment (pauses split segments) |
| Sport | Yes | `<trk><type>`: running, cycling, walking, hiking, swimming, triathlon |
| Heart rate | Yes | Garmin TrackPointExtension v1 `<gpxtpx:hr>`, one value per sample (R6, below) |
| Cadence | Yes | Garmin TrackPointExtension v1 `<gpxtpx:cad>`, one value per sample, whole rpm (R6, below) |
| **Power** | **Yes** (since R1) | Garmin PowerExtension v1 `<gpxpx:PowerInWatts>`, see below |
| Laps | **No** | GPX has no laps (R2). Use the portable export. |
| Triathlon legs and transitions | **No** | GPX has no legs (R3). Use the portable export. |
| Splits, records, notes, device data | No | Portable export (`data.json`, CSV) |
| Privacy zone | Applied | Points inside the zone around the start and finish are removed |

### Power (R1)

Power is written as Garmin's PowerExtension v1 element inside each track point's `<extensions>`:

```xml
<gpx … xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1">
  …
  <trkpt lat="…" lon="…"><time>2026-11-02T07:00:05.000Z</time>
    <extensions><gpxpx:PowerInWatts>212</gpxpx:PowerInWatts></extensions>
  </trkpt>
```

- **Exact placement:** each power sample is written once, on the track point with exactly the
  same time. It is not copied to neighbouring points, interpolated or rounded. Zero watts is
  written as `0`. Missing power stays missing.
- **Samples that can't be written:** a power sample with no track point at its time (for example
  while the GPS had no fix, or inside a pause) is left out of the GPX, because GPX values must sit
  on a positioned point. The portable export keeps it.
- **No power, no namespace:** an activity without power produces the same GPX as before. The
  power namespace is only declared when power is written.
- **Re-import:** PACE's GPX import reads this element, and also Strava-style `<power>`, and
  restores the samples exactly. This is tested: FIT → PACE → GPX → PACE keeps every power sample
  with its time and value.

**Interoperability:** the element and namespace are Garmin's published PowerExtension v1. Whether
a particular third-party app reads power from it has **not** been tested. Some apps read only
Strava's unnamespaced `<power>`, and some ignore power in GPX entirely. Check the app you use.

### Heart rate and cadence (R6)

GPX can hold a sensor value only on a track point. PACE places them like this:

- **One point per sample:** each heart-rate or cadence sample is written on **one** track point,
  the point closest in time, at most **2 s** away. A sample measured exactly at a point's time
  stays at that time.
- **One sample per point:** each point carries at most one value per sensor. When two samples
  compete for a point, the closer one wins.
- **Out of range:** a sample with no free point within 2 s (for example during a long GPS gap) is
  left out of the GPX. The portable export keeps it.
- **Nothing invented:** no value is copied onto other points. Missing data and dropouts stay
  missing.
- **Whole numbers:** values are written as whole numbers, because TrackPointExtension `hr` and
  `cad` hold whole numbers. Fractional cadence (85.5 rpm) becomes 86 rpm. This is a GPX format
  limit.

| Original data | After GPX export and re-import |
|---|---|
| A value at every GPS point (e.g. 1 Hz with 1 Hz GPS) | Identical: same times, same values |
| Sparse values (every 5 s, every 7 s), dropouts, repeated equal values, zeros | Identical: same times and values, no copies, gaps stay gaps |
| Values between GPS timestamps (e.g. GPS every 2 s, heart rate on the odd seconds) | Each value moves to one neighbouring point (≤ 2 s). Values that find no free point are left out. |
| Fractional cadence | Rounded to whole rpm, at the same time |

**Until R6 was fixed** (2026-11-13), the export gave every track point the last sample of the
preceding 5 s. One heart-rate value every 5 s came back as five; a 30 s dropout was partly filled
with copies. GPX files exported by earlier PACE versions still contain those copies, and
importing them stores them.

Tests: `packages/core/src/gpx-sensor-roundtrip.test.ts`.

**Power** keeps the stricter rule approved with R1: it is written only on the point with exactly
its time, never moved (see Power above).

### Triathlons (R3)

A triathlon's GPX contains its whole route and `<type>triathlon</type>`, but not its legs or
transitions: GPX has no way to hold them, and PACE does not use a custom extension for them.

When such a GPX is imported (PACE's own export or any GPX marked triathlon or multisport),
PACE warns:

> This file is marked as a triathlon or multisport activity. GPX cannot hold the swim,
> transition, bike and run legs, so it can only be imported as a single sport. PACE's portable
> export (data.json) keeps the legs.

The athlete then chooses a single sport. Choosing "triathlon" is refused with the reason, because
the legs are missing.

## Portable export (ZIP)

- **`data.json`:** every activity with its metadata, laps, splits, triathlon legs and heart-rate,
  cadence and power series, plus goals, records and the profile.
- **CSV files:** activities, laps, splits and personal records.
- **`activities/*.gpx`:** the GPX described above.
- **Coordinates:** they appear only in the GPX files, with the privacy zone applied.

**Keeping vs re-importing:** `data.json` is the full-fidelity record of your data, but PACE does
not import `data.json` today. Importing the ZIP into PACE reads its GPX files only, with the
limitations above. PACE's own restore path is the encrypted backup.
