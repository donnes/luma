package app.luma.firetv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

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
  static final String BASE_URL = "https://" + HOST + "/";
  private static final String ASSET_ROOT = "app/";
  /** Installed apps' banners and icons, drawn by the shell on request. */
  private static final String ART_PREFIX = "/app-art/";
  private static final String TAG = "luma";
  /**
   * Sent by {@link WebAppActivity} when T3 Code's web app needs a new pairing
   * code, with the URL it was headed to as {@link WebAppActivity#EXTRA_URL}.
   */
  static final String ACTION_REPAIR_WEB_APP = "app.luma.firetv.REPAIR_WEB_APP";

  /** Long enough for the resumed window's first frame to reach the screen. */
  private static final long UNCOVER_DELAY_MS = 150;

  private WebView webView;
  private final Shell shell = new Shell(this);
  private final Runnable reportShown = () -> HomeGuard.report(this, true);
  /**
   * HomeGuard asking whether Luma is in front, and its agent alerts while Luma
   * is, for the page's own toast, then the requests that ended. HomeGuard
   * counts an alert as shown once it's sent, so the events that come while
   * the page is still starting, as after the system killed Luma, wait here in
   * order until the page listens for them. So does a web app repair that
   * starts this activity.
   */
  private final BroadcastReceiver fromHomeGuard =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          String action = intent.getAction();
          if (HomeGuard.ACTION_REPORT_LUMA.equals(action)) {
            HomeGuard.report(MainActivity.this, resumed);
          } else if (HomeGuard.ACTION_AGENT_ALERT.equals(action)) {
            String alert = intent.getStringExtra(HomeGuard.EXTRA_ALERT);
            if (alert != null) toPage("luma:agent-alert", alert);
          } else if (HomeGuard.ACTION_AGENTS_ENDED.equals(action)) {
            List<String> ended = intent.getStringArrayListExtra(HomeGuard.EXTRA_REQUESTS);
            if (ended != null) toPage("luma:agent-alerts-ended", new JSONArray(ended).toString());
          }
        }
      };
  private final ArrayList<String> heldEvents = new ArrayList<>();
  private boolean pageListening;
  private boolean resumed;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
    enterImmersive(this);

    webView = createWebView();
    FrameLayout layout = new FrameLayout(this);
    layout.addView(
        webView,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(layout);

    webView.loadUrl(BASE_URL + "index.html");
    IntentFilter events = new IntentFilter(HomeGuard.ACTION_REPORT_LUMA);
    events.addAction(HomeGuard.ACTION_AGENT_ALERT);
    events.addAction(HomeGuard.ACTION_AGENTS_ENDED);
    registerReceiver(fromHomeGuard, events, HomeGuard.PERMISSION, null);
    // A restored activity would repeat the repair it was started for.
    if (savedInstanceState == null) repairWebApp(getIntent());
  }

  /** From the page, through {@link Shell#listenForAgentAlerts}. */
  void onPageListening() {
    pageListening = true;
    for (String event : heldEvents) webView.evaluateJavascript(event, null);
    heldEvents.clear();
  }

  /** Dispatches an event with JSON {@code detail}, the bridge's AGENT_ALERT_EVENT and the like. */
  private void toPage(String name, String detail) {
    String event =
        "window.dispatchEvent(new CustomEvent('" + name + "',{detail:" + detail + "}))";
    if (pageListening) webView.evaluateJavascript(event, null);
    else heldEvents.add(event);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    repairWebApp(intent);
  }

  private void repairWebApp(Intent intent) {
    if (ACTION_REPAIR_WEB_APP.equals(intent.getAction())) {
      String url = intent.getStringExtra(WebAppActivity.EXTRA_URL);
      toPage("luma:t3-repair", JSONObject.quote(url == null ? "" : url));
    }
  }

  @Override
  protected void onPause() {
    resumed = false;
    webView.removeCallbacks(reportShown);
    HomeGuard.report(this, false);
    webView.onPause();
    super.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    webView.onResume();
    enterImmersive(this);
    // HomeGuard may be covering Amazon's home; let it drop the cover once the
    // real window has drawn underneath.
    webView.postDelayed(reportShown, UNCOVER_DELAY_MS);
  }

  @Override
  protected void onDestroy() {
    unregisterReceiver(fromHomeGuard);
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

  /**
   * The WebView keeps Menu from the page, as it does Back, so the shell hands
   * the focused element the keydown a browser would send; Luma opens its
   * inbox on it.
   */
  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (event.getKeyCode() != KeyEvent.KEYCODE_MENU || webView == null) {
      return super.dispatchKeyEvent(event);
    }
    if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
      webView.evaluateJavascript(
          "(document.activeElement||document).dispatchEvent(new KeyboardEvent('keydown',"
              + "{key:'ContextMenu',code:'ContextMenu',keyCode:93,which:93,bubbles:true,"
              + "cancelable:true}))",
          null);
    }
    return true;
  }

  static void enterImmersive(Activity activity) {
    View decor = activity.getWindow().getDecorView();
    decor.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    decor.setOnSystemUiVisibilityChangeListener(visibility -> enterImmersive(activity));
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
    // The app is served from https://luma.local/, but T3 Code servers on the
    // LAN and Tailscale speak plain http:// and ws://.
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
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
    view.addJavascriptInterface(shell, "LumaAndroid");
    return view;
  }

  /** Maps {@code luma.local/**} onto {@code assets/app/**}, and serves app art. */
  private final class AssetWebViewClient extends WebViewClient {
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      Uri url = request.getUrl();
      String path = url.getPath();
      if (isLuma(url) && path != null && path.startsWith(ART_PREFIX) && path.endsWith(".png")) {
        byte[] png = shell.art(path.substring(ART_PREFIX.length(), path.length() - 4));
        return png == null
            ? notFound()
            : new WebResourceResponse("image/png", null, new ByteArrayInputStream(png));
      }
      return asset(MainActivity.this, url);
    }
  }

  private static boolean isLuma(Uri url) {
    return HOST.equals(url.getHost()) && "https".equals(url.getScheme());
  }

  /**
   * The bundled file for a {@code luma.local} URL, empty 404s included; null
   * for other origins, which go to the network. Also serves {@link InboxActivity}.
   */
  static WebResourceResponse asset(Context context, Uri url) {
    if (!isLuma(url)) {
      return null;
    }
    String path = url.getPath();
    String relative =
        path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path.substring(1);
    String asset = ASSET_ROOT + relative;
    try {
      InputStream data = context.getAssets().open(asset);
      String mime = mimeFor(asset);
      return new WebResourceResponse(mime, isText(mime) ? "utf-8" : null, data);
    } catch (IOException missing) {
      return notFound();
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
