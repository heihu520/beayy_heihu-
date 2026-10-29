import Foundation

/// 录的一段音频的元数据：手表录的随 WatchConnectivity 文件一起传到 iPhone；iPhone 上传时写进块的第一行。
struct Segment: Codable, Equatable {
    var id: String        // watch-20261016T014500Z（开始时刻，UTC）
    var start: Date
    var end: Date
    var device: String
    var battery: Double?  // 段结束时手表电量 0–1

    static func makeID(start: Date, device: String = "watch") -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return "\(device)-\(f.string(from: start))"
    }

    var metadata: [String: Any] {
        var m: [String: Any] = ["id": id, "start": start.timeIntervalSince1970, "end": end.timeIntervalSince1970,
                                "device": device]
        if let battery { m["battery"] = battery }
        return m
    }

    init(id: String, start: Date, end: Date, device: String, battery: Double?) {
        self.id = id; self.start = start; self.end = end; self.device = device; self.battery = battery
    }

    init?(metadata m: [String: Any]) {
        guard let id = m["id"] as? String, let s = m["start"] as? Double, let e = m["end"] as? Double else { return nil }
        self.init(id: id, start: Date(timeIntervalSince1970: s), end: Date(timeIntervalSince1970: e),
                  device: m["device"] as? String ?? "watch", battery: m["battery"] as? Double)
    }
}

extension Date {
    var iso8601UTC: String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: self)
    }
}
