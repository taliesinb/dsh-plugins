// make-icon — render an SVG glyph onto a macOS-style rounded tile and write an
// .iconset directory (every size iconutil wants). Run by dock-app/build.mjs:
//
//   swiftc -o build/make-icon Tools/make-icon.swift -framework Cocoa
//   build/make-icon <glyph.svg> <out.iconset> [--glyph-color #000] [--tile-color #fff]
//
// Geometry follows Apple's Big Sur template: the tile fills 82.4 % of the
// canvas (a 1024 canvas → 824 tile) with a 22.4 % corner radius; the glyph is
// centred at 60 % of the tile.
import Cocoa

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func color(_ hex: String) -> NSColor {
    var text = hex.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("#") { text.removeFirst() }
    if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else { fail("bad color \(hex)") }
    return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

var args = Array(CommandLine.arguments.dropFirst())
var glyphColor = "#000000"
var tileColor = "#ffffff"
var positional: [String] = []
while !args.isEmpty {
    let arg = args.removeFirst()
    switch arg {
    case "--glyph-color": glyphColor = args.isEmpty ? glyphColor : args.removeFirst()
    case "--tile-color": tileColor = args.isEmpty ? tileColor : args.removeFirst()
    default: positional.append(arg)
    }
}
guard positional.count == 2 else { fail("usage: make-icon <glyph.svg> <out.iconset> [--glyph-color #hex] [--tile-color #hex]") }
let svgPath = positional[0]
let outDir = positional[1]

guard var svg = try? String(contentsOfFile: svgPath, encoding: .utf8) else { fail("cannot read \(svgPath)") }
// Force the glyph colour: drop the dark-mode style block and rewrite the path fill.
svg = svg.replacingOccurrences(of: "<style>[\\s\\S]*?</style>", with: "", options: .regularExpression)
svg = svg.replacingOccurrences(of: "fill=\"#000\"", with: "fill=\"\(glyphColor)\"")
svg = svg.replacingOccurrences(of: "fill=\"#000000\"", with: "fill=\"\(glyphColor)\"")
guard let glyph = NSImage(data: svg.data(using: .utf8)!) else { fail("NSImage could not decode the SVG") }

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(canvas: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: canvas, height: canvas)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let size = CGFloat(canvas)
    let tile = size * 0.824
    let tileRect = NSRect(x: (size - tile) / 2, y: (size - tile) / 2, width: tile, height: tile)
    let path = NSBezierPath(roundedRect: tileRect, xRadius: tile * 0.224, yRadius: tile * 0.224)
    // Soft shadow like the system tiles.
    let shadow = NSShadow()
    shadow.shadowBlurRadius = size * 0.012
    shadow.shadowOffset = NSSize(width: 0, height: -size * 0.006)
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
    shadow.set()
    color(tileColor).setFill()
    path.fill()
    NSShadow().set()
    let glyphSide = tile * 0.60
    let glyphRect = NSRect(x: (size - glyphSide) / 2, y: (size - glyphSide) / 2, width: glyphSide, height: glyphSide)
    NSGraphicsContext.current?.imageInterpolation = .high
    glyph.draw(in: glyphRect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let sizes: [(name: String, pixels: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for entry in sizes {
    let rep = render(canvas: entry.pixels)
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("png encode failed") }
    let path = (outDir as NSString).appendingPathComponent(entry.name + ".png")
    do { try png.write(to: URL(fileURLWithPath: path)) } catch { fail("write \(path): \(error)") }
}
print("wrote \(sizes.count) images to \(outDir)")
