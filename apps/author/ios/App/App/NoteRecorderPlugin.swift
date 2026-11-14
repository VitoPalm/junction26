import Foundation
import Capacitor
import AVFoundation
import Speech
import CryptoKit

@objc(NoteRecorderPlugin)
public class NoteRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NoteRecorderPlugin"
    public let jsName = "NoteRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flush", returnType: CAPPluginReturnPromise)
    ]
    private let recorder = NativeNoteRecorder.shared
    public override func load() {
        recorder.changed = { [weak self] state in DispatchQueue.main.async { self?.notifyListeners("state", data: state) } }
    }
    @objc func start(_ call: CAPPluginCall) {
        guard let server = call.getString("server"), let url = URL(string: server),
              url.scheme == "https" || (url.scheme == "http" && url.host == "localhost"),
              let token = call.getString("token"), let owner = call.getString("ownerId"),
              UUID(uuidString: owner) != nil, let expiry = call.getString("expiresAt") else { call.reject("Invalid recorder configuration"); return }
        let mode = call.getString("liveMode") ?? "auto"
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] allowed in
            guard let self = self else { return }
            guard allowed else { call.reject("Allow microphone access to record notes"); return }
            let enable = {
                self.recorder.queue.async {
                    do { try self.recorder.enable(server: server, token: token, owner: owner, expiry: expiry, mode: mode); call.resolve() }
                    catch { self.recorder.disable(); call.reject("Could not start audio: \(error.localizedDescription)") }
                }
            }
            if mode == "auto" || mode == "device" { SFSpeechRecognizer.requestAuthorization { _ in enable() } }
            else { enable() }
        }
    }
    @objc func stop(_ call: CAPPluginCall) { recorder.queue.async { self.recorder.disable(); call.resolve() } }
    @objc func status(_ call: CAPPluginCall) { recorder.queue.async { call.resolve(self.recorder.state()) } }
    @objc func setMode(_ call: CAPPluginCall) { recorder.queue.async { self.recorder.mode = call.getString("liveMode") ?? "auto"; self.recorder.publish(); call.resolve() } }
    @objc func flush(_ call: CAPPluginCall) { recorder.queue.async { self.recorder.flush(); call.resolve() } }
}

/** Audio session, event transport and disk queue live outside the suspended WKWebView. */
private final class NativeNoteRecorder: NSObject, URLSessionDataDelegate {
    static let shared = NativeNoteRecorder()
    let queue = DispatchQueue(label: "applets.notes")
    var changed: (([String: Any]) -> Void)?
    var mode = "auto"
    private var phase = "off", connected = false, enabled = false
    private var detector: String?, message: String?, micLabel: String?
    private var server = "", token = "", expires = Date.distantPast
    private var directory: URL?, note: [String: Any]?, lastSaved: [String: Any]?
    private var started = Date(), pcm: FileHandle?, pcmURL: URL?, pcmBytes = 0
    private let engine = AVAudioEngine()
    private let speechLock = NSLock()
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var ring = Data(), lastHeard = Date(), lastCheck = Date.distantPast
    private var liveBusy = false, uploading = false, timer: DispatchSourceTimer?
    private var eventSession: URLSession?, eventTask: URLSessionDataTask?, eventBuffer = Data()
    private var generation = 0
    private var observers: [NSObjectProtocol] = []
    private var tapInstalled = false

    func state() -> [String: Any] {
        let count = (try? FileManager.default.contentsOfDirectory(at: directory ?? URL(fileURLWithPath: "/nonexistent"), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.count) ?? 0
        return ["phase": phase, "connected": connected, "liveMode": mode,
                "detector": detector as Any? ?? NSNull(), "note": note as Any? ?? NSNull(),
                "message": message as Any? ?? NSNull(), "micLabel": micLabel as Any? ?? NSNull(),
                "pending": count, "lastSaved": lastSaved as Any? ?? NSNull()]
    }
    func publish() { changed?(state()) }
    func enable(server: String, token: String, owner: String, expiry: String, mode: String) throws {
        if enabled { return }
        let dateFormat = ISO8601DateFormatter(); dateFormat.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let end = dateFormat.date(from: expiry), end > Date() else { throw NSError(domain: "Recorder", code: 1) }
        self.server = server; self.token = token; self.expires = end; self.mode = mode
        let hash = SHA256.hash(data: Data(server.utf8)).map { String(format: "%02x", $0) }.joined()
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        directory = base.appendingPathComponent("VoiceNotes/\(hash)/\(owner)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory!, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory!.setResourceValues(values)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        try session.setPreferredSampleRate(16000)
        try session.setActive(true)
        if let bluetooth = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) { try session.setPreferredInput(bluetooth) }
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else { throw NSError(domain: "RecorderAudio", code: 1) }
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.speechLock.lock(); self.speechRequest?.append(buffer); self.speechLock.unlock()
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / inputFormat.sampleRate) + 32)
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
            var supplied = false, conversionError: NSError?
            converter.convert(to: output, error: &conversionError) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return buffer
            }
            guard conversionError == nil, let samples = output.floatChannelData?[0] else { return }
            var data = Data(capacity: Int(output.frameLength) * 2)
            for i in 0..<Int(output.frameLength) {
                let sample = Int16(max(-32768, min(32767, Int(samples[i] * 32767))))
                data.append(UInt8(truncatingIfNeeded: sample)); data.append(UInt8(truncatingIfNeeded: sample >> 8))
            }
            self.queue.async { self.receive(data) }
        }
        tapInstalled = true
        engine.prepare(); try engine.start()
        enabled = true; phase = "ready"; generation += 1; message = nil
        micLabel = session.currentRoute.inputs.first?.portName ?? "Phone microphone"
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] _ in
            self?.queue.async { self?.interrupt("A call or audio interruption stopped the recorder. Turn it on again.") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self?.queue.async { self?.interrupt("Audio device disconnected. Check the route and turn the recorder on again.") }
            }
        })
        recover(); listen()
        let tick = DispatchSource.makeTimerSource(queue: queue); timer = tick
        tick.schedule(deadline: .now() + 1, repeating: 1)
        tick.setEventHandler { [weak self] in self?.tick() }; tick.resume()
        flush(); publish()
    }
    func disable() {
        enabled = false; generation += 1
        finish(reason: "interrupted")
        timer?.cancel(); timer = nil
        eventTask?.cancel(); eventTask = nil; eventSession?.invalidateAndCancel(); eventSession = nil
        stopRecognition(); engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers = []
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        connected = false; phase = "off"; ring.removeAll(); publish()
    }
    private func interrupt(_ text: String) { disable(); message = text; phase = "error"; publish() }
    private func receive(_ data: Data) {
        guard enabled else { return }
        if note != nil {
            do { try pcm?.write(contentsOf: data); pcmBytes += data.count }
            catch { interrupt("Recording could not be written. Free some storage and try again.") }
        } else { ring.append(data); if ring.count > 9600 { ring.removeFirst(ring.count - 9600) } }
    }
    private func tick() {
        guard enabled else { return }
        if Date() >= expires { interrupt("Recorder session ended. Turn it on again to renew it."); return }
        if let note = note {
            if Date().timeIntervalSince(started) >= Double(note["maxSeconds"] as? Int ?? 300) { finish(reason: "timeout"); return }
            if detector == "device" && Date().timeIntervalSince(lastHeard) > 6 { fallback() }
            if detector == "cloud" { cloudCheck() }
        }
        if Int(Date().timeIntervalSince1970) % 15 == 0 { flush() }
    }
    private func request(_ path: String, method: String = "POST", body: Data? = nil, completion: @escaping (Int, Data?) -> Void) {
        guard let url = URL(string: server + path) else { completion(0, nil); return }
        var req = URLRequest(url: url); req.httpMethod = method; req.timeoutInterval = 30
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body = body { req.httpBody = body; req.setValue(path.contains("/audio?") || path.hasSuffix("/live") ? "audio/wav" : "application/json", forHTTPHeaderField: "Content-Type") }
        // A private delegate refuses redirects, so credentials never follow an unexpected origin.
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        session.dataTask(with: req) { [weak self] data, res, _ in
            self?.queue.async { completion((res as? HTTPURLResponse)?.statusCode ?? 0, data) }
            session.finishTasksAndInvalidate()
        }.resume()
    }
    private func listen() {
        guard enabled, let url = URL(string: server + "/v1/notes/recorder/events") else { return }
        eventBuffer.removeAll()
        var request = URLRequest(url: url); request.timeoutInterval = 60 * 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 45; config.timeoutIntervalForResource = 12 * 60 * 60
        eventSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        eventTask = eventSession?.dataTask(with: request); eventTask?.resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else { completionHandler(.cancel); return }
        queue.async { if dataTask === self.eventTask { self.connected = true; self.publish() } }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        queue.async {
            guard dataTask === self.eventTask else { return }
            self.eventBuffer.append(data)
            while let range = self.eventBuffer.range(of: Data("\n\n".utf8)) {
                let bytes = self.eventBuffer.subdata(in: 0..<range.lowerBound); self.eventBuffer.removeSubrange(0..<range.upperBound)
                let lines = String(decoding: bytes, as: UTF8.self).components(separatedBy: "\n")
                let kind = lines.first(where: { $0.hasPrefix("event: ") }).map { String($0.dropFirst(7)) }
                guard let text = lines.first(where: { $0.hasPrefix("data: ") }),
                      let object = try? JSONSerialization.jsonObject(with: Data(text.dropFirst(6).utf8)) as? [String: Any] else { continue }
                if kind == "start", let note = object["note"] as? [String: Any] { self.begin(note) }
                if kind == "stop", let id = object["noteId"] as? String, id == self.note?["id"] as? String { self.finish(reason: object["reason"] as? String ?? "band") }
            }
            if self.eventBuffer.count > 256_000 { self.eventTask?.cancel() }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        queue.async {
            guard task === self.eventTask else { return }
            self.connected = false; self.publish(); self.eventTask = nil
            session.finishTasksAndInvalidate()
            let current = self.generation
            self.queue.asyncAfter(deadline: .now() + 2) { if self.enabled && current == self.generation { self.listen() } }
        }
    }
    private func begin(_ incoming: [String: Any]) {
        guard enabled, note == nil, let id = incoming["id"] as? String, UUID(uuidString: id) != nil, let directory = directory else { return }
        if FileManager.default.fileExists(atPath: directory.appendingPathComponent(id + ".wav").path) { return }
        do {
            started = Date(); var current = incoming; current["startedAt"] = started.timeIntervalSince1970 * 1000; current["endReason"] = "interrupted"
            pcmURL = directory.appendingPathComponent(id + ".pcm")
            FileManager.default.createFile(atPath: pcmURL!.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            pcm = try FileHandle(forWritingTo: pcmURL!); try pcm?.write(contentsOf: ring); pcmBytes = ring.count; ring.removeAll()
            try writeMetadata(current, id: id); note = current; phase = "recording"
            detector = mode == "off" ? "off" : mode == "cloud" ? "cloud" : "device"
            if detector == "device" { startRecognition() }
            lastHeard = Date(); publish()
            request("/v1/notes/\(id)/recording") { _, _ in }
        } catch { try? pcm?.close(); pcm = nil; note = nil; phase = "ready"; message = "Could not create a recording on this phone."; publish() }
    }
    private func startRecognition() {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized, let recognizer = recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { fallback(); return }
        let request = SFSpeechAudioBufferRecognitionRequest(); request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true; request.contextualStrings = ["stop recording meta"]
        speechLock.lock(); speechRequest = request; speechLock.unlock()
        speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.queue.async {
                guard let self = self, self.note != nil, self.speechRequest === request else { return }
                if let result = result {
                    self.lastHeard = Date()
                    if NotePCM.stopPhrase(result.bestTranscription.formattedString) { self.finish(reason: "phrase"); return }
                    if result.isFinal { self.stopRecognition(); self.startRecognition(); return }
                }
                if error != nil { self.fallback() }
            }
        }
    }
    private func stopRecognition() {
        speechLock.lock(); let request = speechRequest; speechRequest = nil; speechLock.unlock()
        request?.endAudio(); speechTask?.cancel(); speechTask = nil
    }
    private func fallback() { guard note != nil else { return }; stopRecognition(); detector = "cloud"; publish() }
    private func cloudCheck() {
        guard !liveBusy, Date().timeIntervalSince(lastCheck) > 2, let url = pcmURL, let id = note?["id"] as? String,
              let file = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? file.close() }
        let offset = max(0, pcmBytes - 160000)
        try? file.seek(toOffset: UInt64(offset))
        guard let tail = try? file.read(upToCount: 160000), tail.count >= 48000, NotePCM.speech(tail),
              NotePCM.rms(tail.suffix(9600)) < 0.01 else { return }
        lastCheck = Date(); liveBusy = true
        request("/v1/notes/\(id)/live", body: NotePCM.wav(tail)) { status, data in
            self.liveBusy = false
            guard status == 200, id == self.note?["id"] as? String, let data = data,
                  let r = try? JSONSerialization.jsonObject(with: data) as? [String: Any], r["stop"] as? Bool == true else { return }
            let cut = (r["startSeconds"] as? Double).map { max(0, offset + Int(($0 - 0.15) * 32000)) }
            self.finish(reason: "phrase", exactCut: cut)
        }
    }
    private func writeMetadata(_ object: [String: Any], id: String) throws {
        guard let directory = directory else { return }
        try JSONSerialization.data(withJSONObject: object).write(to: directory.appendingPathComponent(id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func finish(reason: String, exactCut: Int? = nil) {
        guard var current = note, let id = current["id"] as? String, let file = pcmURL, let directory = directory else { return }
        phase = "saving"; stopRecognition(); try? pcm?.synchronize(); try? pcm?.close(); pcm = nil; note = nil; detector = nil
        do {
            var bytes = try Data(contentsOf: file)
            if reason == "phrase" { bytes = NotePCM.trim(bytes, exactCut: exactCut) }
            if NotePCM.speech(bytes) {
                try NotePCM.wav(bytes).write(to: directory.appendingPathComponent(id + ".wav"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                current["durationMs"] = bytes.count / 32; current["endReason"] = reason; try writeMetadata(current, id: id)
            } else {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(id + ".json"))
                request("/v1/notes/\(id)/discard", body: Data("{\"reason\":\"too_short\"}".utf8)) { _, _ in }
                message = "Too short, nothing saved."
            }
            try FileManager.default.removeItem(at: file)
        } catch { message = "Recording kept on this phone; reopen to recover it." }
        pcmURL = nil; pcmBytes = 0; phase = enabled ? "ready" : "off"; publish(); flush()
    }
    private func recover() {
        guard let directory = directory, let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "pcm" {
            let id = file.deletingPathExtension().lastPathComponent
            do {
                let meta = directory.appendingPathComponent(id + ".json")
                guard var object = try JSONSerialization.jsonObject(with: Data(contentsOf: meta)) as? [String: Any] else { continue }
                let bytes = try Data(contentsOf: file); object["durationMs"] = bytes.count / 32; object["endReason"] = "interrupted"
                try NotePCM.wav(bytes).write(to: directory.appendingPathComponent(id + ".wav"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                try writeMetadata(object, id: id); try FileManager.default.removeItem(at: file)
            } catch { message = "A local recording could not be recovered." }
        }
    }
    func flush() {
        guard !uploading, Date() < expires, let directory = directory,
              let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for meta in files where meta.pathExtension == "json" {
            guard let data = try? Data(contentsOf: meta), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = object["id"] as? String else { continue }
            let audio = directory.appendingPathComponent(id + ".wav")
            guard let bytes = try? Data(contentsOf: audio) else { continue }
            uploading = true
            let reason = object["endReason"] as? String ?? "interrupted", ms = object["durationMs"] as? Int ?? 0
            request("/v1/notes/\(id)/audio?durationMs=\(ms)&endReason=\(reason)", method: "PUT", body: bytes) { status, data in
                self.uploading = false
                let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let confirmation = ((result?["note"] as? [String: Any])?["audio"] as? [String: Any])?["sha256"] as? String
                let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                if (200..<300).contains(status) && confirmation == hash {
                    try? FileManager.default.removeItem(at: audio); try? FileManager.default.removeItem(at: meta)
                    self.lastSaved = ["pageLabel": object["pageLabel"] ?? "Note", "at": Date().timeIntervalSince1970 * 1000]; self.message = nil
                    self.flush()
                } else { self.message = "Saved on this phone; uploading when online…" }
                self.publish()
            }
            break
        }
    }
}

private enum NotePCM {
    static func stopPhrase(_ text: String) -> Bool {
        text.range(of: #"\bstop(?:ped|ping)?\s+(?:the\s+)?recording[\s,.]*(?:meta|metta|metal|medal|matter|better|media|mehta|met a|mesa|mena)[\s.!?]*$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
    static func wav(_ bytes: Data) -> Data {
        var out = Data()
        func string(_ value: String) { out.append(Data(value.utf8)) }
        func u16(_ value: UInt16) { var n = value.littleEndian; withUnsafeBytes(of: &n) { out.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var n = value.littleEndian; withUnsafeBytes(of: &n) { out.append(contentsOf: $0) } }
        string("RIFF"); u32(UInt32(36 + bytes.count)); string("WAVEfmt "); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16); string("data"); u32(UInt32(bytes.count)); out.append(bytes); return out
    }
    static func rms(_ bytes: Data) -> Double {
        let b = Array(bytes); var total = 0.0
        if b.count < 2 { return 0 }
        for i in stride(from: 0, to: b.count - 1, by: 2) { let s = Double(Int16(bitPattern: UInt16(b[i]) | UInt16(b[i+1]) << 8)) / 32768; total += s*s }
        return sqrt(total / Double(b.count/2))
    }
    static func speech(_ bytes: Data) -> Bool {
        var loud = 0
        for i in stride(from: 0, to: max(0, bytes.count - 639), by: 640) { if rms(bytes.subdata(in: i..<i+640)) > 0.012 { loud += 1 } }
        return loud >= 30
    }
    static func trim(_ bytes: Data, exactCut: Int?) -> Data {
        if let cut = exactCut { return Data(bytes.prefix(min(bytes.count, max(0, cut & ~1)))) }
        var f = bytes.count / 640 - 1; let minFrame = max(0, f - 175); var run = 0
        func quiet(_ i: Int) -> Bool { rms(bytes.subdata(in: i*640..<(i+1)*640)) < 0.008 }
        while f > minFrame && quiet(f) { f -= 1 }
        while f > minFrame {
            if quiet(f) { run += 1; if run >= 10 { return Data(bytes.prefix((f + run/2)*640)) } }
            else { run = 0 }
            f -= 1
        }
        return Data(bytes.prefix(max(0, bytes.count - 51200)))
    }
}
