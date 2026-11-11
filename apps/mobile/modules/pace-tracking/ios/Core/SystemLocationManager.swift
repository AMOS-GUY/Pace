#if os(iOS)
  import CoreLocation
  import Foundation

  /// `CLLocationManager` adapter. Must be created and used on the main thread so delegate
  /// callbacks arrive on the main run loop.
  final class SystemLocationManager: NSObject, LocationManaging, CLLocationManagerDelegate {
    var onLocations: (([CLLocation]) -> Void)?
    var onAuthorizationChange: (() -> Void)?
    var onError: ((Error) -> Void)?

    private let manager = CLLocationManager()
    private var backgroundSession: AnyObject?

    override init() {
      super.init()
      manager.delegate = self
      // Never let iOS pause updates on its own heuristics mid-activity.
      manager.pausesLocationUpdatesAutomatically = false
    }

    var authorization: String {
      switch manager.authorizationStatus {
      case .notDetermined: return "undetermined"
      case .restricted: return "restricted"
      case .denied: return "denied"
      case .authorizedAlways: return "always"
      case .authorizedWhenInUse: return "when_in_use"
      @unknown default: return "undetermined"
      }
    }

    func apply(_ policy: RecorderPolicy) {
      manager.desiredAccuracy = policy.desiredAccuracy
      manager.distanceFilter = policy.distanceFilter
      switch policy.activityType {
      case .fitness: manager.activityType = .fitness
      case .otherNavigation: manager.activityType = .otherNavigation
      case .automotiveNavigation: manager.activityType = .automotiveNavigation
      case .other: manager.activityType = .other
      }
    }

    func startUpdates(background: Bool) {
      // Requires UIBackgroundModes=location (set in app.config.ts); without it this would trap.
      manager.allowsBackgroundLocationUpdates = background
      manager.showsBackgroundLocationIndicator = background
      if #available(iOS 17.0, *) {
        if background && backgroundSession == nil {
          // Keeps the app eligible for background updates with "When In Use" authorization.
          backgroundSession = CLBackgroundActivitySession()
        } else if !background {
          invalidateSession()
        }
      }
      manager.startUpdatingLocation()
    }

    func stopUpdates() {
      manager.stopUpdatingLocation()
      manager.allowsBackgroundLocationUpdates = false
      invalidateSession()
    }

    private func invalidateSession() {
      if #available(iOS 17.0, *) {
        (backgroundSession as? CLBackgroundActivitySession)?.invalidate()
      }
      backgroundSession = nil
    }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    func requestAlways() { manager.requestAlwaysAuthorization() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
      onLocations?(locations)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      onAuthorizationChange?()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
      onError?(error)
    }
  }
#endif
