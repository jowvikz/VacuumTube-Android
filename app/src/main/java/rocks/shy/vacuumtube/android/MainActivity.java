package rocks.shy.vacuumtube.android;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Hosts the ported VacuumTube experience: a WebView showing YouTube Leanback (the TV surface) with
 * the reverse-engineered preload bundle injected at document-start, plus the native equivalents of
 * the Electron facilities the original relied on (window lifecycle, permissions, DIAL, deep links).
 */
public class MainActivity extends Activity {

    private static final String TAG = "VacuumTube";
    private static final String START_URL = "https://www.youtube.com/tv";
    private static final int MIC_REQUEST_CODE = 4001;
    private static final long EXIT_BACK_WINDOW_MS = 2500L;
    /** Bumped when a port-level default changes and must be applied to existing installs. */
    private static final int ANDROID_CONFIG_VERSION = 3;

    private VTConfig config;
    private VTBridge bridge;
    private VtDial dial;
    private WebView webView;
    private VTWebViewClient webViewClient;
    private FrameLayout root;
    private AspectFrameLayout stage;
    private TextView statusView;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private EditText imeSink;
    private String imeSinkPrevious = "";
    private boolean imeSinkSuppressed;
    private boolean imeBarVisible;

    private String pendingDeeplink;
    private long lastBackAt;
    private String pendingMicCallbackId;
    private boolean updateStateSent;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences("vacuumtube", MODE_PRIVATE);
        boolean freshInstall = !prefs.contains("config");

        config = new VTConfig(this);

        // Port-level defaults, applied once per install/upgrade without touching the user's own
        // choices afterwards:
        //   fullscreen          - the desktop app is a window, this is an edge-to-edge TV surface
        //   android_full_bleed  - YouTube renders a fixed 16:9 rem stage (80rem x 45rem); anchoring it
        //                         to the viewport is what removes the side gutters on a phone
        //   features_enabled/ultrawide_feature
        //                       - v2 used the upstream experimental feature for that; v3 does it in the
        //                         port (the feature forgets #app-background), so upstream defaults return
        int storedConfigVersion = prefs.getInt("android_config_version", 0);
        if (freshInstall || storedConfigVersion < ANDROID_CONFIG_VERSION) {
            config.putBoolean("fullscreen", true);
            config.putBoolean("android_full_bleed", true);
            config.putBoolean("features_enabled", false);
            config.putBoolean("ultrawide_feature", false);
            prefs.edit().putInt("android_config_version", ANDROID_CONFIG_VERSION).apply();
        }

        // Android 11+: the IME must be told the window resizes, otherwise it can fail to appear
        // over immersive content.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);

        bridge = new VTBridge(this, config);
        dial = new VtDial(this, config.get().optString("sponsorblock_uuid", java.util.UUID.randomUUID().toString()));
        pendingDeeplink = normalizeDeeplink(getIntent());

        buildInterface();
        applyImmersive();

        // Predictive back (API 33+): registered so the gesture keeps working if the platform routes
        // BACK through OnBackInvokedDispatcher instead of onBackPressed(). Both paths call handleBack().
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                        android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
            } catch (Exception err) {
                Log.w(TAG, "could not register the back-invoked callback", err);
            }
        }

        webView.loadUrl(START_URL);
    }

    private void buildInterface() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#000000"));

        // Edge to edge by default. AspectFrameLayout (the desktop app's 16:9 lock) is only used when
        // explicitly requested through the android_letterbox flag.
        ViewGroup webHost = root;
        if (config.getBoolean("android_letterbox", false)) {
            stage = new AspectFrameLayout(this);
            stage.setAspect(16f / 9f);
            root.addView(stage, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            webHost = stage;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#000000"));
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        WebView.setWebContentsDebuggingEnabled(true);
        configureWebView(webView);
        webHost.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusView = new TextView(this);
        statusView.setText(getString(R.string.loading));
        statusView.setTextColor(Color.parseColor("#e8e8e8"));
        statusView.setTextSize(20f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setBackgroundColor(Color.parseColor("#282828"));
        statusView.setPadding(48, 48, 48, 48);
        root.addView(statusView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        createImeSink();
        createNativeSettingsButton();

        setContentView(root);
        webView.requestFocus();
    }

    /**
     * A small native entry point for the settings. The page-side buttons live inside the WebView, so
     * they can be affected by anything the page does (z-index, touch capture, a module that failed to
     * initialise); this one is an ordinary Android view and always receives the tap. Tap = open
     * settings, long-press = show the page diagnostics.
     */
    private void createNativeSettingsButton() {
        TextView button = new TextView(this);
        button.setText("VT");
        button.setTextColor(Color.WHITE);
        button.setTextSize(12f);
        button.setGravity(Gravity.CENTER);
        button.setBackgroundColor(Color.parseColor("#99202020"));
        button.setAlpha(0.5f);

        int size = dp(36);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(size, size, Gravity.TOP | Gravity.START);
        params.setMargins(dp(6), dp(6), 0, 0);

        button.setOnClickListener(view ->
                bridge.postScript("window.__vtToggleSettings && window.__vtToggleSettings()"));
        button.setOnLongClickListener(view -> {
            bridge.postScript("window.__vtShowDiagnostics ? window.__vtShowDiagnostics() : null");
            return true;
        });

        root.addView(button, params);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false); // Leanback autoplays the TV UI
        settings.setUserAgentString(VTWebViewClient.userAgent(versionName()));
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(view, true);

        webViewClient = new VTWebViewClient(this, bridge, settings.getUserAgentString());
        view.setWebViewClient(webViewClient);
        view.setWebChromeClient(new ChromeClient());
        bridge.attachWebView(view);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String deeplink = normalizeDeeplink(intent);
        if (deeplink != null) {
            // Mirrors src/index.js:68-81: the running instance receives the deep link.
            pendingDeeplink = deeplink;
            bridge.postToPage("deeplink", JSONObject.quote(deeplink));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
        bridge.postToPage("focus", "null");
    }

    @Override
    protected void onPause() {
        super.onPause();
        // modules/pause-on-blur.js and util/controller.js consume these.
        bridge.postToPage("blur", "null");
        if (customView != null) ((ChromeClient) webView.getWebChromeClient()).hideCustomView();
    }

    @Override
    protected void onDestroy() {
        if (dial != null) dial.stop();
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        bridge.postToPage(hasFocus ? "focus" : "blur", "null");
        if (hasFocus) applyImmersive();
    }

    // ------------------------------------------------------------------ window / input

    private boolean wantImmersive() {
        return config.getBoolean("fullscreen", true);
    }

    private void applyImmersive() {
        Window window = getWindow();
        boolean immersive = wantImmersive();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                if (immersive) {
                    controller.hide(android.view.WindowInsets.Type.systemBars());
                    controller.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    controller.show(android.view.WindowInsets.Type.systemBars());
                }
            }
        } else {
            View decor = window.getDecorView();
            if (immersive) {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void setFullscreen(boolean value) {
        config.putBoolean("fullscreen", value);
        runOnUiThread(() -> {
            applyImmersive();
            bridge.postToPage("config-update", config.get().toString());
        });
    }

    // ------------------------------------------------------------------ soft keyboard (IME)

    /**
     * The Leanback search screen draws its own letter grid and leaves no focused editable element,
     * so Chromium never raises the system keyboard by itself. Two paths are provided:
     *   1. {@link #showSoftKeyboard()}  - focus the page's own field and attach the IME to the WebView
     *   2. {@link #showKeyboardSink()}  - type into a slim native bar whose edits are forwarded in
     * Path 1 is asked for first and path 2 takes over automatically when the IME does not attach.
     */
    private void createImeSink() {
        imeSink = new EditText(this);
        imeSink.setSingleLine(true);
        imeSink.setHint(R.string.search_hint);
        imeSink.setHintTextColor(Color.parseColor("#9e9e9e"));
        imeSink.setTextColor(Color.WHITE);
        imeSink.setTextSize(18f);
        imeSink.setBackgroundColor(Color.parseColor("#e6181818"));
        imeSink.setPadding(32, 24, 32, 24);
        imeSink.setImeOptions(EditorInfo.IME_ACTION_SEARCH | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        // Append-only edits keep the delta logic below deterministic (no autocorrect rewrites).
        imeSink.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        imeSink.setVisibility(View.GONE);
        imeSink.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) {
                if (imeSinkSuppressed) return;
                String now = s.toString();
                String before = imeSinkPrevious == null ? "" : imeSinkPrevious;
                if (now.equals(before)) return;
                if (now.length() > before.length() && now.startsWith(before)) {
                    injectText(now.substring(before.length()));
                } else if (now.length() < before.length() && before.startsWith(now)) {
                    for (int i = 0; i < before.length() - now.length(); i++) sendBackspace();
                } else {
                    for (int i = 0; i < before.length(); i++) sendBackspace();
                    if (!now.isEmpty()) injectText(now);
                }
                imeSinkPrevious = now;
            }
        });
        imeSink.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                sendEnter();
                hideSoftKeyboard(false); // submitting is not a dismissal: keep auto-raise available
                return true;
            }
            return false;
        });

        root.addView(imeSink, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
    }

    /** Path 1: let Chromium own the input, used when the page really does have a visible field. */
    void showSoftKeyboard() {
        runOnUiThread(() -> {
            if (webView == null) return;
            webView.requestFocus();
            InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (manager == null) return;
            webView.postDelayed(() -> manager.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT), 60);
            // InputMethodManager.isActive(view) reports the *last* active view, so it cannot prove
            // the keyboard is on screen; the window insets can. Fall back to the sink if the IME
            // really did not appear.
            webView.postDelayed(() -> {
                if (!isImeVisible() && !imeBarVisible) showKeyboardSink();
            }, 700);
        });
    }

    /** True when the IME window is actually visible (not merely "the active view"). */
    private boolean isImeVisible() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
                return insets != null && insets.isVisible(android.view.WindowInsets.Type.ime());
            }
            android.graphics.Rect visibleFrame = new android.graphics.Rect();
            getWindow().getDecorView().getWindowVisibleDisplayFrame(visibleFrame);
            int screenHeight = getWindow().getDecorView().getRootView().getHeight();
            return screenHeight > 0 && (screenHeight - visibleFrame.bottom) > screenHeight * 0.15;
        } catch (Exception err) {
            return false;
        }
    }

    /** Path 2: a real EditText, so the keyboard always opens; edits are forwarded into the page. */
    void showKeyboardSink() {
        runOnUiThread(() -> {
            if (imeSink == null) return;
            imeBarVisible = true;
            imeSink.setVisibility(View.VISIBLE);
            imeSink.requestFocus();
            imeSink.setSelection(imeSink.getText().length());
            imeSink.postDelayed(() -> {
                InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (manager != null) manager.showSoftInput(imeSink, InputMethodManager.SHOW_IMPLICIT);
            }, 60);
        });
    }

    void hideSoftKeyboard() {
        hideSoftKeyboard(true);
    }

    void hideSoftKeyboard(boolean userDismissed) {
        runOnUiThread(() -> {
            imeBarVisible = false;
            if (imeSink != null) {
                InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (manager != null) manager.hideSoftInputFromWindow(imeSink.getWindowToken(), 0);
                imeSinkSuppressed = true;
                imeSink.setText("");
                imeSinkPrevious = "";
                imeSinkSuppressed = false;
                imeSink.setVisibility(View.GONE);
            }
            if (webView != null) webView.requestFocus();
            if (userDismissed) {
                // Tells the page not to auto-raise the keyboard again for the same screen.
                bridge.postScript("window.__vtImeDismissed && window.__vtImeDismissed()");
            }
        });
    }

    private void injectText(String text) {
        if (text == null || text.isEmpty()) return;
        bridge.postScript("window.__vtInjectText && window.__vtInjectText(" + JSONObject.quote(text) + ")");
    }

    private void sendBackspace() {
        bridge.postScript("window.__vtBackspace && window.__vtBackspace()");
    }

    private void sendEnter() {
        bridge.postScript("window.__vtEnter && window.__vtEnter()");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * Gesture navigation and the three-button bar deliver BACK through onBackPressed(), not as a
     * KeyEvent — that is why the swipe-to-go-back gesture did nothing on device. API 33+ also gets a
     * callback so predictive back works if the platform ever enables it for this app.
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    /**
     * BACK is owned by the TV surface, exactly like on a real TV device: the Starboard BACK code
     * (32769, see modules/touch-support.js:22-27) leaves the player, closes a popup or goes up a
     * screen, and the page's own EXIT_APP flow maps to window.close() -> exitApp(). A second press
     * within the window is the Android way out of the app.
     */
    private void handleBack() {
        if (imeBarVisible) {
            hideSoftKeyboard();
            return;
        }

        long now = System.currentTimeMillis();
        if ((now - lastBackAt) < EXIT_BACK_WINDOW_MS) {
            finish();
            return;
        }
        lastBackAt = now;

        bridge.postScript("if(window.__vtStarboardKey){window.__vtStarboardKey(32769,'keydown');window.__vtStarboardKey(32769,'keyup');}");

        // The SPA keeps its own history, so only hint at exiting when there is nowhere left to go.
        if (webView == null || !webView.canGoBack()) {
            Toast.makeText(this, R.string.back_again_to_exit, Toast.LENGTH_SHORT).show();
        }
    }

    // ------------------------------------------------------------------ hooks used by the client / bridge

    String versionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "2.0.0-android" : info.versionName;
        } catch (Exception err) {
            return "2.0.0-android";
        }
    }

    String bridgeDeviceName() {
        return bridge.deviceName();
    }

    VtDial getDial() {
        return dial;
    }

    String getPendingDeeplink() {
        return pendingDeeplink;
    }

    void reloadPage() {
        // modules/fix-reloads.js asks the host to reload so the injected bundle is re-applied.
        runOnUiThread(() -> {
            if (webView != null) webView.reload();
        });
    }

    void onPageLoaded(String url) {
        runOnUiThread(() -> {
            // D-pad/remote key events only reach the page when the WebView owns focus.
            if (webView != null) webView.requestFocus();
            if (statusView != null && url != null && url.contains("youtube.com/tv")) {
                statusView.setVisibility(View.GONE);
            }
            if (!updateStateSent) {
                updateStateSent = true;
                // settings/pages/about.js listens for this and refreshes the About page.
                bridge.postToPage("update-state-changed", aboutState());
            }
        });
    }

    void onLoadFailed(int code, String description) {
        runOnUiThread(() -> {
            if (statusView == null) return;
            statusView.setVisibility(View.VISIBLE);
            statusView.setText(getString(R.string.load_failed, code, description == null ? "" : description));
        });
    }

    private String aboutState() {
        JSONObject json = new JSONObject();
        try {
            json.put("status", "unsupported");
            json.put("currentVersion", versionName());
            json.put("latestVersion", "");
            json.put("platform", "android");
            json.put("arch", bridge.deviceArch());
            json.put("installationType", "unknown");
            json.put("canAutoUpdate", false);
            json.put("progress", JSONObject.NULL);
        } catch (Exception ignored) {
        }
        return json.toString();
    }

    // ------------------------------------------------------------------ permissions

    void requestMicrophonePermission(String callbackId) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            bridge.resolve(callbackId, "granted");
            return;
        }
        pendingMicCallbackId = callbackId;
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_REQUEST_CODE);
    }

    String microphoneStatus() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != MIC_REQUEST_CODE) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (pendingMicCallbackId != null) {
            bridge.resolve(pendingMicCallbackId, granted ? "granted" : "denied");
            pendingMicCallbackId = null;
        }
    }

    // ------------------------------------------------------------------ DIAL dispatch

    /**
     * Called on a DIAL HTTP worker thread; blocks until the page answers (or 4 s), because the
     * original in-page server answered synchronously from Leanback's registered handlers.
     */
    String dispatchDial(String appName, String method, String path, String body, String host) {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] result = new String[1];

        runOnUiThread(() -> {
            if (webView == null) {
                latch.countDown();
                return;
            }
            String script = "window.__vtDialDispatch ? window.__vtDialDispatch("
                    + JSONObject.quote(appName) + "," + JSONObject.quote(method) + ","
                    + JSONObject.quote(path) + "," + JSONObject.quote(body == null ? "" : body) + ","
                    + JSONObject.quote(host == null ? "" : host) + ") : null";
            webView.evaluateJavascript(script, value -> {
                result[0] = unwrapJsString(value);
                latch.countDown();
            });
        });

        try {
            if (!latch.await(4, TimeUnit.SECONDS)) return null;
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            return null;
        }
        return result[0];
    }

    /** evaluateJavascript returns a JSON-encoded value; our page returns a JSON string. */
    private static String unwrapJsString(String raw) {
        if (raw == null || "null".equals(raw)) return null;
        try {
            Object value = new JSONTokener(raw).nextValue();
            return value instanceof String ? (String) value : String.valueOf(value);
        } catch (Exception err) {
            return raw;
        }
    }

    // ------------------------------------------------------------------ deep links

    /** Port of src/index.js:515-544 (youtu.be shortening and scheme-less links). */
    static String normalizeDeeplink(Intent intent) {
        if (intent == null) return null;
        Uri data = intent.getData();
        if (data == null) {
            String extra = intent.getStringExtra("deeplink");
            return extra == null ? null : normalizeDeeplink(extra);
        }
        String scheme = data.getScheme();
        if (scheme != null && scheme.equals("vacuumtube")) {
            String query = data.getQueryParameter("url");
            if (query != null) return normalizeDeeplink(query);
            String rest = data.getSchemeSpecificPart();
            return rest == null || rest.isEmpty() ? null : normalizeDeeplink(rest.replaceFirst("^//", ""));
        }
        return normalizeDeeplink(data.toString());
    }

    static String normalizeDeeplink(String deeplink) {
        if (deeplink == null) return null;
        String value = deeplink.trim();
        if (value.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(value.matches("(?i)^[a-z]+://.*") ? value : "https://" + value);
            String host = uri.getHost();
            if (host == null) return value;
            if (host.equals("youtu.be") || host.equals("www.youtu.be")) {
                String path = uri.getPath();
                if (path == null || path.length() < 2) return value;
                String videoId = path.substring(1);
                int slash = videoId.indexOf('/');
                if (slash >= 0) videoId = videoId.substring(0, slash);
                return "https://www.youtube.com/watch?v=" + videoId;
            }
            return value;
        } catch (Exception err) {
            return value;
        }
    }

    // ------------------------------------------------------------------ web chrome

    private class ChromeClient extends WebChromeClient {

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            boolean audio = false;
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
            }
            if (audio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                request.deny();
                if (audio) requestMicrophonePermission(null);
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            webView.setVisibility(View.GONE);
            applyImmersive();
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        void hideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            webView.setVisibility(View.VISIBLE);
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
            applyImmersive();
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            // Leanback occasionally opens windows (account flows). Trampoline the target URL into
            // the main WebView so the injected bundle stays in control of the session.
            final WebView carrier = new WebView(MainActivity.this);
            carrier.setWebViewClient(new android.webkit.WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView ignored, android.webkit.WebResourceRequest request) {
                    final String target = request.getUrl() == null ? null : request.getUrl().toString();
                    if (target != null) runOnUiThread(() -> webView.loadUrl(target));
                    return true;
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView ignored, String url) {
                    if (url != null) runOnUiThread(() -> webView.loadUrl(url));
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(carrier);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onProgressChanged(WebView view, int progress) {
            if (statusView != null && statusView.getVisibility() == View.VISIBLE && progress > 30) {
                // keep the hint visible until the TV surface actually finished loading
                statusView.setText(getString(R.string.loading));
            }
        }

        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
            Log.d(TAG, "page: " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
            return true;
        }
    }
}
