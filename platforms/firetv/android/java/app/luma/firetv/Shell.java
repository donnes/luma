package app.luma.firetv;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The {@code window.LumaAndroid} injected object — the synchronous contract of
 * {@code packages/bridge/src/android.ts}: {@code isTV}, {@code listApps} and
 * {@code launchApp} return JSON strings, {@code exit} parks the shell task.
 *
 * Bridge calls run on a WebView worker thread, so package-manager queries
 * finish synchronously there and anything touching the activity hops to the
 * main thread through a {@link Handler}.
 */
public final class Shell {

  private static final String TAG = "luma";
  /** Same application id as the webOS package, excluded from the library. */
  private static final String SELF = "com.luma.launcher";

  private final Activity activity;
  private final Handler main;
  private Catalog catalog;

  Shell(Activity activity) {
    this.activity = activity;
    this.main = new Handler(Looper.getMainLooper());
  }

  @JavascriptInterface
  public boolean isTV() {
    return true;
  }

  @JavascriptInterface
  public synchronized String listApps() {
    JSONArray apps = new JSONArray();
    try {
      for (Map.Entry<String, String> entry : catalog().titles.entrySet()) {
        String appId = entry.getKey();
        String title = entry.getValue();
        JSONObject app = new JSONObject();
        app.put("id", appId);
        if (title == null || title.isEmpty()) {
          app.put("title", appId);
        } else {
          app.put("title", title);
        }
        apps.put(app);
      }
      return new JSONObject().put("apps", apps).toString();
    } catch (JSONException e) {
      Log.w(TAG, "Serializing the app list failed", e);
      return "{\"apps\":[]}";
    }
  }

  @JavascriptInterface
  public synchronized String launchApp(String id) {
    String pkg = id == null ? "" : id.trim();
    if (pkg.isEmpty()) {
      return error("This app has an invalid identifier.");
    }
    if (pkg.equals(SELF) || pkg.equals(activity.getPackageName())) {
      return error("Luma cannot open itself.");
    }
    ComponentName component = catalog().components.get(pkg);
    if (component == null) {
      return error("That app isn't installed.");
    }
    Intent intent = new Intent(Intent.ACTION_MAIN);
    intent.addCategory(Intent.CATEGORY_LAUNCHER);
    intent.setComponent(component);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
    main.post(
        () -> {
          try {
            activity.startActivity(intent);
          } catch (RuntimeException e) {
            Log.w(TAG, "Launching " + pkg + " failed", e);
          }
        });
    return "{}";
  }

  @JavascriptInterface
  public synchronized void exit() {
    // Park the shell task instead of finishing it: the remote's Back key may
    // already have been handled inside the app, and a relaunch is instant.
    main.post(() -> activity.moveTaskToBack(true));
  }

  /** One entry per package; the leanback activity wins over the phone one. */
  private static final class Catalog {
    final LinkedHashMap<String, ComponentName> components = new LinkedHashMap<>();
    final LinkedHashMap<String, String> titles = new LinkedHashMap<>();
  }

  private Catalog catalog() {
    if (catalog == null) {
      catalog = resolveCatalog();
    }
    return catalog;
  }

  private Catalog resolveCatalog() {
    PackageManager pm = activity.getPackageManager();
    Catalog found = new Catalog();
    record(pm, found, probe(pm, Intent.CATEGORY_LEANBACK_LAUNCHER));
    record(pm, found, probe(pm, Intent.CATEGORY_LAUNCHER));
    return found;
  }

  private static List<ResolveInfo> probe(PackageManager pm, String category) {
    Intent intent = new Intent(Intent.ACTION_MAIN);
    intent.addCategory(category);
    return pm.queryIntentActivities(intent, 0);
  }

  private void record(PackageManager pm, Catalog found, List<ResolveInfo> infos) {
    String self = activity.getPackageName();
    for (ResolveInfo info : infos) {
      ActivityInfo target = info.activityInfo;
      if (target == null
          || !target.exported
          || !target.enabled
          || !target.applicationInfo.enabled
          || target.packageName.equals(self)) {
        continue;
      }
      // First sighting keeps priority: leanback entries are recorded before
      // generic launcher entries.
      if (found.components.containsKey(target.packageName)) {
        continue;
      }
      found.components.put(target.packageName, new ComponentName(target.packageName, target.name));
      found.titles.put(target.packageName, String.valueOf(info.loadLabel(pm)).trim());
    }
  }

  private static String error(String message) {
    try {
      return new JSONObject().put("error", message).toString();
    } catch (JSONException e) {
      return "{\"error\":" + JSONObject.quote(message) + "}";
    }
  }
}
