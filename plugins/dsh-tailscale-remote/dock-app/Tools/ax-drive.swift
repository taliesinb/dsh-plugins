// ax-drive — drive ONE Dock app by pid through the Accessibility API, for
// headless tests of the wrapper's menus (View ▸ Desktop / Mobile, Reload).
// Not part of the app; build ad hoc:
//   xcrun swiftc -O -o /tmp/ax-drive dock-app/Tools/ax-drive.swift
//   PID=$(pgrep -f "DSH Preview.app/Contents/MacOS/DSH")
//   /tmp/ax-drive $PID state                 # window size + Desktop/Mobile check marks
//   /tmp/ax-drive $PID menu View Mobile      # press a menu item
//   /tmp/ax-drive $PID list "DSH Canary"     # items of one top-level menu, with enabled state
//   /tmp/ax-drive $PID resize 1000 700       # AX-resize the first window
//   screencapture -x -o -l$(/tmp/ax-drive $PID windowid) shot.png
// Why pid-keyed: every DSH Dock app's executable is named "DSH", and System
// Events resolves `process "DSH"` (even `whose unix id is …`) to the LIVE app,
// so an osascript `click menu item` may act on the user's real GUI
// (recipes/numbered-session-switching-plugin.md). AXUIElementCreateApplication
// takes the pid and cannot stray. Needs Accessibility trust for the shell that
// runs it (true for an agent shell under danger-full-access).
//
// drive <pid> menu "<Menu>" "<Item>"   — press a menu item of THAT pid via AX
// drive <pid> state                    — window size + View menu mark chars
// drive <pid> resize <w> <h>           — set the first window's size
// drive <pid> windowid                 — CGWindow id of the first layer-0 window (for screencapture -l)
import Cocoa
import ApplicationServices

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[1]) else { print("usage: drive <pid> menu <Menu> <Item> | state"); exit(2) }
let app = AXUIElementCreateApplication(pid)

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func title(_ el: AXUIElement) -> String { (attr(el, kAXTitleAttribute) as? String) ?? "" }

func menuItem(_ menuTitle: String, _ itemTitle: String) -> AXUIElement? {
    guard let bar = attr(app, kAXMenuBarAttribute) else { return nil }
    let barEl = bar as! AXUIElement
    for top in children(barEl) where title(top) == menuTitle {
        for menu in children(top) {
            for item in children(menu) where title(item) == itemTitle { return item }
        }
    }
    return nil
}

func state() {
    if let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], let w = windows.first {
        var sizeValue: AnyObject?
        if AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sizeValue) == .success {
            var size = CGSize.zero
            AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
            print("window \(Int(size.width))x\(Int(size.height)) title=\(title(w))")
        }
    }
    for name in ["Desktop", "Mobile"] {
        let mark = menuItem("View", name).flatMap { attr($0, kAXMenuItemMarkCharAttribute) as? String } ?? ""
        print("\(name): \(mark.isEmpty ? "-" : mark)")
    }
}

switch args[2] {
case "menu":
    guard args.count >= 5, let item = menuItem(args[3], args[4]) else { print("menu item not found"); exit(1) }
    let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
    print("press \(args[3]) > \(args[4]): \(r == .success ? "ok" : "error \(r.rawValue)")")
case "list":
    guard args.count >= 4, let bar = attr(app, kAXMenuBarAttribute) else { print("usage: list <Menu>"); exit(1) }
    for top in children(bar as! AXUIElement) where title(top) == args[3] {
        for menu in children(top) { for item in children(menu) {
            let t = title(item); if t.isEmpty { print("—"); continue }
            let enabled = (attr(item, kAXEnabledAttribute) as? Bool) ?? true
            print("\(enabled ? "  " : "· ")\(t)")
        } }
    }
case "state":
    state()
case "resize":
    guard args.count >= 5, let w = Double(args[3]), let h = Double(args[4]),
          let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], let win = windows.first else { print("no window"); exit(1) }
    var size = CGSize(width: w, height: h)
    let value = AXValueCreate(.cgSize, &size)!
    print("resize: \(AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, value) == .success ? "ok" : "error")")
case "windowid":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        print(w[kCGWindowNumber as String] as? Int ?? 0); break
    }
default:
    print("unknown command"); exit(2)
}
