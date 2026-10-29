import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// 颜色：壳和组件照设计系统「墨线」（设计系统/墨线/project/tokens.json），数据源颜色照「人生记录」（同 app/ui/style.css 的 --rec-*）。
/// 浅色、深色各一套；手表只有深色。改颜色先改设计系统，再同步这里。
enum Theme {
    // 墨线
    static let page = dyn(0xfcfcfb, 0x151515)
    static let sunken = dyn(0xf9f9f7, 0x0b0b0b)
    static let grouped = dyn(0xf2f2ef, 0x0b0b0b)   // 原生 app 分组页的底
    static let surface = dyn(0xffffff, 0x1a1a19)   // 分组页上的白卡
    static let ink = dyn(0x0b0b0b, 0xf0efec)
    static let ink2 = dyn(0x52514e, 0xc3c2b7)
    static let ink3 = dyn(0x73726c, 0xa5a49a)
    static let ink4 = dyn(0x898781, 0x898781)
    static let line = dyn(0x0b0b0b, 0xffffff, 0.10, 0.10)
    static let lineStrong = dyn(0x0b0b0b, 0xffffff, 0.16, 0.20)
    static let selected = dyn(0x0b0b0b, 0xffffff, 0.10, 0.15)
    static let primary = dyn(0x0b0b0b, 0xffffff)
    static let onPrimary = dyn(0xffffff, 0x0b0b0b)
    static let accentInk = dyn(0x184f95, 0x6da7ec)
    static let ok = dyn(0x009300, 0x009300)
    static let warn = dyn(0xfab219, 0xfab219)
    static let warnInk = dyn(0x734500, 0xdb9300)
    static let warnWash = dyn(0xfab219, 0x311a00, 0.16, 1)
    static let risk = dyn(0xd03b3b, 0xd03b3b)
    static let riskInk = dyn(0x8e2626, 0xec7e7e)
    static let riskWash = dyn(0xd03b3b, 0x3c0e0e, 0.10, 1)
    // 人生记录：数据源
    static let phone = dyn(0xe08a1e, 0xf2a93b)
    static let watch = dyn(0x2f8a57, 0x5fd08f)
    static let place = dyn(0xcdd2d6, 0x3b4248)
    static let placeAlt = dyn(0xb3bac0, 0x4d555c)
    static let track = dyn(0xeceee9, 0x22262a)

    private static func dyn(_ light: UInt32, _ dark: UInt32, _ la: Double = 1, _ da: Double = 1) -> Color {
        #if os(iOS)
        return Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark, da) : rgb(light, la) })
        #else
        return Color(rgb(dark, da))
        #endif
    }

    private static func rgb(_ v: UInt32, _ a: Double) -> UIColor {
        UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                blue: CGFloat(v & 0xff) / 255, alpha: CGFloat(a))
    }
}

/// 字：墨线「原生 app」一节——手机上整体比桌面大一号，层级不变。页名 30／600（iOS 不自带中文宋体，用系统黑体），数字等宽
enum Typo {
    static let pageTitle = Font.system(size: 30, weight: .semibold)
    static let sectionTitle = Font.system(size: 17, weight: .semibold)
    static let body = Font.system(size: 16)
    static let note = Font.system(size: 14)
    static let label = Font.system(size: 13)
    static let stat = Font.system(size: 24, weight: .medium, design: .monospaced)
    static let data = Font.system(size: 13, design: .monospaced)
}
