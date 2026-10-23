package app.luma.firetv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import org.json.JSONObject;

/**
 * POC: hosts T3 Code's own web client (served by the paired T3 server) in a
 * second WebView, with {@code assets/t3/tv.css} and {@code tv.js} injected on
 * every page to size it for a TV and drive it with the D-pad. The page gets
 * only {@code window.LumaWeb.repair()}, never the {@link Shell} bridge.
 */
public class WebAppActivity extends Activity {

  static final String EXTRA_URL = "url";
  /** Loaded once a page other than /pair has loaded: pairing lands on "/", not the deep link. */
  static final String EXTRA_THEN = "then";
  private static final String TAG = "luma";

  private WebView webView;
  private String injection;
  private String then;
  /** Opened with a pairing code: a pair page with no code is T3 Code mid hand-off, not a lost session. */
  private boolean handoff;
  /** The deep link is loading; forget the pairing pages before it. */
  private boolean forgetHistory;
  /**
   * The T3 server Luma verified before minting the pairing code. The page stays
   * on it: a redirect elsewhere would carry the code in the URL fragment.
   */
  private String origin;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
    MainActivity.enterImmersive(this);
    // POC: lets `chrome://inspect` (over adb) tune the injected CSS and JS live.
    WebView.setWebContentsDebuggingEnabled(true);
    injection =
        "window.__lumaTVCSS=" + JSONObject.quote(asset("t3/tv.css")) + ";\n" + asset("t3/tv.js");
    webView = createWebView();
    setContentView(webView);
    load(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    load(intent);
  }

  private void load(Intent intent) {
    String url = intent.getStringExtra(EXTRA_URL);
    then = intent.getStringExtra(EXTRA_THEN);
    origin = origin(Uri.parse(url));
    handoff = "/pair".equals(Uri.parse(url).getPath());
    webView.loadUrl(url);
  }

  @Override
  protected void onPause() {
    webView.onPause();
    super.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    webView.onResume();
    MainActivity.enterImmersive(this);
  }

  @Override
  protected void onDestroy() {
    webView.destroy();
    super.onDestroy();
  }

  /** tv.js closes the page's dialogs and menus first, then walks its history. */
  @Override
  public void onBackPressed() {
    webView.evaluateJavascript(
        "window.__lumaBack ? window.__lumaBack(" + webView.canGoBack() + ") : false",
        handled -> {
          if (!"true".equals(handled)) finish();
        });
  }

  /** scheme://host:port, or "" for anything that isn't http(s). */
  private static String origin(Uri uri) {
    String scheme = uri.getScheme();
    if (!"http".equals(scheme) && !"https".equals(scheme) || uri.getHost() == null) return "";
    return scheme + "://" + uri.getHost().toLowerCase() + ":" + uri.getPort();
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
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
    settings.setTextZoom(100);
    settings.setSupportZoom(false);
    // tv.js sets the page's layout width; the WebView scales it to the screen.
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    view.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Also called for server redirects. Downloads, mailto: and other
            // apps' links have nowhere to go on the TV, and other sites
            // mustn't load with the pairing code or the TV adjustments.
            String target = origin(request.getUrl());
            return target.isEmpty() || request.isForMainFrame() && !target.equals(origin);
          }

          // Both hooks run the (idempotent) injection: the first as soon as the
          // new page paints, the second in case the page replaced its head.
          @Override
          public void onPageCommitVisible(WebView view, String url) {
            view.evaluateJavascript(injection, null);
          }

          @Override
          public void onPageFinished(WebView view, String url) {
            view.evaluateJavascript(injection, null);
            if (then != null && !"/pair".equals(Uri.parse(url).getPath())) {
              String next = then;
              then = null;
              forgetHistory = true;
              view.loadUrl(next);
            } else if (forgetHistory) {
              // Back from the deep link returns to Luma, not to the pairing pages.
              forgetHistory = false;
              view.clearHistory();
            }
          }
        });
    view.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d(TAG, "t3: " + message.message() + " (" + message.sourceId() + ':'
                + message.lineNumber() + ')');
            return true;
          }
        });
    view.addJavascriptInterface(new Page(), "LumaWeb");
    return view;
  }

  private final class Page {
    /** The server wants a pairing code: close and let Luma's form collect one. */
    @JavascriptInterface
    public void repair() {
      runOnUiThread(
          () -> {
            if (handoff) return;
            Intent luma = new Intent(WebAppActivity.this, MainActivity.class);
            luma.setAction(MainActivity.ACTION_REPAIR_WEB_APP);
            startActivity(luma);
            finish();
          });
    }
  }

  private String asset(String name) {
    try (InputStream in = getAssets().open(name)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
      return out.toString("UTF-8");
    } catch (IOException e) {
      Log.w(TAG, "Reading " + name + " failed", e);
      return "";
    }
  }
}
