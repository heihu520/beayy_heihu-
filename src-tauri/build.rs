fn main() {
    println!("cargo:rustc-check-cfg=cfg(beayy_mobile)");
    tauri_build::build()
}
