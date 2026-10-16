//! 跑一次 iPhone 同步，写到 BEAYY_DATA_ROOT（或影子目录）。对数用：cargo run -p beayy-phone --example sync_once
fn main() {
    let root = beayy_core::data_root();
    let mut s = beayy_phone::PhoneSync::default();
    let notes = s.sync(&root);
    println!("写入目录：{}", root.display());
    println!("{}", s.last_summary);
    for n in notes { println!("{} 共 {} 条", n.device, n.total); }
}
