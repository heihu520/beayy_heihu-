package com.fengli.beayy

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 网页 `window.__TAURI__.core.invoke(cmd, args)` → 这里 → [BeayyCore.call]。
 * 镜像 iOS WebScreen.swift 的 Bridge：
 * - 普通命令走 Rust
 * - `native_` 前缀走本机 stub（录音／定位 MVP 不做，只回安全默认值）
 */
class BeayyBridge(private val webView: WebView) {
    private val queue = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(raw: String) {
        queue.execute {
            try {
                val body = JSONObject(raw)
                val id = body.getLong("id")
                val cmd = body.getString("cmd")
                val args = body.optJSONObject("args") ?: JSONObject()
                val out = when {
                    cmd.startsWith("native_") -> handleNative(cmd, args)
                    else -> BeayyCore.call(cmd, args.toString())
                }
                reply(id, out)
            } catch (e: Exception) {
                Log.e(TAG, "bridge", e)
                // 没有可靠 id 时无法 resolve；尽量别让页面挂死
            }
        }
    }

    private fun handleNative(cmd: String, args: JSONObject): String {
        return when (cmd) {
            "native_status" -> {
                // 与 iOS NativeUI.native_status 同形，字段给默认「未开」
                JSONObject()
                    .put(
                        "ok",
                        JSONObject()
                            .put("location", "not_determined")
                            .put("precise", false)
                            .put("watch_recording", false)
                            .put("phone_recording", false)
                            .put("pending", 0)
                            .put("pending_place_days", 0)
                            .put("logged_in", false)
                            .put("device", "android")
                            .put(
                                "health",
                                JSONObject()
                                    .put("available", false)
                                    .put("asked", false)
                                    .put("running", false)
                                    .put("pending_days", 0),
                            ),
                    )
                    .toString()
            }
            "native_action" -> {
                // MVP：不实现录音／健康；回 ok 空，避免设置页报错
                val name = args.optString("name", "")
                Log.i(TAG, "native_action ignored: $name")
                JSONObject().put("ok", JSONObject.NULL).toString()
            }
            else -> JSONObject().put("err", "手机没有这个功能：$cmd").toString()
        }
    }

    private fun reply(id: Long, json: String) {
        // json 已是对象字面量，直接塞进 __beayyResolve
        val script = "window.__beayyResolve($id, $json);"
        main.post {
            webView.evaluateJavascript(script, null)
        }
    }

    companion object {
        private const val TAG = "BeayyBridge"

        /**
         * 注入和 Tauri 一样的 invoke shim（与 iOS WebScreen.swift 同源逻辑）。
         * 在 loadUrl 之前 addJavascriptInterface + evaluate 或用 loadData 前注入。
         */
        const val TAURI_SHIM = """
(function () {
  if (window.__TAURI__) return;
  let n = 0; const pending = {};
  window.__beayyResolve = function (id, res) {
    const p = pending[id]; if (!p) return; delete pending[id];
    if (res && Object.prototype.hasOwnProperty.call(res, "err")) p.reject(res.err);
    else p.resolve(res ? res.ok : null);
  };
  window.__TAURI__ = { core: { invoke: function (cmd, args) {
    return new Promise(function (resolve, reject) {
      const id = ++n; pending[id] = { resolve: resolve, reject: reject };
      if (window.BeayyBridge && window.BeayyBridge.postMessage) {
        window.BeayyBridge.postMessage(JSON.stringify({ id: id, cmd: cmd, args: args || {} }));
      } else {
        reject("BeayyBridge 未就绪");
      }
    });
  } } };
  try { document.documentElement.classList.add("is-tauri"); } catch (e) {}
})();
"""
    }
}
