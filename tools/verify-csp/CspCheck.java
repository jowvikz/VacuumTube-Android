// Offline verification of the CSP + injection port against the headers youtube.com/tv really sends.
// Compiled with a plain desktop JDK (no Android SDK, no emulator):
//   javac -d out tools/verify-csp/CspCheck.java app/src/main/java/rocks/shy/vacuumtube/android/VtCsp.java
//   java -cp out CspCheck <csp-headers.txt> <served.html>
import rocks.shy.vacuumtube.android.VtCsp;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

public class CspCheck {

    private static int failures = 0;

    private static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    private static void check(String name, boolean ok, String detail) {
        System.out.println((ok ? "PASS  " : "FAIL  ") + name + (detail == null || detail.isEmpty() ? "" : "  [" + detail + "]"));
        if (!ok) failures++;
    }

    public static void main(String[] args) throws Exception {
        String rawHeaders = new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8);
        String html = new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8);

        List<String> policies = new ArrayList<>();
        for (String part : rawHeaders.split("(?m)^---$")) {
            if (!part.trim().isEmpty()) policies.add(part.trim());
        }

        System.out.println("=== CSP + injection check ===");
        System.out.println("policies supplied: " + policies.size());
        for (int i = 0; i < policies.size(); i++) {
            String policy = policies.get(i);
            System.out.println("  [" + i + "] " + policy.substring(0, Math.min(90, policy.length())) + (policy.length() > 90 ? "…" : ""));
        }

        String nonce = "VTTESTNONCE0000000000000000000000";
        String merged = VtCsp.merge(policies, nonce);
        System.out.println("merged: " + merged.substring(0, Math.min(600, merged.length())) + (merged.length() > 600 ? "…" : ""));
        System.out.println();

        check("require-trusted-types-for removed", !merged.contains("require-trusted-types-for"));
        check("style-src keeps 'unsafe-inline' + data: + *",
                merged.contains("style-src") && merged.contains("'unsafe-inline'") && merged.contains("data:"));
        check("style-src nonces removed (they would nullify 'unsafe-inline')",
                !merged.matches("(?s).*style-src[^;]*'nonce-[^']*'.*"));
        check("connect-src allows SponsorBlock + Return YouTube Dislike",
                merged.contains("sponsor.ajay.app") && merged.contains("returnyoutubedislikeapi.com"));
        check("img-src allows DeArrow thumbnails", merged.contains("dearrow-thumb.ajay.app"));
        check("script-src carries this client's nonce", merged.contains("'nonce-" + nonce + "'"));
        check("original page nonces survive", merged.contains("'nonce-") && merged.replace("'nonce-" + nonce + "'", "").contains("'nonce-"));
        check("policy separation is '; ' (single header, no ', ' policy join)",
                !merged.contains(";, ") && merged.split("; ").length > 1);
        check("default-src survived the merge", merged.contains("default-src") || !rawHeaders.contains("default-src"));

        // Document-start injection: our tag must precede every page script.
        String bundle = "/*bundle*/";
        String injected = VtCsp.injectBundle(html, bundle, nonce);
        String tag = "<script nonce=\"" + nonce + "\">" + bundle + "</script>";
        int ourIndex = injected.indexOf(tag);
        int firstPageScript = injected.indexOf("<script", ourIndex + tag.length());
        int headEnd = injected.toLowerCase().indexOf("</head>");
        check("bundle script injected", ourIndex > 0);
        check("bundle script is inside <head>", ourIndex > 0 && headEnd > 0 && ourIndex < headEnd, "head ends at " + headEnd);
        check("bundle script precedes the first page script", ourIndex > 0 && firstPageScript > ourIndex, "page script at " + firstPageScript);
        check("injection did not drop the document", injected.length() > html.length() && injected.contains(html.substring(html.length() - 200)));
        check("no script-terminating sequence inside the injected tag",
                bundle.contains("</script") == false && injected.indexOf("</script>") == ourIndex + tag.length() - "</script>".length());

        System.out.println();
        System.out.println(failures == 0 ? "all checks passed" : failures + " check(s) failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
