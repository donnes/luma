package app.luma.firetv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;

/**
 * Android TV / Fire TV shell: hosts the bundled Luma app ({@code dist/app} lives
 * under {@code assets/app/}) in a WebView. Apps are enumerated and started
 * through the package manager by the {@link Shell} bridge object; nothing else
 * is trusted. The same install runs on phones via the plain {@code LAUNCHER}
 * filter, but only TV targets get the leanback tile.
 */
public class MainActivity extends Activity {

  /**
   * Bundled assets are served from a synthetic https origin: file:// URLs
   * cannot load subresources securely, keep localStorage semantics, satisfy
   * the app's Content-Security-Policy, or pass for the weather `connect-src`
   * origins — an intercepted origin does all four with plain WebViewClient
   * request mapping and zero dependencies.
   */
  private static final String HOST = "luma.local";
  private static final String BASE_URL = "https://" + HOST + "/";
  private static final String ASSET_ROOT = "app/";
  private static final String TAG = "luma";

  /** Long enough for the resumed window's first frame to reach the screen. */
  private static final long UNCOVER_DELAY_MS = 150;

  private WebView webView;
  private final Runnable reportShown = () -> HomeGuard.report(this, true);

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
    enterImmersive();

    webView = createWebView();
    FrameLayout layout = new FrameLayout(this);
    layout.addView(
        webView,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(layout);

    webView.loadUrl(BASE_URL + "index.html");
  }

  @Override
  protected void onPause() {
    webView.removeCallbacks(reportShown);
    HomeGuard.report(this, false);
    webView.onPause();
    super.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    webView.onResume();
    enterImmersive();
    // HomeGuard may be covering Amazon's home; let it drop the cover once the
    // real window has drawn underneath.
    webView.postDelayed(reportShown, UNCOVER_DELAY_MS);
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.destroy();
    }
    super.onDestroy();
  }

  /**
   * The app owns Back-stack semantics (panels, then Home, then the webOS-style
   * platform Back). Surface the same Escape keydown a webOS remote would send;
   * once the app has nothing to close, its {@code platformBack()} lands on
   * {@link Shell#exit()} → {@code moveTaskToBack}, so the shell survives.
   */
  @Override
  public void onBackPressed() {
    if (webView == null) {
      super.onBackPressed();
      return;
    }
    String escape =
        "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',"
            + "keyCode:27,which:27,bubbles:true,cancelable:true}))";
    webView.evaluateJavascript(escape, null);
  }

  private void enterImmersive() {
    View decor = getWindow().getDecorView();
    decor.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    decor.setOnSystemUiVisibilityChangeListener(visibility -> enterImmersive());
  }

  @SuppressLint("SetJavaScriptEnabled")
  private WebView createWebView() {
    WebView view = new WebView(this);
    view.setBackgroundColor(Color.BLACK);
    view.setOverScrollMode(View.OVER_SCROLL_NEVER);
    view.setFocusable(true);
    view.setFocusableInTouchMode(true);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    // Keep authored font sizes; TV sticks use high device densities where the
    // automatic text zoom would inflate the layout.
    settings.setTextZoom(100);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    // A 1:1 fullscreen layout viewport (1080p on Fire TV sticks 3rd gen).
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    view.setWebViewClient(new AssetWebViewClient());
    view.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d(
                TAG,
                "console: "
                    + message.message()
                    + " ("
                    + message.sourceId()
                    + ':'
                    + message.lineNumber()
                    + ')');
            return true;
          }
        });
    view.addJavascriptInterface(new Shell(this), "LumaAndroid");
    return view;
  }

  /** Maps {@code luma.local/**} onto {@code assets/app/**}; 404s are empty. */
  private final class AssetWebViewClient extends WebViewClient {
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      Uri url = request.getUrl();
      if (!HOST.equals(url.getHost()) || !"https".equals(url.getScheme())) {
        return null;
      }
      String path = url.getPath();
      String relative =
          path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path.substring(1);
      String asset = ASSET_ROOT + relative;
      try {
        InputStream data = getAssets().open(asset);
        String mime = mimeFor(asset);
        return new WebResourceResponse(mime, isText(mime) ? "utf-8" : null, data);
      } catch (IOException missing) {
        return notFound();
      }
    }
  }

  private static String mimeFor(String asset) {
    String lower = asset.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
    if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".woff")) return "font/woff";
    if (lower.endsWith(".woff2")) return "font/woff2";
    if (lower.endsWith(".ttf")) return "font/ttf";
    if (lower.endsWith(".otf")) return "font/otf";
    if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".sh"))
      return "text/plain";
    return "application/octet-stream";
  }

  private static boolean isText(String mime) {
    return mime.startsWith("text/") || mime.contains("json") || mime.contains("svg");
  }

  private static WebResourceResponse notFound() {
    return new WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(),
        new ByteArrayInputStream(new byte[0]));
  }
}
