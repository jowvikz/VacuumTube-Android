package rocks.shy.vacuumtube.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.UUID;

/**
 * Configuration store for the port.
 *
 * The key set and defaults are copied verbatim from the shipped app's src/config.js:16-58 (see
 * rea-work/census.md §4.1), because the ported preload modules were compiled against exactly that
 * schema and read it through ipcRenderer.sendSync("get-config") / ("set-config").
 */
public final class VTConfig {

    private static final String PREFS_NAME = "vacuumtube";
    private static final String CONFIG_KEY = "config";

    private final SharedPreferences preferences;
    private JSONObject values;

    public VTConfig(Context context) {
        this.preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.values = load();
    }

    /** Defaults from src/config.js:16-58 of VacuumTube 2.0.0. */
    static JSONObject defaults() {
        JSONObject json = new JSONObject();
        try {
            json.put("volume", 100);
            json.put("adblock", true);
            json.put("sponsorblock", false);
            json.put("sponsorblock_uuid", UUID.randomUUID().toString());
            json.put("sponsorblock_skip_sponsor", true);
            json.put("sponsorblock_skip_selfpromo", false);
            json.put("sponsorblock_skip_interaction", false);
            json.put("sponsorblock_skip_intro", false);
            json.put("sponsorblock_skip_outro", false);
            json.put("sponsorblock_skip_preview", false);
            json.put("sponsorblock_skip_hook", false);
            json.put("sponsorblock_skip_filler", false);
            json.put("dearrow", false);
            json.put("dislikes", false);
            json.put("remove_super_resolution", false);
            json.put("hide_shorts", false);
            json.put("block_continue_watching", false);
            json.put("h264ify", false);
            json.put("h264ify_disable_webm", true);
            json.put("h264ify_disable_vp8", true);
            json.put("h264ify_disable_vp9", true);
            json.put("h264ify_disable_av1", true);
            json.put("unlock_resolution", false);
            json.put("hardware_decoding", true);
            json.put("wayland_hdr", false);
            json.put("low_memory_mode", false);
            json.put("fullscreen", false);
            json.put("features_enabled", false);
            json.put("music_mode_feature", false);
            json.put("music_mode", false);
            json.put("ultrawide_feature", false);
            json.put("remaining_time_feature", false);
            json.put("no_window_decorations", false);
            json.put("keep_on_top", false);
            json.put("pause_on_blur", false);
            json.put("userstyles", false);
            json.put("disabled_userstyles", new JSONArray());
            json.put("touch_overlay", true);
            json.put("controller_support", true);
            json.put("device_discoverability", true);
            json.put("auto_update", true);
            // Not in the upstream defaults: guide-tabs.js treats it as an empty set when absent
            // (census.md §4.2). Materialising it keeps the settings page consistent.
            json.put("disabled_tabs", new JSONArray());
            // Android-only keys (documented in docs/FINDINGS.md §3a):
            //   android_full_bleed - anchor YouTube's 16:9 rem stage to the viewport width, which is
            //                        what removes the side gutters on non-16:9 screens
            //   android_letterbox  - opt back into the desktop app's 16:9 letterbox
            //   android_video_fill - crop landscape videos to fill the screen instead of letterboxing
            //   android_reload_on_feed_change
            //                      - reload once after a setting that only affects *future* responses
            //                        (hide_shorts, adblock, dearrow, ...) is changed, otherwise the
            //                        switch looks like it does nothing
            json.put("android_full_bleed", true);
            json.put("android_letterbox", false);
            json.put("android_video_fill", true);
            json.put("android_reload_on_feed_change", true);
        } catch (JSONException ignored) {
            // JSONObject.put only throws for NaN/Infinity values; none are used here.
        }
        return json;
    }

    private JSONObject load() {
        JSONObject merged = defaults();
        String stored = preferences.getString(CONFIG_KEY, null);
        if (stored != null) {
            try {
                merge(merged, new JSONObject(stored));
            } catch (JSONException err) {
                // A corrupt store falls back to defaults, mirroring src/config.js:66-75 behaviour.
                preferences.edit().remove(CONFIG_KEY).apply();
            }
        }
        return merged;
    }

    public synchronized JSONObject get() {
        return values;
    }

    /** Mirrors configManager.update(): defaults <- current <- patch. */
    public synchronized JSONObject update(JSONObject patch) {
        if (patch != null) merge(values, patch);
        persist();
        return values;
    }

    public synchronized boolean getBoolean(String key, boolean fallback) {
        return values.optBoolean(key, fallback);
    }

    public synchronized void putBoolean(String key, boolean value) {
        try {
            values.put(key, value);
            persist();
        } catch (JSONException ignored) {
        }
    }

    private void persist() {
        preferences.edit().putString(CONFIG_KEY, values.toString()).apply();
    }

    static void merge(JSONObject target, JSONObject patch) {
        Iterator<String> keys = patch.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try {
                target.put(key, patch.get(key));
            } catch (JSONException ignored) {
            }
        }
    }
}
