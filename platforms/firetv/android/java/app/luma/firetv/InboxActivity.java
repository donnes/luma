package app.luma.firetv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The agents inbox over another app, opened by {@link HomeGuard} on the Menu
 * key: a translucent window whose WebView loads Luma's own bundle with
 * {@code #inbox}, which draws only the inbox panel over a transparent page.
 * It runs in Luma's main process, so the page shares MainActivity's
 * localStorage and with it the T3 Code pairing.
 *
 * <p>Back and Menu close it, from the first frame on, before the page has
 * loaded. So does anything else coming to the front, such as T3 Code's web
 * app after OK on a thread: a Fire TV stick has no memory for a second Luma
 * WebView that nobody sees. Started again while it shows, as by a second
 * Menu press that HomeGuard turns into one, it closes too.
 *
 * <p>The page gets {@code window.LumaAndroid} with {@code openWebApp} only.
 */
public class InboxActivity extends Activity {

  private static final String TAG = "luma";

  private final Handler main = new Handler(Looper.getMainLooper());
  private WebView webView;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    MainActivity.enterImmersive(this);
    webView = createWebView();
    setContentView(webView);
    webView.loadUrl(MainActivity.BASE_URL + "index.html#inbox");
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    finish();
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    int key = event.getKeyCode();
    if (key != KeyEvent.KEYCODE_BACK && key != KeyEvent.KEYCODE_MENU) {
      return super.dispatchKeyEvent(event);
    }
    if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) finish();
    return true;
  }

  @Override
  protected void onStop() {
    super.onStop();
    if (!isFinishing()) finish();
  }

  @Override
  protected void onDestroy() {
    webView.destroy();
    super.onDestroy();
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  private WebView createWebView() {
    WebView view = new WebView(this);
    view.setBackgroundColor(Color.TRANSPARENT);
    view.setOverScrollMode(View.OVER_SCROLL_NEVER);
    view.setFocusable(true);
    view.setFocusableInTouchMode(true);
    WebSettings settings = view.getSettings();
    // As in MainActivity, which this page shares its origin and storage with.
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setTextZoom(100);
    settings.setSupportZoom(false);
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    view.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView view, WebResourceRequest request) {
            return MainActivity.asset(InboxActivity.this, request.getUrl());
          }
        });
    view.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d(TAG, "inbox: " + message.message() + " (" + message.sourceId() + ':'
                + message.lineNumber() + ')');
            return true;
          }
        });
    view.addJavascriptInterface(new Page(), "LumaAndroid");
    return view;
  }

  private final class Page {
    /** As {@link Shell#openWebApp}; this window closes once T3 Code is in front. */
    @JavascriptInterface
    public void openWebApp(String url, String then) {
      Intent intent = WebAppActivity.intent(InboxActivity.this, url, then);
      if (intent == null) return;
      // Into Luma's task, where an open T3 Code takes the thread instead of a
      // second web app starting beside it.
      intent.addFlags(
          Intent.FLAG_ACTIVITY_NEW_TASK
              | Intent.FLAG_ACTIVITY_CLEAR_TOP
              | Intent.FLAG_ACTIVITY_SINGLE_TOP);
      main.post(() -> startActivity(intent));
    }
  }
}
