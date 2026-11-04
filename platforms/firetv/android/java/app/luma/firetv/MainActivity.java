package app.luma.firetv;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import org.libsdl.app.SDLActivity;

/**
 * Hosts the native launcher: SDL loads libSDL2.so and Luma's libmain.so (src/android.rs)
 * and runs it on its own thread. Rust reaches {@link #listApps}, {@link #launchApp} and
 * {@link #openSettings} through JNI on its platform worker thread.
 *
 * <p>Luma reads its artwork and fonts as plain files, so the APK's {@code assets/luma} tree
 * is copied to app storage once per installed build, before SDL starts Luma.
 *
 * <p>HomeGuard needs to know when Luma is in front: it brings Luma back over Amazon's home
 * and covers that home until Luma has drawn. The activity reports its visibility through
 * a signature-protected broadcast, and again when the service starts and asks.
 */
public class MainActivity extends SDLActivity {

  private static final String TAG = "luma";
  private static final String ASSETS = "luma";
  /** The build whose assets are unpacked: its install time. */
  private static final String UNPACKED = "assets.unpacked";
  /** HomeGuard may be covering Amazon's home; drop the cover once Luma's window has drawn. */
  private static final long UNCOVER_DELAY_MS = 150;

  /** From WebAppActivity, when T3 Code's session needs pairing again. */
  static final String ACTION_REPAIR_WEB_APP = "app.luma.firetv.REPAIR_WEB_APP";

  /** From HomeGuard, for the Menu key over another app. */
  static final String ACTION_OPEN_INBOX = "app.luma.firetv.OPEN_INBOX";

  /** Where the web app was headed when it asked; Luma takes it on its next loop. */
  private static volatile String webRepair;
  /** HomeGuard asked for the inbox; Luma takes it on its next loop. */
  private static volatile boolean inboxRequested;

  private final Shell shell = new Shell(this);
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Runnable reportShown = () -> HomeGuard.report(this, true);
  private boolean resumed;

  private final BroadcastReceiver fromHomeGuard =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          if (HomeGuard.ACTION_REPORT_LUMA.equals(intent.getAction())) {
            HomeGuard.report(MainActivity.this, resumed);
          }
        }
      };

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    enterImmersive(this);
    registerReceiver(
        fromHomeGuard,
        new IntentFilter(HomeGuard.ACTION_REPORT_LUMA),
        HomeGuard.PERMISSION,
        null);
    // A restored activity would repeat the request it was started for.
    if (savedInstanceState == null) keepRequest(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    keepRequest(intent);
  }

  private static void keepRequest(Intent intent) {
    if (ACTION_REPAIR_WEB_APP.equals(intent.getAction())) {
      webRepair = intent.getStringExtra(WebAppActivity.EXTRA_URL);
    } else if (ACTION_OPEN_INBOX.equals(intent.getAction())) {
      inboxRequested = true;
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    resumed = true;
    enterImmersive(this);
    main.postDelayed(reportShown, UNCOVER_DELAY_MS);
  }

  @Override
  protected void onPause() {
    resumed = false;
    main.removeCallbacks(reportShown);
    HomeGuard.report(this, false);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    unregisterReceiver(fromHomeGuard);
    super.onDestroy();
  }

  /** Called by SDL on its main thread, before Luma starts. */
  @Override
  protected String[] getArguments() {
    File assets = new File(getFilesDir(), ASSETS);
    try {
      unpackAssets(assets);
    } catch (IOException e) {
      // Luma reports the missing artwork itself and exits; the log says why.
      Log.e(TAG, "Unpacking Luma's assets failed", e);
    }
    return new String[] {
      "--assets",
      assets.getPath(),
      "--preferences",
      new File(getFilesDir(), "preferences.json").getPath(),
      "--fullscreen",
    };
  }

  // Called by src/android.rs on Luma's platform worker thread.

  public String listApps() {
    return shell.listApps();
  }

  public String launchApp(String id) {
    return shell.launchApp(id);
  }

  public String openSettings() {
    shell.openSettings();
    return "{}";
  }

  /**
   * Opens T3 Code's web app in {@link WebAppActivity}; {@code then}, when not empty, loads
   * once the page has left /pair.
   */
  public void openWebApp(String url, String then) {
    Intent intent = WebAppActivity.intent(this, url, then);
    if (intent != null) main.post(() -> startActivity(intent));
  }

  public String takeWebRepair() {
    String target = webRepair;
    webRepair = null;
    return target == null ? "" : target;
  }

  public String takeInboxRequest() {
    boolean requested = inboxRequested;
    inboxRequested = false;
    return requested ? "1" : "";
  }

  /** The inbox opened over another app closed: that app comes back in front. */
  public String returnToApp() {
    main.post(() -> moveTaskToBack(true));
    return "{}";
  }

  /** The T3 Code pairing HomeGuard alerts with; see {@link HomeGuard#watchAgents}. */
  public String watchAgents(String config) {
    HomeGuard.watchAgents(this, config);
    return "{}";
  }

  /** PNG tile art for an app, or null; see {@link Shell#art}. */
  public byte[] appArt(String id) {
    return shell.art(id);
  }

  /** Copies the APK's artwork once per installed build. */
  private void unpackAssets(File target) throws IOException {
    String build;
    try {
      build = String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime);
    } catch (PackageManager.NameNotFoundException e) {
      throw new IOException(e);
    }
    SharedPreferences state = getSharedPreferences(TAG, MODE_PRIVATE);
    if (target.isDirectory() && build.equals(state.getString(UNPACKED, null))) {
      return;
    }
    long started = System.currentTimeMillis();
    delete(target);
    copy(getAssets(), ASSETS, target);
    state.edit().putString(UNPACKED, build).apply();
    Log.i(TAG, "Unpacked Luma's assets in " + (System.currentTimeMillis() - started) + " ms");
  }

  /** AssetManager lists files as entries without children, so an empty list means a file. */
  private static void copy(AssetManager manager, String path, File target) throws IOException {
    String[] children = manager.list(path);
    if (children == null || children.length == 0) {
      try (InputStream in = manager.open(path);
          OutputStream out = new FileOutputStream(target)) {
        byte[] buffer = new byte[64 * 1024];
        for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
      }
      return;
    }
    if (!target.isDirectory() && !target.mkdirs()) {
      throw new IOException("Creating " + target + " failed");
    }
    for (String child : children) {
      copy(manager, path + "/" + child, new File(target, child));
    }
  }

  private static void delete(File file) {
    File[] children = file.listFiles();
    if (children != null) for (File child : children) delete(child);
    if (file.exists() && !file.delete()) Log.w(TAG, "Deleting " + file + " failed");
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
}
