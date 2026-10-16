// 从 品牌/标志_*.svg 生成 app 图标（AppIcon.iconset → AppIcon.icns）和菜单栏模板图。
// 用法：swiftc -O app/tools/make_icons.swift -o /tmp/make_icons && /tmp/make_icons <标志.svg> <输出目录 app/Resources>
// 规格写在 app/README.md「图标」一节，改参数先改那里。

import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    print("用法：make_icons <标志.svg> <输出目录>"); exit(1)
}
let outDir = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// ---- 参数（以 1024 画布计） ----
let bodyInset: CGFloat = 100          // macOS 图标网格：824 的圆角方块居中，四周 100
let bodySize: CGFloat = 824
let cornerRatio: CGFloat = 0.2237     // 圆角半径 / 方块边长（约 184），接近系统图标的圆角
let logoRatio: CGFloat = 0.56         // 标志外接框长边 / 方块边长：四周留约 22% 边距
/// 小尺寸放大标志、收窄边距，否则 16 像素下标志只剩 5 像素高
func logoRatio(forPixels px: CGFloat) -> CGFloat { px <= 32 ? 0.74 : (px <= 64 ? 0.64 : logoRatio) }
let bg = NSColor(srgbRed: 0xFC / 255, green: 0xFC / 255, blue: 0xFB / 255, alpha: 1)    // 墨线 page 浅色 #fcfcfb
let edge = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.08)                         // 白底在浅色桌面上需要一道细边
let ink = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0B / 255, alpha: 1)  // 墨线 ink #0b0b0b

/// 标志在 svg 画布里的实际外接框（按像素算，svg 四周有留白）
func logoBounds() -> NSRect {
    let n = 1024
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    logo.draw(in: NSRect(x: 0, y: 0, width: n, height: n))
    NSGraphicsContext.restoreGraphicsState()
    var minX = n, minY = n, maxX = 0, maxY = 0
    for y in 0..<n { for x in 0..<n where rep.colorAt(x: x, y: y)!.alphaComponent > 0.1 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    } }
    // colorAt 的 y 从上往下，换成以左下为原点、以 svg 尺寸为单位
    let s = logo.size.width / CGFloat(n)
    return NSRect(x: CGFloat(minX) * s, y: (CGFloat(n - 1 - maxY)) * s,
                  width: CGFloat(maxX - minX + 1) * s, height: CGFloat(maxY - minY + 1) * s)
}
let lb = logoBounds()

/// 标志（墨色或模板黑）画进目标框，按外接框居中
func drawLogo(in box: NSRect, color: NSColor) {
    let scale = min(box.width / lb.width, box.height / lb.height)
    let w = logo.size.width * scale, h = logo.size.height * scale
    let x = box.midX - (lb.midX * scale), y = box.midY - (lb.midY * scale)
    let tinted = NSImage(size: NSSize(width: w, height: h), flipped: false) { r in
        logo.draw(in: r)
        color.set()
        r.fill(using: .sourceIn)
        return true
    }
    tinted.draw(in: NSRect(x: x, y: y, width: w, height: h))
}

func png(_ px: Int, _ draw: (CGFloat) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func appIcon(_ s: CGFloat) {
    let k = s / 1024
    let body = NSRect(x: bodyInset * k, y: bodyInset * k, width: bodySize * k, height: bodySize * k)
    let path = NSBezierPath(roundedRect: body, xRadius: bodySize * cornerRatio * k, yRadius: bodySize * cornerRatio * k)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.22)
    shadow.shadowBlurRadius = 18 * k
    shadow.shadowOffset = NSSize(width: 0, height: -6 * k)
    shadow.set()
    bg.setFill(); path.fill()
    NSGraphicsContext.restoreGraphicsState()
    edge.setStroke(); path.lineWidth = max(1, 2 * k); path.stroke()
    let side = bodySize * logoRatio(forPixels: s) * k
    drawLogo(in: NSRect(x: body.midX - side / 2, y: body.midY - side / 2, width: side, height: side), color: ink)
}

// ---- AppIcon.iconset ----
let iconset = outDir.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        try png(base * scale, appIcon).write(to: iconset.appendingPathComponent(name))
    }
}

// ---- 菜单栏模板图：18pt 见方，标志外接框高 16pt（上下各留 1pt），纯黑＋透明，系统按菜单栏深浅自动反色 ----
for (scale, suffix) in [(1, ""), (2, "@2x"), (3, "@3x")] {
    let px = 18 * scale
    let data = png(px) { s in
        let pad = s / 18
        drawLogo(in: NSRect(x: pad, y: pad, width: s - 2 * pad, height: s - 2 * pad), color: .black)
    }
    try data.write(to: outDir.appendingPathComponent("MenuBarIcon\(suffix).png"))
}

// ---- 预览：各尺寸并排，方便肉眼看小尺寸 ----
print("标志外接框（svg 单位）：\(lb)")
print("已生成：\(iconset.path)、MenuBarIcon*.png")
