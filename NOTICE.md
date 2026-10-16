# Third-party notices

`vendor/vacuumtube-preload/` contains the page-side modules of **VacuumTube 2.0.0**, extracted from
the shipped `resources/app.asar` published by
[shy1132/VacuumTube](https://github.com/shy1132/VacuumTube), and reused here under the MIT licence
reproduced in [`LICENSE`](LICENSE). The upstream licence text is kept verbatim in
`vendor/vacuumtube-preload/LICENSE`.

* `vendor/vacuumtube-preload/src/` is **unmodified**. The three DIAL modules that cannot run inside a
  WebView (they own UDP/TCP sockets) are substituted by native Android code; the substitution is
  documented in [`docs/FINDINGS.md`](docs/FINDINGS.md).
* VacuumTube is an unofficial wrapper of YouTube Leanback. This project is **not** affiliated with,
  endorsed by, or sponsored by YouTube or Google.
* Android, Google Play and YouTube are trademarks of Google LLC.
