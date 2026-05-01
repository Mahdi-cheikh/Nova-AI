package ai.nova.receptionist

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity

/**
 * Lightweight splash that holds for 1.2s then jumps into the WebView host.
 * The splash drawable is set via the Theme.NovaAI.Splash style — no layout
 * inflation needed, so the first frame is instant.
 */
class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Handler(Looper.getMainLooper()).postDelayed({
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }, 1200)
    }
}
