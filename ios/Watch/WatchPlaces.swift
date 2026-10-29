import CoreLocation
import Foundation

/// 手表的位置：watchOS 没有到访（CLVisit）、显著位置变化和地理围栏，只能自己取点。
/// 录音开着时 app 一直醒着，每 3 分钟（和每换一段录音时）取一个点，用 StayDetector 判停留（和 iPhone 同一套规则），
/// 记下的停留经 WatchConnectivity 送到 iPhone，由 iPhone 反查地名、上传。不录音时不取点，不耗电。
final class WatchPlaces: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = WatchPlaces()
    static let every: TimeInterval = 180

    @Published private(set) var auth: CLAuthorizationStatus = .notDetermined
    @Published private(set) var lastFix: Date?
    @Published private(set) var stayed: TimeInterval?
    @Published private(set) var today = 0
    private let manager = CLLocationManager()
    private var timer: Timer?
    private var detector: StayDetector {
        get { UserDefaults.standard.data(forKey: "stayDetector").flatMap { try? JSONDecoder().decode(StayDetector.self, from: $0) } ?? StayDetector() }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "stayDetector") }
    }

    func start() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        auth = manager.authorizationStatus
        let d = UserDefaults.standard
        if let t = d.object(forKey: "watchStaysDay") as? Date, Calendar.current.isDateInToday(t) { today = d.integer(forKey: "watchStaysToday") }
        stayed = detector.stayed
    }

    var ready: Bool { auth == .authorizedWhenInUse || auth == .authorizedAlways }

    func requestPermission() { manager.requestWhenInUseAuthorization() }

    /// 录音开始／停止时调
    func setActive(_ on: Bool) {
        timer?.invalidate()
        timer = nil
        guard on else {
            var d = detector
            d.flush(device: "watch").forEach(emit)
            detector = d
            stayed = nil
            return
        }
        guard ready else { return }
        manager.allowsBackgroundLocationUpdates = true
        sample()
        timer = Timer.scheduledTimer(withTimeInterval: Self.every, repeats: true) { [weak self] _ in self?.sample() }
    }

    func sample() {
        guard ready else { return }
        manager.requestLocation()
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        DispatchQueue.main.async { self.auth = m.authorizationStatus }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let loc = locs.last else { return }
        var d = detector
        let out = d.feed(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, acc: loc.horizontalAccuracy,
                         at: loc.timestamp, device: "watch")
        detector = d
        out.forEach(emit)
        DispatchQueue.main.async {
            self.lastFix = loc.timestamp
            self.stayed = d.stayed
        }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}

    private func emit(_ v: Visit) {
        Transfer.shared.send(visit: v)
        guard v.depart == nil else { return }  // 新的一处（还没走）才算一个
        let d = UserDefaults.standard
        let n = (d.object(forKey: "watchStaysDay") as? Date).map(Calendar.current.isDateInToday) == true ? d.integer(forKey: "watchStaysToday") + 1 : 1
        d.set(Date(), forKey: "watchStaysDay")
        d.set(n, forKey: "watchStaysToday")
        DispatchQueue.main.async { self.today = n }
    }
}
