package app.luma.firetv;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import java.util.List;

/**
 * Keeps Luma in front of the Fire TV home screen. Fire OS hard-wires the Home
 * key (and the exit of most apps) to Amazon's launcher and refuses a
 * replacement HOME activity, so this accessibility service brings Luma back
 * whenever that launcher's home screen shows up. Other screens in the same
 * package, such as voice search results, are left alone. It also covers boot:
 * enabled services start with the system, and the home screen is the first
 * window they see.
 *
 * <p>After the Home key, Android defers background activity starts for about
 * five seconds (app-switch protection). Android 9 handles Home before
 * accessibility key filters, and Fire OS keeps its {@code homekey} broadcast
 * to system apps, so the first signal is Amazon's home drawing. The service
 * then queues Luma's start, which lands when the delay ends, and, because the
 * foreground app is exempt from the delay, clicks Luma's tile in the Fire TV
 * home bar so the launcher itself opens Luma sooner. Meanwhile an overlay in
 * Luma's colours hides Amazon's home and swallows remote keys, so nothing
 * there gets launched by accident.
 *
 * <p>The service runs in its own small process (see the manifest): Fire TV
 * sticks are short on memory, and the low-memory killer would otherwise take
 * it down together with Luma's WebView. MainActivity reports when it is in
 * front through a signature-protected broadcast.
 *
 * <p>Events come only from Amazon's launcher package; window content is read
 * only to find the Luma tile there. Enable it once over ADB (see
 * platforms/firetv/README.md).
 */
public final class HomeGuard extends AccessibilityService {

  private static final String TAG = "luma";
  private static final String AMAZON_HOME = "com.amazon.tv.launcher";
  /** Fire OS 7 names it HomeActivity_vNext; the prefix covers renames like that. */
  private static final String AMAZON_HOME_SCREEN = "com.amazon.tv.launcher.ui.HomeActivity";

  private static final String ACTION_LUMA_SHOWN = "app.luma.firetv.LUMA_SHOWN";
  private static final String ACTION_LUMA_HIDDEN = "app.luma.firetv.LUMA_HIDDEN";
  private static final String PERMISSION = "com.luma.launcher.permission.HOME_GUARD";

  /** Longer than the app-switch delay; never leave the remote dead if Luma fails to start. */
  private static final long COVER_TIMEOUT_MS = 8000;
  /**
   * Amazon's home keeps emitting window events while Luma takes over; ignore
   * them briefly so the tile isn't clicked twice.
   */
  private static final long SETTLE_MS = 1500;
  /** Look for the tile until the queued start lands anyway. */
  private static final long TILE_RETRY_MS = 100;
  private static final int TILE_ATTEMPTS = 50;

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Runnable uncover = this::uncover;
  private final Runnable clickTile = this::clickTile;
  private FrameLayout cover;
  private int tileAttempts;
  private boolean lumaVisible;
  private long lumaShownAt;

  private final BroadcastReceiver lumaState =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          if (ACTION_LUMA_SHOWN.equals(intent.getAction())) {
            lumaVisible = true;
            lumaShownAt = SystemClock.uptimeMillis();
            uncover();
          } else {
            lumaVisible = false;
          }
        }
      };

  /** Whether the user enabled this service (Settings → Accessibility or ADB). */
  static boolean isEnabled(Context context) {
    AccessibilityManager manager =
        (AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
    for (AccessibilityServiceInfo info :
        manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
      ServiceInfo service = info.getResolveInfo().serviceInfo;
      if (context.getPackageName().equals(service.packageName)
          && HomeGuard.class.getName().equals(service.name)) {
        return true;
      }
    }
    return false;
  }

  /** MainActivity, in the main app process, reports whether it is in front. */
  static void report(Context context, boolean shown) {
    Intent intent = new Intent(shown ? ACTION_LUMA_SHOWN : ACTION_LUMA_HIDDEN);
    intent.setPackage(context.getPackageName());
    context.sendBroadcast(intent, PERMISSION);
  }

  @Override
  protected void onServiceConnected() {
    IntentFilter states = new IntentFilter(ACTION_LUMA_SHOWN);
    states.addAction(ACTION_LUMA_HIDDEN);
    registerReceiver(lumaState, states, PERMISSION, null);
  }

  @Override
  public void onDestroy() {
    unregisterReceiver(lumaState);
    uncover();
    super.onDestroy();
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {
    if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        || !AMAZON_HOME.contentEquals(event.getPackageName())
        || !String.valueOf(event.getClassName()).startsWith(AMAZON_HOME_SCREEN)) {
      return;
    }
    // Already on the way back, or Luma just arrived.
    if (cover != null
        || lumaVisible
        || SystemClock.uptimeMillis() - lumaShownAt < SETTLE_MS) {
      return;
    }
    returnToLuma();
  }

  private void returnToLuma() {
    cover();
    // MainActivity is singleTask: this resumes the existing task (and its
    // WebView state) instead of creating a second Luma. After the Home key
    // Android queues this start; the tile click below may beat it.
    Intent luma = new Intent(this, MainActivity.class);
    luma.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(luma);
    } catch (RuntimeException e) {
      Log.w(TAG, "Returning to Luma failed", e);
      uncover();
      return;
    }
    tileAttempts = 0;
    main.removeCallbacks(clickTile);
    main.post(clickTile);
  }

  /** Clicks Luma's tile in the Fire TV home bar, retrying while Amazon's home loads. */
  private void clickTile() {
    if (cover == null) {
      return; // Luma is already back.
    }
    String label = String.valueOf(getApplicationInfo().loadLabel(getPackageManager()));
    // The cover is the active window, so look for Amazon's home among all of them.
    for (AccessibilityWindowInfo window : getWindows()) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null || !AMAZON_HOME.contentEquals(root.getPackageName())) {
        continue;
      }
      List<AccessibilityNodeInfo> matches = root.findAccessibilityNodeInfosByText(label);
      for (AccessibilityNodeInfo node : matches) {
        // The search also matches substrings; only the exact, clickable tile counts.
        if (node.isClickable()
            && label.contentEquals(node.getContentDescription())
            && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
          return;
        }
      }
    }
    if (++tileAttempts < TILE_ATTEMPTS) {
      main.postDelayed(clickTile, TILE_RETRY_MS);
    }
  }

  private void cover() {
    main.removeCallbacks(uncover);
    main.postDelayed(uncover, COVER_TIMEOUT_MS);
    if (cover != null) {
      return;
    }
    FrameLayout frame =
        new FrameLayout(this) {
          @Override
          public boolean dispatchKeyEvent(KeyEvent event) {
            return true;
          }
        };
    frame.setBackgroundColor(Color.rgb(23, 25, 28));
    frame.setFocusable(true);
    ImageView icon = new ImageView(this);
    icon.setImageResource(R.drawable.ic_launcher);
    int size = (int) (96 * getResources().getDisplayMetrics().density);
    frame.addView(icon, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
    WindowManager.LayoutParams params =
        new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_FULLSCREEN,
            PixelFormat.OPAQUE);
    try {
      ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(frame, params);
      frame.requestFocus();
      cover = frame;
    } catch (RuntimeException e) {
      Log.w(TAG, "Covering the Fire TV home failed", e);
    }
  }

  private void uncover() {
    main.removeCallbacks(uncover);
    main.removeCallbacks(clickTile);
    if (cover == null) {
      return;
    }
    try {
      ((WindowManager) getSystemService(WINDOW_SERVICE)).removeViewImmediate(cover);
    } catch (RuntimeException e) {
      Log.w(TAG, "Removing the cover failed", e);
    }
    cover = null;
  }

  @Override
  public void onInterrupt() {}
}
