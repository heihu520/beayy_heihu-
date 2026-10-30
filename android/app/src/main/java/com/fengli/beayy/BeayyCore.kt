package com.fengli.beayy

/**
 * Rust 核心（libbeayy_mobile.so）的 JNI 入口。
 * 对应 iOS 的 BeayyCore.h：`beayy_call` / `beayy_free` / `beayy_start`。
 *
 * 必须先 [init]（设 BEAYY_DATA_ROOT 并 beayy_start），再 [call]。
 */
object BeayyCore {
    @Volatile
    private var ready = false

    init {
        System.loadLibrary("beayy_mobile")
    }

    /** @param dataRoot 绝对路径，通常是 context.filesDir.absolutePath */
    @Synchronized
    fun init(dataRoot: String) {
        if (ready) return
        nativeInit(dataRoot)
        ready = true
    }

    /**
     * 调一个命令。返回原始 JSON：`{"ok":…}` 或 `{"err":"…"}`。
     * 会阻塞（联网命令可能几秒），务必在后台线程调用。
     */
    fun call(cmd: String, argsJson: String = "{}"): String {
        check(ready) { "BeayyCore.init() 还没调" }
        return nativeCall(cmd, argsJson)
    }

    private external fun nativeInit(dataRoot: String)
    private external fun nativeCall(cmd: String, argsJson: String): String
}
