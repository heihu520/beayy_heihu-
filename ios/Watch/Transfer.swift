import Foundation
import WatchConnectivity

/// 手表 → iPhone：每段录完用 WCSession.transferFile 排队发，系统负责在两边能连上时送达（后台也行）。
/// 每段旁边放一个同名 .json（Segment），送达确认后连同音频一起删；app 重开时把没送走的重新排队。
final class Transfer: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = Transfer()

    @Published private(set) var pending = 0
    @Published private(set) var lastSent: Date?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(url: URL, segment: Segment) {
        let sidecar = url.deletingPathExtension().appendingPathExtension("json")
        try? JSONEncoder().encode(segment).write(to: sidecar, options: .atomic)
        requeue()
    }

    /// 目录里有 .json 的段都该发；已经在系统队列里的跳过。正在录的那段还没有 .json，不会被误发。
    func requeue() {
        let session = WCSession.default
        guard session.activationState == .activated else { refresh(); return }
        let queued = Set(session.outstandingFileTransfers.map { $0.file.fileURL.lastPathComponent })
        let files = (try? FileManager.default.contentsOfDirectory(at: Recorder.dir, includingPropertiesForKeys: nil)) ?? []
        for sidecar in files where sidecar.pathExtension == "json" {
            let audio = sidecar.deletingPathExtension().appendingPathExtension("m4a")
            guard !queued.contains(audio.lastPathComponent),
                  FileManager.default.fileExists(atPath: audio.path),
                  let data = try? Data(contentsOf: sidecar),
                  let seg = try? JSONDecoder().decode(Segment.self, from: data) else { continue }
            session.transferFile(audio, metadata: seg.metadata)
        }
        refresh()
    }

    /// 手表记的停留点：transferUserInfo 排队送到 iPhone（系统保证送达，后台也行），iPhone 收下后反查地名、上传
    func send(visit: Visit) {
        guard WCSession.default.activationState == .activated, let data = try? JSONEncoder().encode(visit) else { return }
        WCSession.default.transferUserInfo(["visit": data])
    }

    /// 告诉 iPhone 手表在不在录（iPhone 首页上显示）
    func sendState(recording: Bool) {
        guard WCSession.default.activationState == .activated else { return }
        try? WCSession.default.updateApplicationContext(["recording": recording, "at": Date().timeIntervalSince1970])
    }

    private func refresh() {
        let n = WCSession.default.activationState == .activated ? WCSession.default.outstandingFileTransfers.count : 0
        DispatchQueue.main.async { self.pending = n }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        requeue()
    }

    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let audio = fileTransfer.file.fileURL
        if error == nil {
            try? FileManager.default.removeItem(at: audio)
            try? FileManager.default.removeItem(at: audio.deletingPathExtension().appendingPathExtension("json"))
            DispatchQueue.main.async { self.lastSent = Date() }
        }
        // 出错的留在目录里，下次 requeue 重发
        refresh()
    }
}
