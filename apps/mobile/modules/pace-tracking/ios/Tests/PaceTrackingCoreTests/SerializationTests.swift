import CoreLocation
import Foundation
import XCTest
@testable import PaceTrackingCore

final class SerializationTests: XCTestCase {
  private func location(verticalAccuracy: Double = 3, speed: Double = 3, speedAccuracy: Double = 0.5, course: Double = 90,
                        horizontalAccuracy: Double = 5, timestamp: TimeInterval = 1_780_000_000.4567) -> CLLocation {
    CLLocation(
      coordinate: CLLocationCoordinate2D(latitude: 47.1, longitude: 8.5),
      altitude: 412.5,
      horizontalAccuracy: horizontalAccuracy,
      verticalAccuracy: verticalAccuracy,
      course: course,
      courseAccuracy: 5,
      speed: speed,
      speedAccuracy: speedAccuracy,
      timestamp: Date(timeIntervalSince1970: timestamp))
  }

  func testValidFixIsSerialisedWithMillisecondTimestamp() {
    let s = SampleSerializer.serialize(location())
    XCTAssertEqual(s["latitude"] as? Double, 47.1)
    XCTAssertEqual(s["altitudeMeters"] as? Double, 412.5)
    XCTAssertEqual(s["speedMps"] as? Double, 3)
    XCTAssertEqual(s["recordedAt"] as? Int64, 1_780_000_000_457)
    XCTAssertEqual(s["source"] as? String, "device_gps")
    XCTAssertTrue(JSONSerialization.isValidJSONObject(s))
  }

  func testInvalidComponentsBecomeNullNotGuesses() {
    let s = SampleSerializer.serialize(location(verticalAccuracy: -1, speed: -1, course: -1))
    XCTAssertTrue(s["altitudeMeters"] is NSNull)
    XCTAssertTrue(s["verticalAccuracyMeters"] is NSNull)
    XCTAssertTrue(s["speedMps"] is NSNull)
    XCTAssertTrue(s["courseDegrees"] is NSNull)
  }

  func testSpeedWithInvalidAccuracyIsDropped() {
    XCTAssertTrue(SampleSerializer.serialize(location(speedAccuracy: -1))["speedMps"] is NSNull)
  }

  func testNegativeHorizontalAccuracyIsPassedThroughForTheEngineToReject() {
    XCTAssertEqual(SampleSerializer.serialize(location(horizontalAccuracy: -1))["horizontalAccuracyMeters"] as? Double, -1)
  }

  func testPolicyMapping() {
    let ride = RecorderPolicy(["desiredAccuracy": "best_for_navigation", "distanceFilterMeters": 0, "iosActivityType": "other_navigation"])
    XCTAssertEqual(ride.desiredAccuracy, kCLLocationAccuracyBestForNavigation)
    XCTAssertEqual(ride.distanceFilter, kCLDistanceFilterNone)
    XCTAssertEqual(ride.activityType, .otherNavigation)
    let hike = RecorderPolicy(["desiredAccuracy": "best", "distanceFilterMeters": 2, "iosActivityType": "fitness"])
    XCTAssertEqual(hike.distanceFilter, 2)
    XCTAssertEqual(RecorderPolicy([:]).activityType, .fitness)
    XCTAssertEqual(RecorderPolicy([:]).desiredAccuracy, kCLLocationAccuracyBest)
  }
}
