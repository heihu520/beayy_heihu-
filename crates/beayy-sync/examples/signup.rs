//! 命令行注册一个 Beayy 账号（审核演示账号这类不在 app 里注册的）：
//! cargo run -q -p beayy-sync --example signup -- <数据目录> <邀请码> <邮箱> <主密码> [同步服务地址]
//! 账号文件写进 <数据目录>（不碰钥匙串、不影响本机 Beayy 的登录），用完可删；恢复码打印出来。
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("用法：signup <数据目录> <邀请码> <邮箱> <主密码> [同步服务地址]");
        std::process::exit(2);
    }
    let server = a.get(5).map(String::as_str).unwrap_or("https://sync.beayy.com");
    let root = std::path::Path::new(&a[1]);
    // 账号只写进 <数据目录>：不设这个，Mac 上会写进全机共用的钥匙串，把本机 Beayy 的登录换成这个账号（10-22 出过事）
    std::env::set_var("BEAYY_DATA_ROOT", root);
    match beayy_sync::signup(root, server, a[2].trim(), &a[3], &a[4], "cli-signup", "命令行注册") {
        Ok(code) => println!("已注册，恢复码：{code}"),
        Err(e) => {
            eprintln!("注册没成功：{e}");
            std::process::exit(1);
        }
    }
}
