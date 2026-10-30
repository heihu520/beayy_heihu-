package com.fengli.beayy

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Process
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 读每个 app 在前台的起止（UsageStatsManager 的 ACTIVITY_RESUMED／PAUSED），交给 Rust 核心记成 app.focus 事件
 * （和 iPhone 同一种，电脑那边同一套算法算拿起次数、每个 app 多久），再同步上传。
 * 从上次读到的地方往后读；第一次读最近 7 天（系统一般只留几天的明细）。
 */
object Usage {
    @Volatile var lastRead: Long = 0
    @Volatile var lastError: String? = null
    @Volatile var running = false

    fun granted(ctx: Context): Boolean {
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** 读一轮并上传；返回记了几条。会阻塞（联网），别在主线程调 */
    @Synchronized
    fun read(ctx: Context): Int {
        Core.start(ctx)
        if (!granted(ctx)) { Log.i("Beayy", "没允许读使用情况"); return 0 }
        running = true
        try {
            val now = System.currentTimeMillis()
            val cursor = (Core.ok("android_cursor") as? Number)?.toDouble() ?: 0.0
            val from = if (cursor > 0) (cursor * 1000).toLong() else now - 7 * 86_400_000L
            val usm = ctx.getSystemService(UsageStatsManager::class.java)
            val events = usm.queryEvents(from, now)
            val e = UsageEvents.Event()
            val names = HashMap<String, String>()
            // 桌面（启动器）不算一个 app：回到桌面＝没在用哪个 app
            val home = ctx.packageManager.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)?.activityInfo?.packageName
            var batch = JSONArray()
            var n = 0
            fun flush() {
                if (batch.length() == 0) return
                n += (Core.ok("android_usage", JSONObject().put("events", batch)) as? Number)?.toInt() ?: 0
                batch = JSONArray()
            }
            while (events.hasNextEvent()) {
                events.getNextEvent(e)
                val start = when (e.eventType) {
                    UsageEvents.Event.ACTIVITY_RESUMED -> true
                    UsageEvents.Event.ACTIVITY_PAUSED -> false
                    else -> continue
                }
                val pkg = e.packageName ?: continue
                if (pkg == home) continue
                val name = names.getOrPut(pkg) { label(ctx, pkg) }
                batch.put(JSONObject().put("t", e.timeStamp / 1000.0).put("start", start).put("package", pkg).put("name", name))
                if (batch.length() >= 2000) flush()
            }
            flush()
            // 记下来的马上传，不等后台同步的下一轮（定时任务跑完进程可能就被收了）
            // 没登录、正在同步时会报错：不算读失败，后台同步下一轮会传
            try { Core.ok("sync_now") } catch (_: Exception) {}
            lastRead = now
            lastError = null
            Log.i("Beayy", "读到 $n 条使用记录")
            return n
        } catch (x: Exception) {
            Log.w("Beayy", "读使用记录出错", x)
            lastError = x.message
            return 0
        } finally {
            running = false
        }
    }

    private fun label(ctx: Context, pkg: String): String = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (x: PackageManager.NameNotFoundException) {
        ""
    }
}
