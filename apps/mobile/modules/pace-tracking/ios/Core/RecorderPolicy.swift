import CoreLocation
import Foundation

/// Activity-type hint for Core Location, kept platform-neutral so the core compiles on macOS
/// for unit tests. The iOS adapter maps it to `CLActivityType`.
enum ActivityTypeHint: String {
  case fitness
  case otherNavigation = "other_navigation"
  case automotiveNavigation = "automotive_navigation"
  case other
}

/// Recording configuration derived from the shared TypeScript `GpsPolicy`.
struct RecorderPolicy: Equatable {
  let desiredAccuracy: CLLocationAccuracy
  let distanceFilter: CLLocationDistance
  let activityType: ActivityTypeHint

  init(_ dict: [String: Any]) {
    switch dict["desiredAccuracy"] as? String {
    case "best_for_navigation": desiredAccuracy = kCLLocationAccuracyBestForNavigation
    case "ten_meters": desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    default: desiredAccuracy = kCLLocationAccuracyBest
    }
    let filter = (dict["distanceFilterMeters"] as? NSNumber)?.doubleValue ?? 0
    distanceFilter = filter > 0 ? filter : kCLDistanceFilterNone
    activityType = ActivityTypeHint(rawValue: dict["iosActivityType"] as? String ?? "") ?? .fitness
  }
}

/// Converts a `CLLocation` into the shared TypeScript `LocationSample` shape.
///
/// Invalid components (Core Location reports them as negative values) become `NSNull`; nothing
/// is estimated or fabricated. Horizontal accuracy is passed through even when negative so the
/// GPS engine can record *why* the fix was rejected.
enum SampleSerializer {
  static func serialize(_ l: CLLocation) -> [String: Any] {
    var s: [String: Any] = [
      "latitude": l.coordinate.latitude,
      "longitude": l.coordinate.longitude,
      "horizontalAccuracyMeters": l.horizontalAccuracy,
      "recordedAt": Int64((l.timestamp.timeIntervalSince1970 * 1000).rounded()),
      "source": "device_gps",
    ]
    s["altitudeMeters"] = l.verticalAccuracy >= 0 ? l.altitude : NSNull()
    s["verticalAccuracyMeters"] = l.verticalAccuracy >= 0 ? l.verticalAccuracy : NSNull()
    s["speedMps"] = l.speed >= 0 && l.speedAccuracy >= 0 ? l.speed : NSNull()
    s["courseDegrees"] = l.course >= 0 ? l.course : NSNull()
    return s
  }
}
