// 从 品牌/标志_*.svg 生成 iPhone／手表 app 图标：1024 方形满底、不透明（App Store 不收带透明的图标），系统自己切圆角／圆形。
// 底色、墨色和桌面版一致（墨线 page #fcfcfb、ink #0b0b0b，见 app/tools/make_icons.swift）。
// 用法：swiftc -O app/ios/tools/make_icon.swift -o /tmp/make_icon && /tmp/make_icon 品牌/标志_20261015_暂定.svg app/ios/Phone/Assets.xcassets/AppIcon.appiconset/icon.png 0.5

import AppKit

let a = CommandLine.arguments
guard a.count == 4, let logo = NSImage(contentsOf: URL(fileURLWithPath: a[1])), let ratio = Double(a[3]) else {
    print("用法：make_icon <标志.svg> <输出.png> <标志占画布比例>"); exit(1)
}
let n = 1024


// 标志在 svg 画布里的实际外接框（svg 四周有留白）
let probe = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: probe)
logo.draw(in: NSRect(x: 0, y: 0, width: n, height: n))
NSGraphicsContext.restoreGraphicsState()
var minX = n, minY = n, maxX = 0, maxY = 0
for y in 0..<n { for x in 0..<n where probe.colorAt(x: x, y: y)!.alphaComponent > 0.1 {
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
} }
let bw = CGFloat(maxX - minX + 1), bh = CGFloat(maxY - minY + 1)
let k = CGFloat(ratio) * CGFloat(n) / max(bw, bh)  // 外接框长边＝画布 × ratio
let ox = (CGFloat(n) - bw * k) / 2 - CGFloat(minX) * k
let oy = (CGFloat(n) - bh * k) / 2 - CGFloat(n - 1 - maxY) * k  // colorAt 的 y 从上往下

// 不透明输出：RGB 无透明通道（noneSkipLast），App Store 才收
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(srgbRed: 0xFC / 255, green: 0xFC / 255, blue: 0xFB / 255, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
logo.draw(in: NSRect(x: ox, y: oy, width: CGFloat(n) * k, height: CGFloat(n) * k))
NSGraphicsContext.restoreGraphicsState()
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
