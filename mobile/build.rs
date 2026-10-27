fn main() {
    // 电脑外壳的源文件在手机版里也编：用这个 cfg 去掉 Tauri 的命令标记、图标不从 beayy-capture 取
    println!("cargo:rustc-check-cfg=cfg(beayy_mobile)");
    println!("cargo:rustc-cfg=beayy_mobile");
}
