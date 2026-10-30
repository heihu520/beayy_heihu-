package com.fengli.beayy

import android.content.Context
import org.json.JSONObject

/** Rust 核心（app/mobile，libbeayy_mobile.so）：和电脑、iPhone 同一套数据代码。call 会阻塞，别在主线程调 */
object Core {
    init { System.loadLibrary("beayy_mobile") }

    @JvmStatic private external fun init(home: String)
    @JvmStatic external fun call(cmd: String, args: String): String

    @Volatile private var started = false

    /** 数据放 app 私有目录：HOME 指到 filesDir，数据根＝filesDir/Library/Application Support/Beayy（和其他端同样的相对位置） */
    fun start(ctx: Context) {
        if (started) return
        synchronized(this) {
            if (!started) { init(ctx.filesDir.absolutePath); started = true }
        }
    }

    /** 调一个命令，拿 ok 那一项；出错抛异常 */
    fun ok(cmd: String, args: JSONObject = JSONObject()): Any? {
        val out = JSONObject(call(cmd, args.toString()))
        if (out.has("err")) throw RuntimeException(out.optString("err"))
        return out.opt("ok")
    }
}
