// make-dmg-background — render the disk-image window backdrop for the bundled
// app: a quiet light surface in the DSH style, a faint whale watermark
// bleeding off the right edge, and a thin arrow between the two icon slots.
// The icons themselves are Finder's (the .app and the Applications alias),
// positioned by the layout AppleScript in tools/bundle/build-app.mjs; this
// image only has to leave room for them at the agreed coordinates.
//
//   xcrun swiftc -O -o build/make-dmg-background Tools/make-dmg-background.swift -framework Cocoa
//   build/make-dmg-background icon.svg out.png --glyph-color '#E5484D' --width 660 --height 400 --scale 2
//
// Coordinates (points, top-left origin, in the 660×400 window): app icon
// centred at (180, 190), Applications at (480, 190), arrow between them at
// y = 190, caption at y = 352 (below the 128px icons and their labels). The PNG is written at `scale`× with the DPI
// metadata set so Finder shows it at window size on a Retina display.
import Cocoa

var args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { fputs("usage: make-dmg-background <glyph.svg> <out.png> [--glyph-color #hex] [--width N] [--height N] [--scale N]\n", stderr); exit(2) }
let svgPath = args.removeFirst()
let outPath = args.removeFirst()
var glyphHex = "#E5484D"
var appName = "DSH"
var width: CGFloat = 660, height: CGFloat = 400, scale: CGFloat = 2
while !args.isEmpty {
    switch args.removeFirst() {
    case "--glyph-color": glyphHex = args.removeFirst()
    case "--name": appName = args.removeFirst()
    case "--width": width = CGFloat(Double(args.removeFirst()) ?? 660)
    case "--height": height = CGFloat(Double(args.removeFirst()) ?? 400)
    case "--scale": scale = CGFloat(Double(args.removeFirst()) ?? 2)
    default: break
    }
}

func color(_ hex: String, alpha: CGFloat = 1) -> NSColor {
    var h = hex; if h.hasPrefix("#") { h.removeFirst() }
    let v = UInt32(h, radix: 16) ?? 0
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: alpha)
}

// Whale glyph, recoloured; NSImage rasterises the SVG.
var svg = try! String(contentsOfFile: svgPath, encoding: .utf8)
svg = svg.replacingOccurrences(of: "fill=\"#000\"", with: "fill=\"\(glyphHex)\"").replacingOccurrences(of: "fill=\"#000000\"", with: "fill=\"\(glyphHex)\"")
guard let whale = NSImage(data: svg.data(using: .utf8)!) else { fputs("cannot parse svg\n", stderr); exit(1) }

let pixelW = Int(width * scale), pixelH = Int(height * scale)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelW, pixelsHigh: pixelH, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: width, height: height)   // points → 144 dpi metadata at scale 2
NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
// AppKit's origin is bottom-left; `top(y)` converts a top-left design coordinate.
func top(_ y: CGFloat) -> CGFloat { height - y }

// Surface: the sidebar's near-white, with a barely-there vertical gradient.
NSGradient(starting: color("#F2F2F4"), ending: color("#FAFAFB"))!.draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: 90)

// Watermark: large whale, 7% red, bleeding off the right and bottom.
let wSize: CGFloat = 520
let wRect = NSRect(x: width - wSize * 0.52, y: -wSize * 0.30, width: wSize, height: wSize)
whale.draw(in: wRect, from: .zero, operation: .sourceOver, fraction: 0.06)

// Arrow between the icon slots: thin, grey, rounded caps.
let y = top(190)
let arrow = NSBezierPath()
arrow.lineWidth = 2.5; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 268, y: y)); arrow.line(to: NSPoint(x: 392, y: y))
arrow.move(to: NSPoint(x: 376, y: y - 14)); arrow.line(to: NSPoint(x: 392, y: y)); arrow.line(to: NSPoint(x: 376, y: y + 14))
color("#B4B4BA").setStroke()
arrow.stroke()

// Caption, small and grey, in the system font like the app's status lines.
let caption = "Drag \(appName) to Applications"
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .regular), .foregroundColor: color("#8E8E93")]
let text = NSAttributedString(string: caption, attributes: attrs)
let textSize = text.size()
text.draw(at: NSPoint(x: (width - textSize.width) / 2, y: top(352) - textSize.height / 2))

NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) \(pixelW)x\(pixelH)")
