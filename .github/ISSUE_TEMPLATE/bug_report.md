---
name: Bug report
about: Something in the port does not behave like the desktop app
title: ''
labels: bug
assignees: ''
---

## What happens

<!-- What you did, what you expected, what actually happened. -->

## Device

- Android version:
- WebView version (Settings → Apps → Android System WebView):
- Device (phone / tablet / TV box / Android TV):
- Screen aspect (e.g. 20:9 phone in landscape):

## Diagnostics line — please always include this

Long-press the **VT** button in the top-left corner (or the in-page **ABC** button) and paste the
toast text here:

```
v=… stage=…/… bleed=on|off video=on|off vid=… overlay=ready|fallback|pending updates=… errors=…
```

What each field tells us:

| field | meaning |
|---|---|
| `stage=<width>/<viewport>` | if they differ, the TV surface is not filling the screen |
| `bleed` / `video` | whether the full-bleed and video-fill stylesheets are live |
| `vid=…` | geometry of the video element that was adapted (present only while a video is loaded) |
| `overlay=ready\|fallback\|pending` | the ported settings overlay initialised, or the fallback panel had to be used, or neither is up yet |
| `updates=<n>` | how many config events arrived from the native side (0 means the bridge is not delivering) |
| `errors=<last page error>` | last captured page error / rejected promise |

## Logs (optional, very helpful)

```
adb logcat -s VacuumTube:* | findstr /i "vt-android page-error diagnostics"
```
