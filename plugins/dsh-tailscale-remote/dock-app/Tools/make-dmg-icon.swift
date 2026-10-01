// make-dmg-icon — the disk-image icon: the system's disk-image drive with the
// app's icon on its face, written as .icns. build-app.mjs uses it twice: as the
// volume's .VolumeIcon.icns and embedded into the .dmg file with `hdiutil
// udifrez` (inside the file bytes, so it survives downloads).
//
//   xcrun swiftc -O -o build/make-dmg-icon Tools/make-dmg-icon.swift -framework Cocoa
//   build/make-dmg-icon render <AppIcon.icns> <out.icns>
//
// The drive is macOS's own disk-image icon, captured from a throwaway mounted
// image at render time so it matches whatever the running OS draws; the app
// tile sits over its face.
import Cocoa

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 3 else { fputs("usage: make-dmg-icon render <app.icns> <out.icns>\n", stderr); exit(2) }

func icnsData(from image: NSImage) -> Data {
    // iconutil needs an iconset directory; build one in a temp dir at the standard sizes.
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dmg-icon-\(ProcessInfo.processInfo.processIdentifier).iconset")
    try? FileManager.default.removeItem(at: dir)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        try! rep.representation(using: .png, properties: [:])!.write(to: dir.appendingPathComponent("\(name).png"))
    }
    let out = dir.deletingPathExtension().appendingPathExtension("icns")
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil"); p.arguments = ["-c", "icns", dir.path, "-o", out.path]
    try! p.run(); p.waitUntilExit()
    let data = try! Data(contentsOf: out)
    try? FileManager.default.removeItem(at: dir); try? FileManager.default.removeItem(at: out)
    return data
}

switch args[0] {
case "render":
    guard let app = NSImage(contentsOfFile: args[1]) else { fputs("cannot read \(args[1])\n", stderr); exit(1) }
    // The system's own disk-image drive (the white slab with the download arrow),
    // obtained the one way macOS 26 still gives it out: as the Finder icon of a
    // mounted plain image (UTType.diskImage, the kGeneric*Icon type codes and
    // CoreTypes' loose .icns all return placeholders; the artwork lives in asset
    // catalogs). A throwaway 1 MB image is created, mounted, asked, unmounted.
    func systemDiskIcon() -> NSImage? {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dmg-icon-probe-\(ProcessInfo.processInfo.processIdentifier)")
        let volume = "dmg-icon-probe"
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: tmp.appendingPathComponent("x").path, contents: Data())
        let dmg = tmp.appendingPathExtension("dmg")
        func hdiutil(_ a: [String]) -> Int32 { let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil"); p.arguments = a; p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice; try? p.run(); p.waitUntilExit(); return p.terminationStatus }
        defer { try? FileManager.default.removeItem(at: tmp); try? FileManager.default.removeItem(at: dmg) }
        guard hdiutil(["create", "-volname", volume, "-srcfolder", tmp.path, "-ov", "-format", "UDRO", "-fs", "APFS", dmg.path]) == 0,
              hdiutil(["attach", "-nobrowse", "-readonly", "-quiet", dmg.path]) == 0 else { return nil }
        defer { _ = hdiutil(["detach", "/Volumes/" + volume, "-quiet"]) }
        let icon = NSWorkspace.shared.icon(forFile: "/Volumes/" + volume)
        // Take the largest representation into an image of our own so it survives the unmount.
        let copy = NSImage(size: NSSize(width: 1024, height: 1024))
        copy.lockFocus(); NSGraphicsContext.current?.imageInterpolation = .high
        icon.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024), from: .zero, operation: .sourceOver, fraction: 1)
        copy.unlockFocus()
        return copy
    }
    guard let drive = systemDiskIcon() else { fputs("could not obtain the system disk-image icon\n", stderr); exit(1) }
    let size: CGFloat = 1024
    let canvas = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        NSGraphicsContext.current?.imageInterpolation = .high
        drive.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
        // App tile over the drive's face (covers the baked-in arrow): 44 % wide,
        // centred on the face, which in this artwork sits slightly above the middle.
        let side = size * 0.44
        let badge = NSRect(x: (size - side) / 2, y: size * 0.33, width: side, height: side)
        let shadow = NSShadow(); shadow.shadowBlurRadius = size * 0.015; shadow.shadowOffset = NSSize(width: 0, height: -size * 0.006); shadow.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.25)
        NSGraphicsContext.saveGraphicsState(); shadow.set()
        app.draw(in: badge, from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return true
    }
    try! icnsData(from: canvas).write(to: URL(fileURLWithPath: args[2]))
    print("wrote \(args[2])")
default:
    fputs("unknown mode \(args[0])\n", stderr); exit(2)
}
