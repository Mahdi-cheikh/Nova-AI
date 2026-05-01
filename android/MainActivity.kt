package ai.nova.receptionist

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    /**
     * CHANGE THIS to your deployed Vercel URL once you ship the frontend.
     * For local testing on a device on the same Wi-Fi, use your machine's
     * IP, e.g. "http://192.168.1.42:5500".
     */
    private val appUrl = "https://nova-ai.vercel.app"

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // localStorage support — required by Nova
            databaseEnabled = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                // Keep navigation inside our domain inside the WebView; let other URLs go to the system browser.
                return if (req.url.host?.contains("vercel.app") == true ||
                           req.url.host?.contains("nova.ai") == true) {
                    false
                } else {
                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, req.url)
                    startActivity(intent); true
                }
            }
        }
        webView.webChromeClient = WebChromeClient()

        // Edge-to-edge friendly
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE

        webView.loadUrl(appUrl)

        // Hardware back button = WebView back if possible
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }
}
