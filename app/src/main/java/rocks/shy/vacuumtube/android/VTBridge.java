package rocks.shy.vacuumtube.android;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.util.UUID;

/**
 * The native half of `require('electron')` for the ported preload (see tools/shims/electron.js).
 *
 * JavaScript calls arrive on the WebView JavaBridge thread; every @JavascriptInterface method is
 * therefore safe to block. Values are exchanged as JSON text so the JS side never has to guess.
 * Channel names follow the shipped app exactly (rea-work/census.md §3): src/index.js:244-312 and
 * src/updater.js / src/permissions.js / src/userstyles.js.
 */
public class VTBridge {

    static final String TAG = "VacuumTube";
    static final String PROJECT_URL = "https://github.com/shy1132/VacuumTube";
    static final String RELEASES_URL = "https://github.com/shy1132/VacuumTube/releases/latest";

    private static final String STARBOARD_PREFS = "vacuumtube-ui";
    private static final String STARBOARD_KEY = "starboard_input";

    private final MainActivity activity;
    private final VTConfig config;
    private WebView webView;

    public VTBridge(MainActivity activity, VTConfig config) {
        this.activity = activity;
        this.config = config;
    }

    void attachWebView(WebView webView) {
        this.webView = webView;
    }

    // ------------------------------------------------------------------ ipcRenderer.sendSync

    @JavascriptInterface
    public String sendSync(String channel, String payloadJson) {
        try {
            switch (channel) {
                case "get-config":
                    return config.get().toString();
                case "set-config": {
                    JSONObject patch = payloadJson == null ? new JSONObject() : new JSONObject(payloadJson);
                    JSONObject updated = config.update(patch);
                    // Mirrors src/index.js:248-261: persist, then push the merged config to the page.
                    postToPage("config-update", updated.toString());
                    return updated.toString();
                }
                case "can-auto-update":
                    return "false"; // APKs are updated by the user/Play, not by electron-updater
                default:
                    Log.w(TAG, "VTBridge: unhandled sendSync channel '" + channel + "'");
                    return "null";
            }
        } catch (Exception err) {
            Log.e(TAG, "VTBridge: sendSync '" + channel + "' failed", err);
            return "null";
        }
    }

    @JavascriptInterface
    public void send(String channel, String payloadJson) {
        Log.d(TAG, "VTBridge: send('" + channel + "') is not used by the ported preload");
    }

    // ------------------------------------------------------------------ ipcRenderer.invoke

    @JavascriptInterface
    public void invoke(String channel, String payloadJson, String callbackId) {
        Object payload = parse(payloadJson);
        try {
            switch (channel) {
                case "get-deeplink":
                    resolve(callbackId, activity.getPendingDeeplink());
                    break;
                case "is-steam":
                    resolve(callbackId, Boolean.FALSE);
                    break;
                case "reload":
                    activity.reloadPage();
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "set-fullscreen":
                    activity.setFullscreen(asBoolean(payload, true));
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "set-on-top":
                    // No desktop window to pin on Android; accepted for schema compatibility.
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "relaunch-app":
                    activity.runOnUiThread(activity::recreate);
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "get-userstyles":
                    resolve(callbackId, readUserstyles());
                    break;
                case "get-userstyles-path":
                    resolve(callbackId, userstylesDirectory().getAbsolutePath());
                    break;
                case "open-userstyles-folder": {
                    String path = userstylesDirectory().getAbsolutePath();
                    toast("Userstyles folder:\n" + path);
                    resolve(callbackId, path);
                    break;
                }
                case "get-about-info":
                case "check-for-updates":
                    resolve(callbackId, aboutInfo());
                    break;
                case "download-update":
                case "install-update":
                case "open-update-download":
                    openExternal(RELEASES_URL);
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "open-release-page":
                    openExternal(RELEASES_URL);
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "open-project-page":
                    openExternal(PROJECT_URL);
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "request-microphone-permission":
                    // answered asynchronously by MainActivity once the runtime dialog settles
                    activity.requestMicrophonePermission(callbackId);
                    break;
                case "get-microphone-permission-status":
                    resolve(callbackId, activity.microphoneStatus());
                    break;
                case "open-microphone-privacy-settings":
                    openAppSettings();
                    resolve(callbackId, Boolean.TRUE);
                    break;
                case "reset-microphone-permission":
                    resolve(callbackId, Boolean.TRUE);
                    break;
                default:
                    Log.w(TAG, "VTBridge: unhandled invoke channel '" + channel + "'");
                    resolve(callbackId, null);
                    break;
            }
        } catch (Exception err) {
            Log.e(TAG, "VTBridge: invoke '" + channel + "' failed", err);
            resolve(callbackId, error(err));
        }
    }

    // ------------------------------------------------------------------ plain native helpers
    // Called from the page through the same bridge object; they are not IPC channels.

    @JavascriptInterface
    public String deviceName() {
        String name = null;
        try {
            name = Settings.Global.getString(activity.getContentResolver(), "device_name");
        } catch (Throwable ignored) {
        }
        if (name == null || name.trim().isEmpty()) name = Build.MODEL;
        return name;
    }

    @JavascriptInterface
    public String deviceModel() {
        return Build.MODEL;
    }

    @JavascriptInterface
    public String deviceRelease() {
        return Build.VERSION.RELEASE;
    }

    @JavascriptInterface
    public String deviceArch() {
        String[] abis = Build.SUPPORTED_ABIS;
        return (abis != null && abis.length > 0) ? abis[0] : "arm64";
    }

    @JavascriptInterface
    public String appVersion() {
        return activity.versionName();
    }

    @JavascriptInterface
    public String randomUUID() {
        return UUID.randomUUID().toString();
    }

    @JavascriptInterface
    public String getStarboardInput() {
        return activity.getSharedPreferences(STARBOARD_PREFS, Context.MODE_PRIVATE)
                .getBoolean(STARBOARD_KEY, true) ? "true" : "false";
    }

    @JavascriptInterface
    public void setStarboardInput(String value) {
        activity.getSharedPreferences(STARBOARD_PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(STARBOARD_KEY, Boolean.parseBoolean(value)).apply();
    }

    @JavascriptInterface
    public void toast(final String message) {
        if (message == null) return;
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public void log(String tag, String message) {
        Log.d(TAG, "page[" + tag + "] " + message);
    }

    @JavascriptInterface
    public void openExternal(String url) {
        if (url == null) return;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception err) {
            Log.w(TAG, "VTBridge: cannot open " + url, err);
        }
    }

    @JavascriptInterface
    public void setClipboard(String text) {
        try {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("VacuumTube", text == null ? "" : text));
        } catch (Exception err) {
            Log.w(TAG, "VTBridge: clipboard write failed", err);
        }
    }

    @JavascriptInterface
    public String getClipboard() {
        try {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null && clipboard.hasPrimaryClip() && clipboard.getPrimaryClip() != null) {
                ClipData.Item item = clipboard.getPrimaryClip().getItemAt(0);
                return item.coerceToText(activity).toString();
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    @JavascriptInterface
    public void exitApp() {
        // modules/fix-exit.js used window.close(); the glue maps that here.
        activity.runOnUiThread(activity::finish);
    }

    // The page decides which keyboard path fits the current screen (see tools/android-glue.js):
    // an editable field means the IME can attach to the WebView, otherwise the native sink is used.

    @JavascriptInterface
    public void showKeyboard() {
        activity.showSoftKeyboard();
    }

    @JavascriptInterface
    public void showKeyboardSink() {
        activity.showKeyboardSink();
    }

    @JavascriptInterface
    public void hideKeyboard() {
        activity.hideSoftKeyboard();
    }

    @JavascriptInterface
    public void dialStart() {
        activity.getDial().start();
    }

    @JavascriptInterface
    public void dialStop() {
        activity.getDial().stop();
    }

    // ------------------------------------------------------------------ page -> native plumbing

    void postToPage(String channel, String jsonPayload) {
        String script = "window.__vtEmit(" + JSONObject.quote(channel) + "," + JSONObject.quote(jsonPayload == null ? "null" : jsonPayload) + ")";
        postScript(script);
    }

    void postScript(final String script) {
        final WebView view = webView;
        if (view == null) return;
        activity.runOnUiThread(() -> {
            try {
                view.evaluateJavascript(script, null);
            } catch (Exception err) {
                Log.w(TAG, "VTBridge: evaluateJavascript failed", err);
            }
        });
    }

    void resolve(final String callbackId, final Object value) {
        if (callbackId == null) return;
        final String json;
        if (value == null) json = "null";
        else if (value instanceof Boolean || value instanceof Number) json = value.toString();
        else if (value instanceof JSONObject || value instanceof JSONArray) json = value.toString();
        else json = JSONObject.quote(value.toString());
        postScript("window.__vtResolve(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(json) + ")");
    }

    static Object parse(String json) {
        if (json == null || json.isEmpty() || "null".equals(json)) return null;
        try {
            return new org.json.JSONTokener(json).nextValue();
        } catch (JSONException err) {
            return json;
        }
    }

    private static boolean asBoolean(Object value, boolean fallback) {
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return Boolean.parseBoolean((String) value);
        return fallback;
    }

    private static JSONObject error(Exception err) {
        JSONObject json = new JSONObject();
        try {
            json.put("__vtError", err.getClass().getSimpleName() + ": " + err.getMessage());
        } catch (JSONException ignored) {
        }
        return json;
    }

    // ------------------------------------------------------------------ misc

    private JSONObject aboutInfo() {
        JSONObject json = new JSONObject();
        try {
            // settings/pages/about.js builds the page from these fields; "unsupported" is the
            // updater state that tells the user to update manually (updates ship as an APK).
            json.put("status", "unsupported");
            json.put("currentVersion", activity.versionName());
            json.put("latestVersion", "");
            json.put("platform", "android");
            json.put("arch", deviceArch());
            json.put("installationType", "unknown");
            json.put("canAutoUpdate", false);
            json.put("progress", JSONObject.NULL);
        } catch (JSONException ignored) {
        }
        return json;
    }

    File userstylesDirectory() {
        File dir = new File(activity.getFilesDir(), "userstyles");
        if (!dir.exists() && !dir.mkdirs()) Log.w(TAG, "could not create " + dir);
        return dir;
    }

    private JSONArray readUserstyles() {
        JSONArray array = new JSONArray();
        File dir = userstylesDirectory();
        File[] files = dir.listFiles((d, name) -> name.toLowerCase().endsWith(".css"));
        if (files == null) return array;
        for (File file : files) {
            try (Reader reader = new InputStreamReader(new FileInputStream(file), "UTF-8")) {
                StringBuilder builder = new StringBuilder();
                char[] buffer = new char[8192];
                int read;
                while ((read = reader.read(buffer)) > 0) builder.append(buffer, 0, read);
                JSONObject entry = new JSONObject();
                entry.put("filename", file.getName());
                entry.put("css", builder.toString());
                array.put(entry);
            } catch (Exception err) {
                Log.w(TAG, "could not read userstyle " + file.getName(), err);
            }
        }
        return array;
    }

    private void openAppSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception err) {
            Log.w(TAG, "could not open app settings", err);
        }
    }

    boolean hasMicrophonePermission() {
        return activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }
}
