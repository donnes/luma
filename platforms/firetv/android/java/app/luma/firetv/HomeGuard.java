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
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

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
 * front through a signature-protected broadcast, and again when the service
 * starts and asks, since it may start while Luma is already in front.
 *
 * <p>It also watches the paired T3 Code server ({@link AgentWatch}) and alerts
 * when an agent newly needs you: over another app as a toast in the top-right
 * corner, in a window that takes no focus, keys or touches, so the app
 * underneath keeps the remote and keeps playing; or, while Luma is in front,
 * through Luma's page, which shows the same toast itself. AgentWatch alone
 * decides what's new and what ended while the service runs; the page only
 * shows what it's sent. Several alerts show one after another, as on the
 * page, and one whose request ends, say because it was answered elsewhere,
 * leaves the screen or the queue, here or on the page.
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
  private static final String ACTION_WATCH_AGENTS = "app.luma.firetv.WATCH_AGENTS";
  /** To MainActivity: report whether Luma is in front. */
  static final String ACTION_REPORT_LUMA = "app.luma.firetv.REPORT_LUMA";
  /** To MainActivity, while Luma is in front. */
  static final String ACTION_AGENT_ALERT = "app.luma.firetv.AGENT_ALERT";
  static final String EXTRA_ALERT = "alert";
  /** To MainActivity, whatever is in front, so the page's queue drops them too. */
  static final String ACTION_AGENTS_ENDED = "app.luma.firetv.AGENTS_ENDED";
  static final String EXTRA_REQUESTS = "requests";
  static final String PERMISSION = "com.luma.launcher.permission.HOME_GUARD";

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
  /** AGENT_TOAST_MS in agent-toast.tsx, fade-out included. */
  private static final long ALERT_MS = 6000;
  private static final long ALERT_FADE_MS = 200;

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Runnable uncover = this::uncover;
  private final Runnable clickTile = this::clickTile;
  private final Runnable hideAlert = this::hideAlert;
  private FrameLayout cover;
  private View alert;
  /** The request of the alert on screen. */
  private String alertRequest;
  /** Alerts waiting for the one on screen to finish. */
  private final ArrayDeque<JSONObject> nextAlerts = new ArrayDeque<>();
  private AgentWatch agents;
  private int tileAttempts;
  private boolean lumaVisible;
  private long lumaShownAt;

  private final BroadcastReceiver lumaState =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          String action = intent.getAction();
          if (ACTION_LUMA_SHOWN.equals(action)) {
            lumaVisible = true;
            lumaShownAt = SystemClock.uptimeMillis();
            uncover();
            // Luma's page takes the queue from here; this alert was already seen.
            if (alert != null) {
              main.removeCallbacks(hideAlert);
              hideAlert();
            }
          } else if (ACTION_LUMA_HIDDEN.equals(action)) {
            lumaVisible = false;
          } else if (ACTION_WATCH_AGENTS.equals(action) && agents != null) {
            agents.reload();
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

  /**
   * Luma's page hands over its pairing and the alert's words; see {@link
   * AgentWatch#save}. Saved even while the service is off, which then reads
   * it when it starts.
   */
  static void watchAgents(Context context, String config) {
    AgentWatch.save(context, config);
    Intent intent = new Intent(ACTION_WATCH_AGENTS);
    intent.setPackage(context.getPackageName());
    context.sendBroadcast(intent, PERMISSION);
  }

  @Override
  protected void onServiceConnected() {
    IntentFilter states = new IntentFilter(ACTION_LUMA_SHOWN);
    states.addAction(ACTION_LUMA_HIDDEN);
    states.addAction(ACTION_WATCH_AGENTS);
    registerReceiver(lumaState, states, PERMISSION, null);
    // Restarted while Luma is in front, the service would otherwise draw its
    // toasts over Luma until Luma next resumes. No answer means no Luma.
    Intent ask = new Intent(ACTION_REPORT_LUMA);
    ask.setPackage(getPackageName());
    sendBroadcast(ask, PERMISSION);
    agents =
        new AgentWatch(
            this,
            new AgentWatch.Listener() {
              @Override
              public void onAlert(JSONObject alert) {
                onAgentAlert(alert);
              }

              @Override
              public void onEnded(Set<String> requestIds) {
                onAgentsEnded(requestIds);
              }
            });
    agents.reload();
  }

  @Override
  public void onDestroy() {
    unregisterReceiver(lumaState);
    if (agents != null) agents.stop();
    uncover();
    main.removeCallbacks(hideAlert);
    nextAlerts.clear();
    removeAlert();
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

  /** Luma's page shows its own toast while it's in front; elsewhere the alert goes over the app. */
  private void onAgentAlert(JSONObject alert) {
    if (lumaVisible) {
      toPage(alert);
    } else {
      nextAlerts.add(alert);
      if (this.alert == null) showNextAlert();
    }
  }

  private void onAgentsEnded(Set<String> requestIds) {
    for (Iterator<JSONObject> next = nextAlerts.iterator(); next.hasNext(); ) {
      if (requestIds.contains(next.next().optString("requestId"))) next.remove();
    }
    if (alert != null && requestIds.contains(alertRequest)) {
      main.removeCallbacks(hideAlert);
      hideAlert();
    }
    Intent intent = new Intent(ACTION_AGENTS_ENDED);
    intent.setPackage(getPackageName());
    intent.putStringArrayListExtra(EXTRA_REQUESTS, new ArrayList<>(requestIds));
    sendBroadcast(intent, PERMISSION);
  }

  private void toPage(JSONObject alert) {
    Intent intent = new Intent(ACTION_AGENT_ALERT);
    intent.setPackage(getPackageName());
    intent.putExtra(EXTRA_ALERT, alert.toString());
    sendBroadcast(intent, PERMISSION);
  }

  /** Shows the next queued alert; once Luma is in front, its page takes the rest. */
  private void showNextAlert() {
    JSONObject next;
    while ((next = nextAlerts.poll()) != null) {
      if (lumaVisible) toPage(next);
      else if (showAlert(next)) return;
    }
  }

  private boolean showAlert(JSONObject json) {
    View card;
    try {
      card = alertCard(json);
    } catch (RuntimeException e) {
      Log.w(TAG, "Showing an agent alert failed", e);
      return false;
    }
    WindowManager.LayoutParams params =
        new WindowManager.LayoutParams(
            rems(55),
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            // Never focused or touched: keys and playback stay with the app underneath.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT);
    params.gravity = Gravity.TOP | Gravity.END;
    params.x = rems(5);
    params.y = rems(4);
    params.setTitle("Luma agent alert");
    try {
      ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(card, params);
    } catch (RuntimeException e) {
      Log.w(TAG, "Showing an agent alert failed", e);
      return false;
    }
    alert = card;
    alertRequest = json.optString("requestId");
    card.setAlpha(0);
    card.setTranslationY(-rems(0.75f));
    card.animate()
        .alpha(1)
        .translationY(0)
        .setDuration(240)
        .setInterpolator(new DecelerateInterpolator(2));
    main.postDelayed(hideAlert, ALERT_MS - ALERT_FADE_MS);
    return true;
  }

  private void hideAlert() {
    View card = alert;
    if (card == null) {
      return;
    }
    card.animate()
        .alpha(0)
        .setDuration(ALERT_FADE_MS)
        .withEndAction(
            () -> {
              if (alert == card) {
                removeAlert();
                showNextAlert();
              }
            });
  }

  private void removeAlert() {
    if (alert == null) {
      return;
    }
    try {
      ((WindowManager) getSystemService(WINDOW_SERVICE)).removeViewImmediate(alert);
    } catch (RuntimeException e) {
      Log.w(TAG, "Removing an agent alert failed", e);
    }
    alert = null;
  }

  /**
   * Pixels for a size in rem as agent-toast.css uses it on a 1080p page, 1/120
   * of the screen width. Luma's own page on a Fire TV stick renders its rem a
   * quarter larger, so the in-app toast is bigger than this one.
   */
  private int rems(float count) {
    DisplayMetrics metrics = getResources().getDisplayMetrics();
    return Math.round(count * Math.max(metrics.widthPixels, metrics.heightPixels) / 120f);
  }

  /** A native copy of AgentToast; keep it in step with src/components/agents/agent-toast.css. */
  private View alertCard(JSONObject alert) {
    int amber = Color.rgb(245, 194, 107);
    int muted = Color.argb(143, 245, 245, 245);

    LinearLayout card = new LinearLayout(this);
    card.setPadding(rems(2), rems(1.75f), rems(2), rems(1.75f));
    GradientDrawable background =
        new GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            new int[] {Color.argb(247, 44, 48, 51), Color.argb(252, 29, 32, 36)});
    background.setCornerRadius(rems(1.7f));
    background.setStroke(Math.max(1, rems(1 / 16f)), Color.argb(31, 255, 255, 255));
    card.setBackground(background);

    View bar = new View(this);
    bar.setBackground(rounded(amber, rems(0.25f)));
    LinearLayout.LayoutParams barSize =
        new LinearLayout.LayoutParams(rems(0.5f), ViewGroup.LayoutParams.MATCH_PARENT);
    barSize.setMarginEnd(rems(1.5f));
    card.addView(bar, barSize);

    LinearLayout body = new LinearLayout(this);
    body.setOrientation(LinearLayout.VERTICAL);
    card.addView(body, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

    LinearLayout headline = new LinearLayout(this);
    headline.setGravity(Gravity.CENTER_VERTICAL);
    headline.setPadding(0, 0, 0, rems(0.55f));
    ImageView glyph = new ImageView(this);
    glyph.setImageResource(R.drawable.t3_glyph);
    glyph.setBackground(rounded(Color.rgb(245, 245, 245), rems(0.4f)));
    glyph.setPadding(rems(0.2f), rems(0.2f), rems(0.2f), rems(0.2f));
    LinearLayout.LayoutParams glyphSize = new LinearLayout.LayoutParams(rems(1.7f), rems(1.7f));
    glyphSize.setMarginEnd(rems(0.7f));
    headline.addView(glyph, glyphSize);
    headline.addView(
        line(alert.optString("headline"), rems(1.5f), amber, true),
        new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
    String source = alert.optString("source");
    if (!source.isEmpty()) {
      TextView label = line(source, rems(1.3f), muted, false);
      label.setPadding(rems(1), 0, 0, 0);
      headline.addView(label);
    }
    body.addView(headline);

    TextView title = line(alert.optString("title"), rems(2.1f), Color.rgb(245, 245, 245), true);
    title.setLetterSpacing(-0.03f);
    body.addView(title);
    String detail = alert.optString("detail");
    if (!detail.isEmpty()) {
      TextView project = line(detail, rems(1.5f), muted, false);
      project.setPadding(0, rems(0.35f), 0, 0);
      body.addView(project);
    }
    return card;
  }

  private static GradientDrawable rounded(int color, int radius) {
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(color);
    shape.setCornerRadius(radius);
    return shape;
  }

  private TextView line(String text, int size, int color, boolean medium) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size);
    view.setTextColor(color);
    view.setTypeface(Typeface.create(medium ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
    view.setSingleLine(true);
    view.setEllipsize(TextUtils.TruncateAt.END);
    view.setIncludeFontPadding(false);
    return view;
  }

  @Override
  public void onInterrupt() {}
}
