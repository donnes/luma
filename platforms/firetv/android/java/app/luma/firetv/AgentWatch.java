package app.luma.firetv;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * HomeGuard's own connection to the paired T3 Code server. On a Fire TV stick
 * the low-memory killer takes Luma's WebView soon after another app comes to
 * the front, and Chromium freezes a hidden page anyway, so the page can't
 * watch agents from behind a video. This small client, in HomeGuard's
 * long-lived process, can.
 *
 * <p>It speaks the same WebSocket API as the page (src/agents/rpc.ts), but
 * subscribes only to the shell stream, and only to notice an agent that newly
 * needs you: a pending request it hasn't alerted about before, the rule of
 * src/agents/alerts.ts. Alerted request ids are kept across restarts. The page
 * hands over the pairing and the alert's words in the user's language.
 */
final class AgentWatch {

  /**
   * Called on the main thread with {@code requestId}, {@code threadId},
   * {@code headline}, {@code title}, {@code detail} and {@code source}.
   */
  interface Listener {
    void onAlert(JSONObject alert);
  }

  private static final String TAG = "luma";
  private static final String PREFS = "agent-watch";
  private static final String KEY_CONFIG = "config";
  private static final String KEY_SEEN = "seen";
  /** Request ids are never reused; the newest few hundred cover everything still pending. */
  private static final int REMEMBERED = 200;

  private static final int CONNECT_MS = 2500;
  private static final int HTTP_MS = 5000;
  /** The page's RpcSocket pings this often and gives up after this much silence. */
  private static final int PING_MS = 5000;
  private static final long SILENCE_MS = 15000;
  private static final long MAX_BACKOFF_MS = 60000;

  /** The pairing is gone or revoked; wait for the page to hand over a new one. */
  private static final class Expired extends Exception {}

  private final Handler main = new Handler(Looper.getMainLooper());
  private final SharedPreferences prefs;
  private final Listener listener;
  private volatile Thread thread;
  private volatile Socket socket;

  AgentWatch(Context context, Listener listener) {
    this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    this.listener = listener;
  }

  /** Watches with the pairing saved last time, if there is one. */
  void start() {
    String config = prefs.getString(KEY_CONFIG, null);
    if (config != null) {
      watch(config);
    }
  }

  /**
   * From the page: JSON with {@code routes} (server origins, best first),
   * {@code token}, {@code source}, {@code asked} and {@code approval}, or an
   * empty string once Luma is unpaired.
   */
  void configure(String config) {
    if (config == null || config.isEmpty()) {
      prefs.edit().remove(KEY_CONFIG).apply();
      stop();
    } else if (!config.equals(prefs.getString(KEY_CONFIG, null)) || thread == null) {
      prefs.edit().putString(KEY_CONFIG, config).apply();
      watch(config);
    }
  }

  void stop() {
    thread = null;
    closeSocket();
  }

  private void watch(String json) {
    JSONObject config;
    try {
      config = new JSONObject(json);
    } catch (JSONException e) {
      Log.w(TAG, "Ignoring an invalid agent watch", e);
      return;
    }
    stop();
    Thread next = new Thread(() -> run(config), "luma-agent-watch");
    thread = next;
    next.start();
  }

  private boolean current() {
    return thread == Thread.currentThread();
  }

  /** Tries each route in order, then backs off, until stopped or the token expires. */
  private void run(JSONObject config) {
    JSONArray routes = config.optJSONArray("routes");
    long backoff = 1000;
    while (current() && routes != null) {
      for (int index = 0; index < routes.length() && current(); index++) {
        long started = SystemClock.elapsedRealtime();
        try {
          session(routes.optString(index), config);
        } catch (Expired e) {
          Log.i(TAG, "Agent watch stopped: the pairing has expired");
          return;
        } catch (IOException | JSONException | RuntimeException e) {
          if (current()) Log.i(TAG, "Agent watch disconnected: " + e);
        }
        // A connection that held for a while resets the backoff; a flapping one doesn't.
        if (SystemClock.elapsedRealtime() - started > 30000) backoff = 1000;
      }
      SystemClock.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  // --- One connection ------------------------------------------------------

  private void session(String origin, JSONObject config)
      throws IOException, JSONException, Expired {
    String ticket = ticket(origin, config.getString("token"));
    Uri base = Uri.parse(origin);
    Uri url =
        base.buildUpon()
            .path("/ws")
            .appendQueryParameter("wsTicket", ticket)
            .appendQueryParameter("orchestrationProtocol", "2")
            .appendQueryParameter("clientSurface", "web")
            .appendQueryParameter("clientDeviceType", "unknown")
            .appendQueryParameter("connectionMethod", "direct")
            .build();
    Socket opened = open(url);
    socket = opened;
    if (!current()) {
      closeSocket();
      return;
    }
    try {
      DataInputStream in = new DataInputStream(opened.getInputStream());
      OutputStream out = opened.getOutputStream();
      send(
          out,
          new JSONObject()
              .put("_tag", "Request")
              .put("id", "1")
              .put("tag", "orchestration.subscribeShell")
              .put("payload", new JSONObject().put("requestCompletionMarker", true))
              .put("headers", new JSONArray()));
      Threads threads = new Threads(config);
      long heard = SystemClock.elapsedRealtime();
      long pinged = heard;
      while (current()) {
        String message = null;
        try {
          message = readMessage(opened, in, out);
          heard = SystemClock.elapsedRealtime();
        } catch (SocketTimeoutException quiet) {
          if (SystemClock.elapsedRealtime() - heard > SILENCE_MS) throw quiet;
        }
        if (SystemClock.elapsedRealtime() - pinged >= PING_MS) {
          send(out, new JSONObject().put("_tag", "Ping"));
          pinged = SystemClock.elapsedRealtime();
        }
        if (message != null) receive(message, out, threads);
      }
    } finally {
      if (socket == opened) closeSocket();
    }
  }

  /** The short-lived ticket the WebSocket URL carries, as the page mints it. */
  private static String ticket(String origin, String token)
      throws IOException, JSONException, Expired {
    HttpURLConnection http =
        (HttpURLConnection) new URL(origin + "api/auth/websocket-ticket").openConnection();
    try {
      http.setConnectTimeout(CONNECT_MS);
      http.setReadTimeout(HTTP_MS);
      http.setRequestMethod("POST");
      http.setRequestProperty("Authorization", "Bearer " + token);
      http.setDoOutput(true);
      http.getOutputStream().close();
      int status = http.getResponseCode();
      if (status == 401 || status == 403) throw new Expired();
      if (status / 100 != 2) throw new IOException("ticket " + status);
      try (InputStream body = http.getInputStream()) {
        return new JSONObject(readAll(body)).getString("ticket");
      }
    } finally {
      http.disconnect();
    }
  }

  private void receive(String message, OutputStream out, Threads threads)
      throws IOException, JSONException {
    Object parsed = new JSONTokener(message).nextValue();
    JSONArray messages =
        parsed instanceof JSONArray ? (JSONArray) parsed : new JSONArray().put(parsed);
    for (int index = 0; index < messages.length(); index++) {
      JSONObject item = messages.optJSONObject(index);
      if (item == null) continue;
      String tag = item.optString("_tag");
      if ("Chunk".equals(tag)) {
        // Streams wait for an Ack after every chunk.
        send(out, new JSONObject().put("_tag", "Ack").put("requestId", item.opt("requestId")));
        JSONArray values = item.optJSONArray("values");
        for (int value = 0; values != null && value < values.length(); value++) {
          JSONObject shellItem = values.optJSONObject(value);
          if (shellItem != null) alert(threads.apply(shellItem));
        }
      } else if ("Exit".equals(tag) || "Defect".equals(tag)) {
        throw new IOException("stream ended: " + tag);
      }
    }
  }

  // --- Alerts ----------------------------------------------------------------

  /**
   * Records the waiting requests and alerts about the ones not seen before.
   * With no history at all, the first snapshot only records what's waiting.
   */
  private void alert(List<JSONObject> waiting) {
    String saved = prefs.getString(KEY_SEEN, null);
    if (waiting.isEmpty() && saved != null) return;
    LinkedHashSet<String> seen = new LinkedHashSet<>();
    if (saved != null && !saved.isEmpty()) seen.addAll(Arrays.asList(saved.split("\n")));
    List<JSONObject> fresh = new ArrayList<>();
    for (JSONObject alert : waiting) {
      if (seen.add(alert.optString("requestId"))) fresh.add(alert);
    }
    if (fresh.isEmpty() && saved != null) return;
    List<String> ids = new ArrayList<>(seen);
    prefs
        .edit()
        .putString(
            KEY_SEEN,
            TextUtils.join("\n", ids.subList(Math.max(0, ids.size() - REMEMBERED), ids.size())))
        .apply();
    if (saved == null) return;
    for (JSONObject alert : fresh) {
      main.post(() -> listener.onAlert(alert));
    }
  }

  /**
   * The parts of the page's shell model (src/agents/model.ts) an alert needs:
   * project titles, and each thread's pending request while it needs you.
   */
  private static final class Threads {
    private final JSONObject config;
    private final HashMap<String, String> projects = new HashMap<>();
    private long sequence;
    private boolean ready;

    Threads(JSONObject config) {
      this.config = config;
    }

    /** Applies one stream item; returns the alerts for threads that need you in it. */
    List<JSONObject> apply(JSONObject item) {
      List<JSONObject> waiting = new ArrayList<>();
      String kind = item.optString("kind");
      if ("snapshot".equals(kind)) {
        JSONObject snapshot = item.optJSONObject("snapshot");
        if (snapshot == null) return waiting;
        JSONArray threads = snapshot.optJSONArray("threads");
        boolean refresh = ready && (threads == null || threads.length() == 0);
        // A later snapshot without threads only refreshes some projects.
        if (!refresh) projects.clear();
        JSONArray list = snapshot.optJSONArray("projects");
        for (int index = 0; list != null && index < list.length(); index++) {
          project(list.optJSONObject(index));
        }
        if (refresh) return waiting;
        sequence = snapshot.optLong("snapshotSequence");
        ready = true;
        for (int index = 0; threads != null && index < threads.length(); index++) {
          addIfWaiting(threads.optJSONObject(index), waiting);
        }
        return waiting;
      }
      if (!item.has("sequence") || item.optLong("sequence") <= sequence) return waiting;
      sequence = item.optLong("sequence");
      if ("project.updated".equals(kind)) {
        project(item.optJSONObject("project"));
      } else if ("thread.updated".equals(kind) && "active".equals(item.optString("location"))) {
        addIfWaiting(item.optJSONObject("thread"), waiting);
      }
      return waiting;
    }

    private void project(JSONObject project) {
      if (project != null) projects.put(project.optString("id"), project.optString("title"));
    }

    /** agentStatus() and visibleAgents() in src/agents/model.ts decide who needs you. */
    private void addIfWaiting(JSONObject thread, List<JSONObject> waiting) {
      if (thread == null || !thread.isNull("archivedAt") || !thread.isNull("deletedAt")) return;
      JSONObject lineage = thread.optJSONObject("lineage");
      if (lineage != null && "subagent".equals(lineage.optString("relationshipToParent"))) return;
      JSONObject request = thread.optJSONObject("pendingRuntimeRequest");
      if (request == null) return;
      String kind = request.optString("kind");
      String run =
          thread.isNull("activityRunStatus")
              ? thread.optString("status")
              : thread.optString("activityRunStatus");
      boolean active =
          run.equals("preparing")
              || run.equals("starting")
              || run.equals("running")
              || run.equals("waiting");
      boolean input =
          kind.equals("user_input") && (request.optBoolean("blocking", true) || !active);
      boolean approval = !kind.equals("user_input") && !kind.equals("auth_refresh");
      if (!input && !approval) return;
      String project = projects.get(thread.optString("projectId"));
      try {
        waiting.add(
            new JSONObject()
                .put("requestId", request.optString("id"))
                .put("threadId", thread.optString("id"))
                .put("headline", config.optString(input ? "asked" : "approval"))
                .put("title", thread.optString("title"))
                .put("detail", project == null ? "" : project)
                .put("source", config.optString("source")));
      } catch (JSONException e) {
        Log.w(TAG, "Describing an agent alert failed", e);
      }
    }
  }

  // --- A minimal WebSocket client (RFC 6455): text frames, ping and close ----

  private static Socket open(Uri url) throws IOException {
    boolean secure = "https".equals(url.getScheme());
    int port = url.getPort() > 0 ? url.getPort() : secure ? 443 : 80;
    Socket socket = new Socket();
    socket.connect(new InetSocketAddress(url.getHost(), port), CONNECT_MS);
    if (secure) {
      socket =
          ((SSLSocketFactory) SSLSocketFactory.getDefault())
              .createSocket(socket, url.getHost(), port, true);
    }
    socket.setSoTimeout(HTTP_MS);
    byte[] nonce = new byte[16];
    new SecureRandom().nextBytes(nonce);
    String request =
        "GET " + url.getEncodedPath() + "?" + url.getEncodedQuery() + " HTTP/1.1\r\n"
            + "Host: " + url.getHost() + ":" + port + "\r\n"
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Key: " + Base64.encodeToString(nonce, Base64.NO_WRAP) + "\r\n"
            + "Sec-WebSocket-Version: 13\r\n\r\n";
    OutputStream out = socket.getOutputStream();
    out.write(request.getBytes(StandardCharsets.UTF_8));
    out.flush();
    InputStream in = socket.getInputStream();
    String status = readLine(in);
    if (!status.startsWith("HTTP/1.1 101")) {
      socket.close();
      throw new IOException("upgrade refused: " + status);
    }
    while (!readLine(in).isEmpty()) {
      // Headers; the server picked no extensions since none were offered.
    }
    socket.setSoTimeout(PING_MS);
    return socket;
  }

  /**
   * The next text message; null after a control frame. Times out only while
   * waiting for a frame to start, never halfway through one.
   */
  private static String readMessage(Socket socket, DataInputStream in, OutputStream out)
      throws IOException {
    ByteArrayOutputStream text = new ByteArrayOutputStream();
    while (true) {
      socket.setSoTimeout(PING_MS);
      int first = in.read();
      if (first < 0) throw new EOFException();
      socket.setSoTimeout((int) SILENCE_MS);
      int second = in.readUnsignedByte();
      long length = second & 0x7f;
      if (length == 126) length = in.readUnsignedShort();
      else if (length == 127) length = in.readLong();
      byte[] mask = null;
      if ((second & 0x80) != 0) {
        mask = new byte[4];
        in.readFully(mask);
      }
      if (length > 32 * 1024 * 1024) throw new IOException("frame too large");
      byte[] payload = new byte[(int) length];
      in.readFully(payload);
      if (mask != null) {
        for (int index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      }
      int opcode = first & 0x0f;
      if (opcode == 0x8) throw new EOFException("closed by the server");
      if (opcode == 0x9) {
        writeFrame(out, 0xA, payload);
        if (text.size() == 0) return null;
        continue;
      }
      if (opcode == 0xA) {
        if (text.size() == 0) return null;
        continue;
      }
      text.write(payload);
      if ((first & 0x80) != 0) return new String(text.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  private static void send(OutputStream out, JSONObject message) throws IOException {
    writeFrame(out, 0x1, message.toString().getBytes(StandardCharsets.UTF_8));
  }

  /** Client frames are always masked. */
  private static void writeFrame(OutputStream out, int opcode, byte[] payload)
      throws IOException {
    ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
    frame.write(0x80 | opcode);
    if (payload.length < 126) {
      frame.write(0x80 | payload.length);
    } else if (payload.length < 65536) {
      frame.write(0x80 | 126);
      frame.write(payload.length >> 8);
      frame.write(payload.length);
    } else {
      frame.write(0x80 | 127);
      for (int shift = 56; shift >= 0; shift -= 8) {
        frame.write((int) ((long) payload.length >> shift));
      }
    }
    byte[] mask = new byte[4];
    new SecureRandom().nextBytes(mask);
    frame.write(mask);
    for (int index = 0; index < payload.length; index++) {
      frame.write(payload[index] ^ mask[index % 4]);
    }
    synchronized (out) {
      out.write(frame.toByteArray());
      out.flush();
    }
  }

  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    int value;
    while ((value = in.read()) != '\n') {
      if (value < 0) throw new EOFException();
      if (value != '\r') line.write(value);
    }
    return new String(line.toByteArray(), StandardCharsets.UTF_8);
  }

  private static String readAll(InputStream in) throws IOException {
    ByteArrayOutputStream data = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int count;
    while ((count = in.read(buffer)) > 0) data.write(buffer, 0, count);
    return new String(data.toByteArray(), StandardCharsets.UTF_8);
  }

  private void closeSocket() {
    Socket open = socket;
    socket = null;
    if (open == null) return;
    // Closing from another thread wakes a blocked read.
    new Thread(
            () -> {
              try {
                open.close();
              } catch (IOException ignored) {
                // Already gone.
              }
            })
        .start();
  }
}
