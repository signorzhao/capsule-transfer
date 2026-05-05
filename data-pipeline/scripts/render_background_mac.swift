import AppKit
import Foundation

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: render_background_mac <REAPER.app> <rpp_path>\n", stderr)
    exit(1)
}

let reaperApp = CommandLine.arguments[1]  // e.g. /Applications/REAPER.app
let rppPath   = CommandLine.arguments[2]

let fm = FileManager.default
let agentApp = "/tmp/ReaperRenderAgent.app"
let agentContents = agentApp + "/Contents"

// --- Build a lightweight agent bundle (symlinks + modified Info.plist) ---
do {
    // Recreate each time to keep symlinks fresh
    if fm.fileExists(atPath: agentApp) {
        try fm.removeItem(atPath: agentApp)
    }
    try fm.createDirectory(atPath: agentContents, withIntermediateDirectories: true)

    let srcContents = reaperApp + "/Contents"
    for entry in (try? fm.contentsOfDirectory(atPath: srcContents)) ?? [] {
        if entry == "Info.plist" { continue }
        let src = srcContents + "/" + entry
        let dst = agentContents + "/" + entry
        try fm.createSymbolicLink(atPath: dst, withDestinationPath: src)
    }

    // Copy & patch Info.plist: set LSUIElement=true so macOS treats it as a background agent
    let plistSrc = srcContents + "/Info.plist"
    let plistDst = agentContents + "/Info.plist"
    guard let plistData = fm.contents(atPath: plistSrc),
          var plist = try PropertyListSerialization.propertyList(
              from: plistData, format: nil) as? [String: Any] else {
        fputs("Cannot read REAPER Info.plist\n", stderr)
        exit(1)
    }
    plist["LSUIElement"] = true
    plist["CFBundleIdentifier"] = "com.cockos.reaper.render-agent"
    let patched = try PropertyListSerialization.data(
        fromPropertyList: plist, format: .xml, options: 0)
    try patched.write(to: URL(fileURLWithPath: plistDst))
} catch {
    fputs("Failed to create agent bundle: \(error)\n", stderr)
    exit(1)
}

// --- Remove code signature so macOS doesn't reject the modified bundle ---
let rmSig = Process()
rmSig.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
rmSig.arguments = ["--remove-signature", agentApp]
rmSig.standardOutput = FileHandle.nullDevice
rmSig.standardError = FileHandle.nullDevice
try? rmSig.run()
rmSig.waitUntilExit()

// --- Launch the render through the agent bundle ---
let ws = NSWorkspace.shared
let frontApp = ws.frontmostApplication

let existingPIDs = Set(
    ws.runningApplications
        .filter { $0.localizedName == "REAPER" }
        .map { $0.processIdentifier }
)

let config = NSWorkspace.OpenConfiguration()
config.activates = false
config.hides = true
config.createsNewApplicationInstance = true
config.arguments = ["-renderproject", rppPath, "-nosplash", "-ignoreerrors", "-close"]

let appURL = URL(fileURLWithPath: agentApp)
let sem = DispatchSemaphore(value: 0)

ws.openApplication(at: appURL, configuration: config) { app, error in
    if let error = error {
        fputs("launch error: \(error.localizedDescription)\n", stderr)
    }
    app?.hide()
    sem.signal()
}

// Keep original app active while waiting for launch
let t0 = Date()
while sem.wait(timeout: .now() + 0.05) == .timedOut {
    if Date().timeIntervalSince(t0) > 15 { break }
    frontApp?.activate()
}

// Safety: hide any new REAPER-like processes for 3 seconds
let guardEnd = Date().addingTimeInterval(3.0)
while Date() < guardEnd {
    for app in ws.runningApplications
        where !existingPIDs.contains(app.processIdentifier)
           && (app.localizedName == "REAPER" || app.bundleIdentifier == "com.cockos.reaper.render-agent") {
        app.hide()
    }
    frontApp?.activate()
    Thread.sleep(forTimeInterval: 0.05)
}

// Wait for the render process to exit
let deadline = Date().addingTimeInterval(180)
while Date() < deadline {
    let currentPIDs = Set(
        ws.runningApplications
            .filter { $0.localizedName == "REAPER" || $0.bundleIdentifier == "com.cockos.reaper.render-agent" }
            .map { $0.processIdentifier }
    )
    if currentPIDs.subtracting(existingPIDs).isEmpty { break }
    Thread.sleep(forTimeInterval: 0.5)
}

// Cleanup
try? fm.removeItem(atPath: agentApp)
print("render done")
