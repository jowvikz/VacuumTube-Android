package rocks.shy.vacuumtube.android;

import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Document-start injection + UA/CSP rewriting, i.e. everything the Electron main process did for
 * the web surface before the preload ran:
 *
 *   - src/ua.js:63-109        the Cobalt 27 identity that makes YouTube serve the Leanback (TV) app
 *   - src/index.js:157-162    cancelling csp.withgoogle.com
 *   - src/index.js:165-233    Content-Security-Policy rewriting (Trusted Types, style/font/
 *                             connect/img-src allowlists for userstyles, SponsorBlock, DeArrow, RYD)
 *   - src/index.js:355-362    preload executes in the page world before any page script
 *
 * A WebView exposes no header callback, so the main-frame (and sub-frame) HTML document is fetched
 * here, rewritten, and returned as the response for the navigation. Everything else passes through
 * untouched, which keeps media/range requests, streaming and caching on the normal path.
 */
public class VTWebViewClient extends WebViewClient {

    private static final String TAG = "VacuumTube";
    static final String BUNDLE_ASSET = "vt/preload.bundle.js";

    /**
     * Cobalt identity built the way src/ua.js builds it (src/ua.js:61-63), with the Android host
     * details substituted. YouTube parses brand=VacuumTube, model=Android, browser=Cobalt,
     * platform=DESKTOP — the same platform class the desktop build presents, which is what keeps
     * YouTube on non-DRM playback paths that a WebView can actually play.
     */
    static String userAgent(String appVersion) {
        int year = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR);
        String arch = "arm64";
        String[] abis = Build.SUPPORTED_ABIS;
        if (abis != null && abis.length > 0) {
            String abi = abis[0];
            if (abi.contains("arm64")) arch = "arm64";
            else if (abi.contains("x86_64")) arch = "x8664";
            else if (abi.contains("x86")) arch = "x86";
            else arch = abi.replaceAll("[^a-zA-Z0-9]", "");
        }
        return "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + ") "
                + "Cobalt/27.lts.3.1040976-gold (unlike Gecko) v8/13.8.258.54-jit gles Starboard/18, "
                + "VacuumTube_DESKTOP_" + arch + "_" + year + "/" + appVersion
                + " (VacuumTube, Android) rocks.shy.vacuumtube.android/" + appVersion;
    }

    private final MainActivity activity;
    private final VTBridge bridge;
    private final String userAgent;

    private volatile String bundle;
    private volatile String injectedMainFrameUrl;
    private volatile boolean documentInjectedForCurrentNavigation;

    VTWebViewClient(MainActivity activity, VTBridge bridge, String userAgent) {
        this.activity = activity;
        this.bridge = bridge;
        this.userAgent = userAgent;
    }

    // ------------------------------------------------------------------ interception

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        try {
            Uri url = request.getUrl();
            if (url == null) return null;
            String scheme = url.getScheme();
            String host = url.getHost();
            if (scheme == null || host == null) return null;
            if (!scheme.equals("https") && !scheme.equals("http")) return null;

            // src/index.js:157-162 — CSP reporting endpoint for the Cobalt engine.
            if (host.equals("csp.withgoogle.com")) {
                return new WebResourceResponse("text/plain", "utf-8", 200, "OK",
                        new HashMap<>(), new ByteArrayInputStream(new byte[0]));
            }

            if (!isYouTubeHost(host)) return null;
            if (!request.isForMainFrame() && !acceptsHtml(request)) return null;
            // Only documents we can re-issue faithfully: a POST body would be lost, so let those
            // through untouched (they then get the post-load fallback injection in onPageFinished).
            if (request.getMethod() != null && !"GET".equalsIgnoreCase(request.getMethod())) return null;

            return fetchAndRewrite(url, request);
        } catch (Exception err) {
            Log.w(TAG, "shouldInterceptRequest failed, falling back to the network", err);
            return null;
        }
    }

    private static boolean isYouTubeHost(String host) {
        return host.equals("youtube.com") || host.endsWith(".youtube.com");
    }

    private static boolean acceptsHtml(WebResourceRequest request) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return false;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if ("accept".equalsIgnoreCase(entry.getKey()) && entry.getValue() != null) {
                return entry.getValue().toLowerCase(Locale.US).contains("text/html");
            }
        }
        return false;
    }

    private WebResourceResponse fetchAndRewrite(Uri url, WebResourceRequest request) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url.toString()).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(20000);
            connection.setRequestMethod(request.getMethod() == null ? "GET" : request.getMethod());
            connection.setRequestProperty("User-Agent", userAgent);
            connection.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            connection.setRequestProperty("Accept-Language", Locale.getDefault().toLanguageTag() + ",en;q=0.8");
            connection.setRequestProperty("Accept-Encoding", "identity"); // keep bodies readable
            // Cobalt client hints (src/ua.js:80-91)
            connection.setRequestProperty("sec-ch-ua", "\"VacuumTube\";v=\"27\"");
            connection.setRequestProperty("sec-ch-ua-mobile", "?0");
            connection.setRequestProperty("sec-ch-ua-platform", "\"Starboard\"");
            connection.setRequestProperty("sec-ch-ua-arch", "\"arm\"");
            connection.setRequestProperty("sec-ch-ua-bitness", "\"64\"");
            connection.setRequestProperty("sec-ch-ua-model", "\"\"");
            connection.setRequestProperty("sec-ch-ua-wow64", "?0");

            String cookie = CookieManager.getInstance().getCookie(url.toString());
            if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);

            // forward conditional/range headers the WebView sent
            Map<String, String> incoming = request.getRequestHeaders();
            if (incoming != null) {
                for (String name : new String[]{"If-None-Match", "If-Modified-Since", "Range"}) {
                    for (Map.Entry<String, String> entry : incoming.entrySet()) {
                        if (name.equalsIgnoreCase(entry.getKey()) && entry.getValue() != null) {
                            connection.setRequestProperty(name, entry.getValue());
                        }
                    }
                }
            }

            int status = connection.getResponseCode();
            String reason = connection.getResponseMessage();
            Map<String, String> headers = new HashMap<>();
            List<String> cspValues = new java.util.ArrayList<>();
            Map<String, List<String>> responseHeaders = connection.getHeaderFields();
            for (Map.Entry<String, List<String>> entry : responseHeaders.entrySet()) {
                String name = entry.getKey();
                if (name == null) continue;
                if (name.equalsIgnoreCase("Content-Length") || name.equalsIgnoreCase("Content-Encoding")
                        || name.equalsIgnoreCase("Transfer-Encoding") || name.equalsIgnoreCase("Connection")) {
                    continue;
                }
                // youtube.com/tv sends several CSP headers; a WebResourceResponse can only carry one,
                // so they are merged by VtCsp (never naively joined, which would drop directives).
                if (name.equalsIgnoreCase("Content-Security-Policy")) {
                    cspValues.addAll(entry.getValue());
                    continue;
                }
                if (name.equalsIgnoreCase("Content-Security-Policy-Report-Only")) {
                    continue; // src/index.js:169
                }
                if (name.equalsIgnoreCase("Set-Cookie")) {
                    // The WebView will not see these (we replaced the response), so persist them.
                    for (String value : entry.getValue()) CookieManager.getInstance().setCookie(url.toString(), value);
                    continue;
                }
                if (!entry.getValue().isEmpty()) headers.put(name, entry.getValue().get(0));
            }

            if (status >= 300 && status < 400) {
                // Let the WebView follow the redirect itself so its history/cookies stay correct.
                return new WebResourceResponse(contentType(headers), "utf-8", status,
                        reason == null ? "Redirect" : reason, headers, new ByteArrayInputStream(new byte[0]));
            }

            byte[] body = readAll(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            String type = contentType(headers);
            if (type == null || !type.toLowerCase(Locale.US).contains("text/html")) {
                return new WebResourceResponse(type == null ? "application/octet-stream" : type, null,
                        status, reason == null ? "OK" : reason, headers, new ByteArrayInputStream(body));
            }

            String html = new String(body, StandardCharsets.UTF_8);
            String nonce = newNonce();
            html = VtCsp.injectBundle(html, bundleContents(), nonce);
            if (!cspValues.isEmpty()) {
                headers.put("Content-Security-Policy", VtCsp.merge(cspValues, nonce));
            }

            byte[] rewritten = html.getBytes(StandardCharsets.UTF_8);
            if (request.isForMainFrame()) {
                documentInjectedForCurrentNavigation = true;
                injectedMainFrameUrl = url.toString();
            }
            return new WebResourceResponse("text/html", "utf-8", status, reason == null ? "OK" : reason,
                    headers, new ByteArrayInputStream(rewritten));
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readAll(InputStream stream) throws Exception {
        if (stream == null) return new byte[0];
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    private static String contentType(Map<String, String> headers) {
        String key = findHeaderKey(headers, "Content-Type");
        return key == null ? null : headers.get(key);
    }

    private static String findHeaderKey(Map<String, String> headers, String name) {
        for (String key : headers.keySet()) {
            if (key.equalsIgnoreCase(name)) return key;
        }
        return null;
    }

    // ------------------------------------------------------------------ HTML injection

    private String newNonce() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte value : bytes) builder.append(String.format(Locale.US, "%02x", value));
        return builder.toString();
    }

    /** The bundle text, read from assets once (386 KiB) and kept for every navigation. */
    private String bundleContents() {
        String current = bundle;
        if (current == null) {
            synchronized (this) {
                if (bundle == null) bundle = readBundle();
                current = bundle;
            }
        }
        return current;
    }

    private String readBundle() {
        try (InputStream input = activity.getAssets().open(BUNDLE_ASSET)) {
            byte[] bytes = readAll(input);
            Log.i(TAG, "loaded " + BUNDLE_ASSET + " (" + bytes.length + " bytes)");
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Exception err) {
            Log.e(TAG, "could not read " + BUNDLE_ASSET, err);
            return "";
        }
    }

    // ------------------------------------------------------------------ navigation callbacks

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        if (url != null && !url.equals(injectedMainFrameUrl)) documentInjectedForCurrentNavigation = false;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        activity.onPageLoaded(url);

        if (url == null || !url.contains("youtube.com/tv")) return;
        if (documentInjectedForCurrentNavigation) return;

        // Fallback: the document was not served through shouldInterceptRequest (redirect chain,
        // service worker cache, ...), so inject late rather than not at all.
        Log.w(TAG, "no document interception for " + url + " — injecting the bundle post-load");
        String current = bundle != null ? bundle : (bundle = readBundle());
        view.evaluateJavascript("if(!window.__vtLoaded){" + current + "}", null);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null) return false;
        if (scheme.equals("http") || scheme.equals("https")) {
            if (host != null && (host.endsWith("youtube.com") || host.endsWith("youtu.be") || host.endsWith("google.com")
                    || host.endsWith("googleapis.com") || host.endsWith("gstatic.com") || host.endsWith("ggpht.com")
                    || host.endsWith("ytimg.com") || host.endsWith("googlevideo.com") || host.endsWith("googleusercontent.com"))) {
                return false; // keep the TV surface inside the WebView, as VacuumTube does
            }
            bridge.openExternal(uri.toString());
            return true;
        }
        try {
            activity.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, uri));
        } catch (Exception err) {
            Log.w(TAG, "cannot handle " + uri, err);
        }
        return true;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
        if (request != null && request.isForMainFrame()) {
            int code = error == null ? -1 : error.getErrorCode();
            CharSequence description = error == null ? "" : error.getDescription();
            Log.w(TAG, "main frame error " + code + " " + description + " for " + (request.getUrl()));
            activity.onLoadFailed(code, String.valueOf(description));
        }
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request != null && request.isForMainFrame() && errorResponse != null && errorResponse.getStatusCode() >= 400) {
            Log.w(TAG, "main frame HTTP " + errorResponse.getStatusCode() + " for " + request.getUrl());
            activity.onLoadFailed(errorResponse.getStatusCode(), errorResponse.getReasonPhrase());
        }
    }

    static int backgroundColor() {
        return Color.parseColor("#282828"); // matches the window colour of the desktop app
    }
}
