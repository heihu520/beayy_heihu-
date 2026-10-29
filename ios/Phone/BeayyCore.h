// Beayy 的 Rust 核心（app/mobile，静态库 libbeayy_mobile.a）：和电脑同一套数据代码。见 app/mobile/src/lib.rs
#pragma once
/// 调一个命令：cmd 是命令名，args 是 JSON 对象；返回 {"ok": …} 或 {"err": "…"}，用 beayy_free 释放。会阻塞，在后台线程调
char *beayy_call(const char *cmd, const char *args);
/// 释放 beayy_call 返回的字符串
void beayy_free(char *p);
/// 启动后台：账号同步（只下载）、录音和停留点
void beayy_start(void);
