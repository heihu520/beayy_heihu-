package com.fengli.beayy

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat

/**
 * 全屏 WebView 加载 assets/ui/index.html（与 iOS WebScreen 同一套 ui/）。
 * 第一步验收：页面起来后能 `invoke("get_status")` 拿到 `{ mobile: true, … }`。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // 数据目录：filesDir → BEAYY_DATA_ROOT（见 jni.rs nativeInit）
        try {
            BeayyCore.init(filesDir.absolutePath)
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "libbeayy_mobile.so 未打包进 APK。先跑 scripts/build-rust.sh", e)
        } catch (e: Exception) {
            Log.e(TAG, "BeayyCore.init failed", e)
        }

        webView = WebView(this)
        setContentView(webView)

        val bridge = BeayyBridge(webView)
        webView.addJavascriptInterface(bridge, "BeayyBridge")

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            // assets 内相对路径读 css/js
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = true
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("BeayyUI", "${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 只允许 file:///android_asset/ 和页面内 hash 路由
                val url = request.url.toString()
                return !(url.startsWith("file:///android_asset/") || url.startsWith("file://"))
            }

            override fun onPageFinished(view: WebView, url: String) {
                // 再注一次 shim，防止某些机型 document-start 时机不对
                view.evaluateJavascript(BeayyBridge.TAURI_SHIM, null)
                // 开发验收：自动打一次 get_status 到 logcat
                view.evaluateJavascript(
                    """
                    (async function () {
                      try {
                        const s = await window.__TAURI__.core.invoke("get_status");
                        console.log("[beayy] get_status", JSON.stringify(s));
                      } catch (e) {
                        console.error("[beayy] get_status failed", String(e));
                      }
                    })();
                    """.trimIndent(),
                    null,
                )
            }
        }

        // 先注入 shim，再加载页面（部分 WebView 对 addJavascriptInterface 后立刻 evaluate 更稳）
        webView.evaluateJavascript(BeayyBridge.TAURI_SHIM, null)
        webView.loadUrl("file:///android_asset/ui/index.html")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
