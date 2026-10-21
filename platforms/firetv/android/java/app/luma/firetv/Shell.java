package app.luma.firetv;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import java.io.ByteArrayOutputStream;
import java.util.HashMap;
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
  /** Encoded tile art per package; a package without art maps to null. */
  private final HashMap<String, byte[]> art = new HashMap<>();

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
        String kind = catalog().art.get(appId);
        if (kind != null) {
          app.put("art", kind);
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
    // With HomeGuard on, parking the task would only flash Amazon's home
    // before the guard brings Luma back, so Back on Luma's home stays put.
    if (HomeGuard.isEnabled(activity)) {
      return;
    }
    // Park the shell task instead of finishing it: the remote's Back key may
    // already have been handled inside the app, and a relaunch is instant.
    main.post(() -> activity.moveTaskToBack(true));
  }

  /** One entry per package; the leanback activity wins over the phone one. */
  private static final class Catalog {
    final LinkedHashMap<String, ComponentName> components = new LinkedHashMap<>();
    final LinkedHashMap<String, String> titles = new LinkedHashMap<>();
    /** {@code banner} when the app ships a TV banner, otherwise {@code icon}. */
    final HashMap<String, String> art = new HashMap<>();
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
      // Apps without their own icon get Android's generic robot, either by
      // default or by naming it in the manifest; the named tile reads better.
      if (target.banner != 0 || target.applicationInfo.banner != 0) {
        found.art.put(target.packageName, "banner");
      } else if (target.getIconResource() != 0
          && target.getIconResource() != android.R.drawable.sym_def_app_icon) {
        found.art.put(target.packageName, "icon");
      }
    }
  }

  /**
   * PNG tile art for an installed app: its TV banner (the 16:9 card Android TV
   * launchers show) or, without one, its icon. Served to the page as
   * {@code luma.local/app-art/<package>.png} by the asset client; called on
   * the WebView's IO thread, so drawing never blocks the UI.
   */
  synchronized byte[] art(String pkg) {
    if (art.containsKey(pkg)) {
      return art.get(pkg);
    }
    byte[] png = null;
    ComponentName component = catalog().components.get(pkg);
    if (component != null) {
      PackageManager pm = activity.getPackageManager();
      try {
        ActivityInfo info = pm.getActivityInfo(component, 0);
        Drawable banner = info.loadBanner(pm);
        png =
            banner != null
                ? encode(toTile(draw(banner, 480, 270)))
                : encode(draw(info.loadIcon(pm), 256, 256));
      } catch (PackageManager.NameNotFoundException | RuntimeException e) {
        Log.w(TAG, "Drawing art for " + pkg + " failed", e);
      }
    }
    art.put(pkg, png);
    return png;
  }

  /**
   * Luma's tiles are 4:3 and TV banners 16:9. The banner keeps its full width
   * and the bands above and below repeat a row just inside its top and bottom
   * edges (clear of rounded corners), so flat colours and gradients run on to
   * the tile's edge with nothing cropped.
   */
  private static Bitmap toTile(Bitmap banner) {
    if (banner == null) {
      return null;
    }
    int width = banner.getWidth();
    int height = banner.getHeight();
    int tileHeight = Math.round(width * 3f / 4f);
    if (tileHeight <= height) {
      return banner;
    }
    Bitmap tile = Bitmap.createBitmap(width, tileHeight, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(tile);
    int top = (tileHeight - height) / 2;
    int inset = Math.max(1, Math.round(height * 0.06f));
    canvas.drawBitmap(banner, new Rect(0, inset, width, inset + 1), new Rect(0, 0, width, top), null);
    canvas.drawBitmap(
        banner,
        new Rect(0, height - inset - 1, width, height - inset),
        new Rect(0, top + height, width, tileHeight),
        null);
    canvas.drawBitmap(banner, 0, top, null);
    banner.recycle();
    return tile;
  }

  private static byte[] encode(Bitmap bitmap) {
    if (bitmap == null) {
      return null;
    }
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
    bitmap.recycle();
    return out.toByteArray();
  }

  /** Draws at the drawable's own size, scaled down to fit the bounds. */
  private static Bitmap draw(Drawable drawable, int maxWidth, int maxHeight) {
    if (drawable == null) {
      return null;
    }
    int width = drawable.getIntrinsicWidth() > 0 ? drawable.getIntrinsicWidth() : maxWidth;
    int height = drawable.getIntrinsicHeight() > 0 ? drawable.getIntrinsicHeight() : maxHeight;
    float scale = Math.min(1f, Math.min((float) maxWidth / width, (float) maxHeight / height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    drawable.setBounds(0, 0, width, height);
    drawable.draw(new Canvas(bitmap));
    return bitmap;
  }

  private static String error(String message) {
    try {
      return new JSONObject().put("error", message).toString();
    } catch (JSONException e) {
      return "{\"error\":" + JSONObject.quote(message) + "}";
    }
  }
}
