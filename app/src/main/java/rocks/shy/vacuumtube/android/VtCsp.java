package rocks.shy.vacuumtube.android;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Content-Security-Policy rewriting and document-start injection — deliberately free of Android
 * imports so it can be unit-tested on a desktop JDK against the real headers youtube.com/tv sends
 * (tools/verify-csp/CspCheck.java).
 *
 * Source of the behaviour: src/index.js:165-233 of the shipped VacuumTube 2.0.0, which rewrote CSP
 * so that userstyles, SponsorBlock, DeArrow and Return YouTube Dislike work, and removed
 * `require-trusted-types-for 'script'` so its own DOM injection is allowed.
 *
 * Android difference: a WebResourceResponse carries a single value per header name, while
 * youtube.com/tv sends several Content-Security-Policy headers (Node's http module joins them with
 * ", ", WebView cannot). Merging them by comma would silently drop every directive after the first
 * duplicate, so the policies are merged into one policy that is the union of all of them — every
 * source YouTube allowed stays allowed, and the added sources are the ones the desktop build added.
 */
public final class VtCsp {

    private VtCsp() {
    }

    public static String merge(List<String> policies, String nonce) {
        LinkedHashMap<String, LinkedHashSet<String>> directives = new LinkedHashMap<>();

        for (String policy : policies) {
            if (policy == null) continue;
            for (String part : policy.split(";")) {
                String trimmed = part.trim();
                if (trimmed.isEmpty()) continue;
                String[] tokens = trimmed.split("\\s+");
                String name = tokens[0].toLowerCase(Locale.US);
                // src/index.js:177-181 — Trusted Types break VacuumTube's injected DOM.
                if (name.equals("require-trusted-types-for")) continue;
                // Reporting endpoints would now report our own relaxations.
                if (name.equals("report-uri") || name.equals("report-to")) continue;
                LinkedHashSet<String> values = directives.get(name);
                if (values == null) {
                    values = new LinkedHashSet<>();
                    directives.put(name, values);
                }
                for (int i = 1; i < tokens.length; i++) values.add(tokens[i]);
            }
        }

        // src/index.js:186-194 — userstyles need inline styles, data: URLs and @import. Nonces are
        // dropped because a nonce makes 'unsafe-inline' ineffective.
        LinkedHashSet<String> styleSrc = directives.get("style-src");
        if (styleSrc != null) {
            java.util.Iterator<String> iterator = styleSrc.iterator();
            while (iterator.hasNext()) {
                if (iterator.next().toLowerCase(Locale.US).startsWith("'nonce-")) iterator.remove();
            }
            styleSrc.add("'unsafe-inline'");
            styleSrc.add("data:");
            styleSrc.add("*");
        }
        // src/index.js:198-204 (fonts), 207-214 (SponsorBlock + Return YouTube Dislike), 217-224 (DeArrow)
        extend(directives, "font-src", "*", "data:");
        extend(directives, "connect-src", "sponsor.ajay.app", "returnyoutubedislikeapi.com", "data:");
        extend(directives, "img-src", "dearrow-thumb.ajay.app", "data:");

        // New on Android: allow this client's own document-start bootstrap. The page's nonces stay.
        String nonceSource = "'nonce-" + nonce + "'";
        if (directives.containsKey("script-src")) extend(directives, "script-src", nonceSource);
        else extend(directives, "default-src", nonceSource);

        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, LinkedHashSet<String>> entry : directives.entrySet()) {
            if (out.length() > 0) out.append("; ");
            out.append(entry.getKey());
            for (String value : entry.getValue()) out.append(' ').append(value);
        }
        return out.toString();
    }

    /** Only directives that already exist are extended: creating one would add a new restriction. */
    private static void extend(Map<String, LinkedHashSet<String>> directives, String name, String... values) {
        LinkedHashSet<String> existing = directives.get(name);
        if (existing == null) return;
        for (String value : values) existing.add(value);
    }

    /**
     * Insert the ported preload as the first script inside <head>, i.e. before every page script —
     * the equivalent of Electron's preload running at document-start.
     */
    public static String injectBundle(String html, String bundle, String nonce) {
        String tag = "<script nonce=\"" + nonce + "\">" + bundle + "</script>";
        int head = indexOfIgnoreCase(html, "<head");
        if (head >= 0) {
            int end = html.indexOf('>', head);
            if (end > 0) return html.substring(0, end + 1) + tag + html.substring(end + 1);
        }
        int root = indexOfIgnoreCase(html, "<html");
        if (root >= 0) {
            int end = html.indexOf('>', root);
            if (end > 0) return html.substring(0, end + 1) + tag + html.substring(end + 1);
        }
        return tag + html;
    }

    private static int indexOfIgnoreCase(String haystack, String needle) {
        return haystack.toLowerCase(Locale.US).indexOf(needle.toLowerCase(Locale.US));
    }
}
