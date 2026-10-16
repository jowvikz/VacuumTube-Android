/* ---------------------------------------------------------------------------------------------
 * VacuumTube-Android glue — the only page-side code that is NEW (not present in VacuumTube 2.0.0).
 *
 * Everything it replaces has an Electron-only equivalent:
 *   1. navigator.userAgentData  <- src/ua.js applyToWebContents() used CDP Emulation.setUserAgentOverride
 *   2. remote/D-pad keys        <- util/controller.js + modules/touch-support.js already emit Starboard
 *                                  keycodes (32768/32769/32785-32788); Android delivers plain keys, so
 *                                  they are translated to the same codes the TV app expects.
 *   3. settings overlay entry   <- VacuumTube binds Ctrl+O (settings/input.js:46); a remote/phone has
 *                                  no Ctrl key, so MENU and an on-screen button are added.
 *   4. Android soft keyboard    <- Cobalt devices have a system IME; Leanback's search screen only
 *                                  draws its own letter grid and leaves nothing editable focused, so
 *                                  the text is forwarded here (__vtInjectText/__vtBackspace/__vtEnter).
 *   5. native key helper        <- used by MainActivity for BACK.
 * ------------------------------------------------------------------------------------------- */
(function () {
    if (window.__vtAndroidGlueInstalled) return
    window.__vtAndroidGlueInstalled = true

    var VT = __VT__.native
    var isLeanbackPage = location.host === 'www.youtube.com' && location.pathname === '/tv'

    /* 0) error visibility -------------------------------------------------------------------
     * The ported module loader (preload/index.js:25-31) only catches *synchronous* failures, so an
     * async module that throws during init rejects silently. That is invisible on a phone, so page
     * errors are captured here, logged through the native bridge (logcat) and surfaced in the
     * diagnostics toast.
     */
    var pageErrors = []

    function noteError(kind, value) {
        var text = kind + ': ' + (value && value.stack ? String(value.stack) : String(value))
        text = text.replace(/\s+/g, ' ').slice(0, 300)
        pageErrors.push(text)
        if (pageErrors.length > 4) pageErrors.shift()
        try {
            if (VT && VT.log) VT.log('page-error', text)
        } catch (err) { /* ignore */ }
    }

    if (typeof window.addEventListener === 'function') {
        window.addEventListener('error', function (event) {
            noteError('error', (event && (event.error || event.message)) || 'unknown')
        }, true)
        window.addEventListener('unhandledrejection', function (event) {
            noteError('rejection', (event && event.reason) || 'unknown')
        }, true)
    }
    var brands = [{ brand: 'VacuumTube', version: '27' }]
    var fullVersionList = [{ brand: 'VacuumTube', version: '27.0.0' }]
    try {
        Object.defineProperty(navigator, 'userAgentData', {
            configurable: true,
            get: function () {
                return {
                    brands: brands,
                    mobile: false,
                    platform: 'Starboard',
                    getHighEntropyValues: function () {
                        return Promise.resolve({
                            brands: brands,
                            fullVersionList: fullVersionList,
                            mobile: false,
                            platform: 'Starboard',
                            platformVersion: '',
                            architecture: 'arm',
                            bitness: '64',
                            model: '',
                            wow64: false
                        })
                    },
                    toJSON: function () {
                        return { brands: brands, mobile: false, platform: 'Starboard' }
                    }
                }
            }
        })
    } catch (err) {
        console.error('[vt-android] could not override navigator.userAgentData', err)
    }

    /* 1b) Full-bleed stage (Android display fix) ---------------------------------------------
     * YouTube's TV surface is a fixed 16:9 stage: `#container`/`#app-background` are 80rem x 45rem
     * with `html{font-size: height/45}`. Measured in a real browser: a 1560x720 viewport renders the
     * stage as 1280x720 centred, i.e. 140px of background on each side — the "borders" seen on a
     * phone. The shipped "Ultrawide Support" feature widens the content containers but never
     * `#app-background`, so a border survives; these two rule blocks fix both layers.
     */
    var FULL_BLEED_ID = 'vt-android-fullbleed'
    var FULL_BLEED_CSS = [
        // stage-level boxes: anchor them to the viewport, not to the 80rem design width
        'div#container,',
        'div#app-background,',
        'ytlr-app-background-container,',
        'yt-route {',
        '  width: 100vw !important;',
        '  min-width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  left: 0 !important;',
        '  right: auto !important;',
        '  margin-left: 0 !important;',
        '  margin-right: 0 !important;',
        '  box-sizing: border-box !important;',
        '}',
        // content containers: same widening the upstream feature applies (no positioning changes)
        'yt-virtual-list,',
        'ytlr-section-list-renderer,',
        'ytlr-horizontal-list-renderer,',
        'ytlr-tv-surface-content-renderer,',
        'div[idomkey="shadow"],',
        'ytlr-two-column-renderer,',
        'ytlr-welcome-immersive-value-prop {',
        '  width: 100vw !important;',
        '  min-width: 100vw !important;',
        '  max-width: 100vw !important;',
        '  box-sizing: border-box !important;',
        '}'
    ].join('\n')

    function currentConfig() {
        try {
            // the ported config module is already loaded by the bundle and holds the live object
            var configModule = require('/vt/src/preload/config.js')
            if (configModule && typeof configModule.get === 'function') return configModule.get() || {}
        } catch (err) { /* fall through to the bridge */ }
        try {
            return JSON.parse(VT.sendSync('get-config', null)) || {}
        } catch (err) {
            return {}
        }
    }

    function fullBleedEnabled() {
        if (!VT) return false
        try {
            return currentConfig().android_full_bleed !== false
        } catch (err) {
            return true
        }
    }

    function injectFullBleed() {
        if (!fullBleedEnabled()) return false
        var head = document.head || document.documentElement
        if (!head) return false
        var existing = document.getElementById(FULL_BLEED_ID)
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        var style = document.createElement('style')
        style.id = FULL_BLEED_ID
        style.textContent = FULL_BLEED_CSS
        head.appendChild(style)
        return true
    }

    /* 1c) Video fill -------------------------------------------------------------------------
     * The app UI now spans the screen, but a 16:9 video inside a wider player is still letterboxed
     * by the player itself. Landscape sources are cropped to fill (object-fit: cover keeps the
     * aspect, so nothing is distorted); portrait sources — Shorts — are left contained, otherwise a
     * 9:16 video would be blown up into a narrow strip.
     */
    var VIDEO_FILL_ID = 'vt-android-videofill'
    var VIDEO_FILL_CSS = [
        'ytlr-player-container,',
        '#player-container,',
        'ytd-player,',
        '.html5-video-player,',
        '.html5-video-container {',
        '  width: 100vw !important;',
        '  height: 100vh !important;',
        '  max-width: none !important;',
        '  max-height: none !important;',
        '  left: 0 !important;',
        '  top: 0 !important;',
        '}',
        // The app sizes the <video> to the whole player and letterboxes the picture inside it with
        // object-fit: contain (measured: video element 1560x720, object-fit contain). Pinning the
        // element to the viewport and switching to cover removes that letterbox; object-position is
        // forced to the centre so the crop cannot end up off to one side.
        'video.vt-android-video-fill {',
        '  position: fixed !important;',
        '  left: 0 !important;',
        '  top: 0 !important;',
        '  right: auto !important;',
        '  bottom: auto !important;',
        '  margin: 0 !important;',
        '  transform: none !important;',
        '  width: 100vw !important;',
        '  height: 100vh !important;',
        '  max-width: none !important;',
        '  max-height: none !important;',
        '  object-fit: cover !important;',
        '  object-position: center center !important;',
        '}'
    ].join('\n')

    function videoFillEnabled() {
        try {
            return currentConfig().android_video_fill !== false
        } catch (err) {
            return true
        }
    }

    function injectVideoFill() {
        if (!videoFillEnabled()) return false
        var head = document.head || document.documentElement
        if (!head) return false
        var existing = document.getElementById(VIDEO_FILL_ID)
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        var style = document.createElement('style')
        style.id = VIDEO_FILL_ID
        style.textContent = VIDEO_FILL_CSS
        head.appendChild(style)
        return true
    }

    /**
     * A video can still sit off-centre when one of its ancestors is offset (the app centres its
     * 16:9 stage with left/right/margin, and any transform on an ancestor also becomes the
     * containing block of a fixed element). Only ancestors that are measurably wrong are touched.
     */
    function neutralizeVideoChain(video) {
        var viewportWidth = window.innerWidth
        var viewportHeight = window.innerHeight
        var node = video.parentElement
        var adjusted = 0
        for (var depth = 0; node && depth < 6; depth++) {
            if (node === document.body || node === document.documentElement) break
            var rect = node.getBoundingClientRect()
            var style = window.getComputedStyle ? window.getComputedStyle(node) : null
            var transformed = !!style && style.transform && style.transform !== 'none'
            var offCentre = Math.abs(rect.left) > 1
            var tooNarrow = rect.width > 0 && rect.width < viewportWidth - 1
            var tooShort = rect.height > 0 && rect.height < viewportHeight - 1
            if (transformed || offCentre || tooNarrow || tooShort) {
                node.style.setProperty('left', '0', 'important')
                node.style.setProperty('right', 'auto', 'important')
                node.style.setProperty('margin-left', '0', 'important')
                node.style.setProperty('margin-right', '0', 'important')
                node.style.setProperty('transform', 'none', 'important')
                node.style.setProperty('width', '100vw', 'important')
                node.style.setProperty('height', '100vh', 'important')
                node.style.setProperty('max-width', 'none', 'important')
                node.style.setProperty('max-height', 'none', 'important')
                adjusted++
            }
            node = node.parentElement
        }
        return adjusted
    }

    var videoGeometry = null

    window.__vtApplyVideoFill = function () {
        if (!videoFillEnabled()) return 0
        var applied = 0
        var videos = document.querySelectorAll('video')
        for (var i = 0; i < videos.length; i++) {
            var video = videos[i]
            var width = video.videoWidth || 0
            var height = video.videoHeight || 0
            if (!width || !height) continue
            if ((width / height) >= 1.4) {
                video.classList.add('vt-android-video-fill')
                var adjusted = neutralizeVideoChain(video)
                var rect = video.getBoundingClientRect()
                videoGeometry = width + 'x' + height + '@' + Math.round(rect.left) + ',' + Math.round(rect.width) + (adjusted ? '+fixed' + adjusted : '')
                applied++
            } else {
                video.classList.remove('vt-android-video-fill')
            }
        }
        return applied
    }

    /* 2) Starboard keycodes ----------------------------------------------------------------- */
    var STARBOARD = {
        ArrowUp: 32785,
        ArrowDown: 32786,
        ArrowLeft: 32787,
        ArrowRight: 32788,
        Enter: 32768,
        NumpadEnter: 32768,
        ' ': 32768,
        Escape: 32769,
        Backspace: 32769,
        BrowserBack: 32769,
        GoBack: 32769
    }

    function isTextEntryFocused() {
        var el = document.activeElement
        if (!el) return false
        var tag = (el.tagName || '').toLowerCase()
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
    }

    function settingsOverlayOpen() {
        var root = document.getElementById('vt-settings-overlay-root')
        return !!root && !root.classList.contains('vt-settings-hidden')
    }

    // Reverse map so a synthesised Starboard event is also readable by handlers that look at
    // event.key — modules/settings/input.js:36-44 navigates the VacuumTube overlay with
    // 'ArrowUp'/'Enter'/'Escape', and without this a remote could not drive it.
    var KEY_NAMES = {
        32768: 'Enter',
        32769: 'Escape',
        32785: 'ArrowUp',
        32786: 'ArrowDown',
        32787: 'ArrowLeft',
        32788: 'ArrowRight'
    }

    function emitStarboard(code, type) {
        var event = new Event(type)
        var name = KEY_NAMES[code] || ''
        event.keyCode = code
        event.which = code
        if (name) {
            try {
                event.key = name
                event.code = name
            } catch (err) { /* ignore */ }
        }
        event.__vtSynthetic = true
        document.dispatchEvent(event)
    }

    // Exposed for MainActivity (BACK key), the keyboard bridge and manual testing.
    window.__vtStarboardKey = function (code, type) {
        emitStarboard(Number(code), type === 'keyup' ? 'keyup' : 'keydown')
    }

    var androidToggleOnNextUp = false

    // Starboard key translation can be turned off at runtime (long-press the settings button):
    // if a future Leanback build handled plain keys itself, this is the escape hatch.
    var starboardInput = !(VT && typeof VT.getStarboardInput === 'function' && String(VT.getStarboardInput()) === 'false')

    /* 3) Android soft keyboard -------------------------------------------------------------- */
    var imeActive = false
    var imeDismissed = false

    function isEditable(node) {
        if (!node) return false
        var tag = (node.tagName || '').toLowerCase()
        if (tag === 'textarea') return !node.disabled && !node.readOnly
        if (tag === 'input') return node.type !== 'hidden' && !node.disabled && !node.readOnly
        return node.isContentEditable === true
    }

    /** A text field a user could actually see and type into. */
    function findVisibleEditable() {
        var nodes = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]')
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i]
            if (!isEditable(node)) continue
            var rect = node.getBoundingClientRect()
            var style = window.getComputedStyle ? window.getComputedStyle(node) : null
            var invisible = style && (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')
            if (rect.width > 4 && rect.height > 4 && !invisible) return node
        }
        return null
    }

    /**
     * The page's own text field, if Leanback exposes one (visible first, hidden accepted as a
     * fallback for text injection). The IME decision must NOT use the hidden fallback: focusing a
     * hidden input makes Chromium claim the IME is active while nothing ever appears on screen,
     * which is exactly why tapping the keyboard button used to do nothing.
     */
    function findEditable() {
        var visible = findVisibleEditable()
        if (visible) return visible
        var nodes = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]')
        for (var i = 0; i < nodes.length; i++) {
            if (isEditable(nodes[i])) return nodes[i]
        }
        return null
    }

    /**
     * Leanback's TV keyboard is a grid of single-character leaf elements. Grouping them by parent
     * finds the grid without depending on YouTube's internal element names.
     */
    function findKeyboardKeys() {
        var groups = new Map()
        var nodes = document.querySelectorAll('div, span, button, a, li')
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i]
            if (node.children.length) continue
            var text = (node.textContent || '').trim()
            if (text.length !== 1) continue
            var rect = node.getBoundingClientRect()
            if (rect.width < 6 || rect.height < 6) continue
            var parent = node.parentElement
            if (!parent) continue
            var group = groups.get(parent)
            if (!group) {
                group = []
                groups.set(parent, group)
            }
            group.push({ node: node, text: text })
        }
        var best = null
        groups.forEach(function (group) {
            if (!best || group.length > best.length) best = group
        })
        return best && best.length >= 8 ? best : null
    }

    function clickElement(node) {
        var target = node.closest('[role="button"], button, [tabindex]') || node
        if (target && typeof target.click === 'function') {
            target.click()
            return true
        }
        var rect = node.getBoundingClientRect()
        var x = rect.left + rect.width / 2
        var y = rect.top + rect.height / 2
        var types = ['mousedown', 'mouseup', 'click']
        for (var i = 0; i < types.length; i++) {
            node.dispatchEvent(new MouseEvent(types[i], { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        }
        return true
    }

    function clickLetter(character, keys) {
        var wanted = character === ' ' ? 'space' : character.toLowerCase()
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].text.toLowerCase() === wanted) return clickElement(keys[i].node)
        }
        return false
    }

    function clickNamedKey(patterns) {
        var nodes = document.querySelectorAll('[idomkey], [aria-label], [title], [data-idom-key]')
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i]
            var haystack = ((node.getAttribute('idomkey') || '') + ' ' +
                (node.getAttribute('aria-label') || '') + ' ' +
                (node.getAttribute('data-idom-key') || '') + ' ' +
                (node.getAttribute('title') || '')).toLowerCase()
            if (!haystack.trim()) continue
            for (var p = 0; p < patterns.length; p++) {
                if (haystack.indexOf(patterns[p]) >= 0) return clickElement(node)
            }
        }
        return false
    }

    /**
     * Called by the keyboard button, the MENU key and the automatic search-screen detection.
     * Path 1 attaches the IME to the WebView when the page has a real field; path 2 (the native
     * sink bar) always opens the keyboard and forwards what is typed into the page.
     */
    window.__vtOpenIme = function () {
        if (!VT) return 'none'
        // Only a visible field can host the system IME; anything else goes through the native sink,
        // which always opens the keyboard.
        var field = findVisibleEditable()
        if (field) {
            try { field.focus({ preventScroll: true }) } catch (err) { field.focus() }
            if (typeof VT.showKeyboard === 'function') {
                imeActive = true
                imeDismissed = false
                VT.showKeyboard()
                return 'field'
            }
        }
        if (typeof VT.showKeyboardSink === 'function') {
            imeActive = true
            imeDismissed = false
            VT.showKeyboardSink()
            return 'sink'
        }
        return 'none'
    }

    window.__vtImeDismissed = function () {
        imeActive = false
        imeDismissed = true
    }

    /** Types text into the page: the field when there is one, otherwise the TV keyboard grid. */
    window.__vtInjectText = function (text) {
        if (!text) return 'none'
        var field = findEditable()
        if (field) {
            if (field.isContentEditable) {
                try { field.focus({ preventScroll: true }) } catch (err) { field.focus() }
                var inserted = false
                try { inserted = document.execCommand('insertText', false, text) } catch (err) { inserted = false }
                if (!inserted) field.textContent = (field.textContent || '') + text
                field.dispatchEvent(new Event('input', { bubbles: true }))
                return 'contenteditable'
            }
            field.focus()
            var value = field.value || ''
            var start = typeof field.selectionStart === 'number' ? field.selectionStart : value.length
            var end = typeof field.selectionEnd === 'number' ? field.selectionEnd : start
            field.value = value.slice(0, start) + text + value.slice(end)
            try { field.setSelectionRange(start + text.length, start + text.length) } catch (err) { /* ignore */ }
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
            return 'field'
        }
        var keys = findKeyboardKeys()
        if (keys) {
            var clicked = 0
            for (var i = 0; i < text.length; i++) {
                if (clickLetter(text.charAt(i), keys)) clicked++
            }
            return clicked ? 'keys' : 'none'
        }
        return 'none'
    }

    window.__vtBackspace = function () {
        var field = findEditable()
        if (field) {
            if (field.isContentEditable) {
                try {
                    document.execCommand('delete', false, null)
                    return 'contenteditable'
                } catch (err) {
                    return 'none'
                }
            }
            var value = field.value || ''
            if (!value.length) return 'field'
            field.value = value.slice(0, -1)
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
            return 'field'
        }
        if (clickNamedKey(['backspace', 'delete', 'apagar'])) return 'keys'
        return 'none'
    }

    window.__vtEnter = function () {
        // The TV surface consumes Starboard select (32768) — the same event the remote sends.
        if (typeof window.__vtStarboardKey === 'function') {
            window.__vtStarboardKey(32768, 'keydown')
            window.__vtStarboardKey(32768, 'keyup')
            return 'starboard'
        }
        return 'none'
    }

    if (isLeanbackPage) {
        injectFullBleed()
        injectVideoFill()
        watchSettingsThatNeedReload()
        // Re-inject only if a style is actually removed. They must NOT be re-appended to stay last in
        // <head> the way util/css.js does for its own styles: that would ping-pong with that module's
        // observer forever. Order does not matter here because every declaration is !important.
        if (typeof MutationObserver === 'function' && document.head) {
            new MutationObserver(function () {
                if (!document.getElementById(FULL_BLEED_ID)) injectFullBleed()
                if (videoFillEnabled() && !document.getElementById(VIDEO_FILL_ID)) injectVideoFill()
            }).observe(document.head, { childList: true })
        }

        // Landscape videos fill the player (portrait/Shorts sources are left alone).
        setInterval(function () { window.__vtApplyVideoFill() }, 1500)

        // The ported overlay's async init cannot be caught by the module loader, so if it never
        // becomes ready say so once, rather than leaving the settings taps dead and silent.
        setTimeout(function () {
            if (overlayReady() || fallbackOpen) return
            if (VT && VT.toast) VT.toast('Settings overlay não iniciou — toque no botão VT para o painel alternativo')
            try {
                if (VT && VT.log) VT.log('overlay', window.__vtDiagnostics())
            } catch (err) { /* ignore */ }
        }, 12000)

        // "Open VacuumTube Settings" inside YouTube's own settings screen: handled directly so it
        // works even when YouTube's command bus never reaches the shipped input modifier.
        document.addEventListener('click', function (event) {
            if (settingsOverlayOpen()) return
            var target = event.target && event.target.closest
                ? event.target.closest('button, [role="button"], ytlr-button-renderer, ytlr-setting-action-renderer')
                : null
            if (target && looksLikeOverlayEntry(target)) activateOverlayRow()
        }, true)

        document.addEventListener('keydown', function (event) {
            if (settingsOverlayOpen()) return
            var isSelect = event.key === 'Enter' || event.keyCode === 32768 || event.keyCode === 13
            if (!isSelect) return
            var focused = document.querySelector('.zylon-focus, [focused]') || document.activeElement
            if (looksLikeOverlayEntry(focused)) activateOverlayRow()
        }, true)

        // Leanback can focus a visible field programmatically; follow that with the system keyboard.
        document.addEventListener('focusin', function (event) {
            if (imeActive) return
            if (event.target !== findVisibleEditable()) return
            window.__vtOpenIme()
        }, true)

        // The search screen only draws a letter grid, so it is detected and the keyboard is raised
        // once per appearance (and not again after the user dismissed it with BACK).
        setInterval(function () {
            if (imeActive || imeDismissed) return
            var hash = location.hash || ''
            var looksLikeSearch = /search|pesquis/i.test(hash) ||
                !!document.querySelector('input[type="search"], ytlr-search-box-renderer, ytlr-search-renderer')
            if (!looksLikeSearch && !findKeyboardKeys()) return
            imeDismissed = false
            window.__vtOpenIme()
        }, 700)

        // modules/fix-exit.js calls window.close() for the TV app's EXIT_APP signal.
        window.close = function () {
            if (VT && typeof VT.exitApp === 'function') VT.exitApp()
        }
    }

    document.addEventListener('keydown', function (event) {
        if (event.__vtSynthetic) return

        // MENU key (Android KEYCODE_MENU) always opens/closes VacuumTube settings.
        if (event.keyCode === 82) {
            event.preventDefault()
            event.stopImmediatePropagation()
            window.__vtToggleSettings()
            return
        }

        if (!isLeanbackPage) return
        if (!starboardInput) return

        // Never interfere while the settings overlay owns input, while the user is typing,
        // or while a text field is focused (Chromium must handle Enter to raise the IME).
        if (settingsOverlayOpen() || isTextEntryFocused()) return

        var code = STARBOARD[event.key]
        if (code === undefined) return

        event.preventDefault()
        event.stopImmediatePropagation()
        androidToggleOnNextUp = true
        emitStarboard(code, 'keydown')
    }, true)

    document.addEventListener('keyup', function (event) {
        if (event.__vtSynthetic) return
        if (!isLeanbackPage) return
        if (settingsOverlayOpen() || isTextEntryFocused()) return
        var code = STARBOARD[event.key]
        if (code === undefined) return
        if (!androidToggleOnNextUp) return
        androidToggleOnNextUp = false
        event.preventDefault()
        event.stopImmediatePropagation()
        emitStarboard(code, 'keyup')
    }, true)

    /* 4) settings overlay + keyboard entry points --------------------------------------------
     * modules/settings/index.js defines window.vtOpenSettingsOverlay / vtToggleSettingsOverlay only
     * after it has loaded the locale and built its DOM, and the "Open VacuumTube Settings" row that
     * leanback-settings.js:127-136 injects into YouTube's own settings screen calls
     * window.vtOpenSettingsOverlay() at click time. Two failure modes follow (the row is marked
     * "unused since settings are now in custom menu" in the shipped source):
     *   - the click arrives before the module is ready, so the call is silently dropped
     *   - the command bus that should run the row's navigationEndpoint never reaches the modifier
     * So the globals are proxied (queuing a request until the real implementation appears) and the
     * row is ALSO detected from the DOM / key events, independently of YouTube's command bus.
     */
    var overlayImpl = { open: null, toggle: null }
    var overlayCaptured = { open: false, toggle: false }
    var overlayPending = null

    function overlayReady() {
        return typeof overlayImpl.open === 'function' || typeof overlayImpl.toggle === 'function'
    }

    function openOverlay() {
        if (typeof overlayImpl.open === 'function') {
            overlayImpl.open()
            return true
        }
        if (typeof overlayImpl.toggle === 'function') {
            overlayImpl.toggle()
            return true
        }
        return false
    }

    function toggleOverlay() {
        if (typeof overlayImpl.toggle === 'function') {
            overlayImpl.toggle()
            return true
        }
        return openOverlay()
    }

    /* Fallback settings panel, used when the ported overlay module did not initialise (which happens
     * silently, since its async body cannot be caught by the module loader). Plain DOM + inline
     * styles on purpose: it must not depend on anything that could have been the thing that failed.
     */
    var FALLBACK_ID = 'vt-android-fallback-settings'
    var fallbackOpen = false
    var fallbackRows = [
        { key: 'adblock', label: 'Bloquear anúncios (Ad block)' },
        { key: 'sponsorblock', label: 'SponsorBlock' },
        { key: 'dearrow', label: 'DeArrow (títulos/miniaturas)' },
        { key: 'dislikes', label: 'Mostrar deslikes (RYD)' },
        { key: 'hide_shorts', label: 'Ocultar Shorts' },
        { key: 'block_continue_watching', label: 'Bloquear "Continue assistindo"' },
        { key: 'remove_super_resolution', label: 'Remover "Super resolution"' },
        { key: 'h264ify', label: 'Forçar H.264 (codecs)' },
        { key: 'unlock_resolution', label: 'Liberar resolução' },
        { key: 'low_memory_mode', label: 'Modo de baixa memória' },
        { key: 'fullscreen', label: 'Tela cheia (imersivo)' },
        { key: 'touch_overlay', label: 'Controles de toque' },
        { key: 'controller_support', label: 'Suporte a controle' },
        { key: 'device_discoverability', label: 'Descoberta (DIAL / cast)' },
        { key: 'features_enabled', label: 'Recursos experimentais' },
        { key: 'remaining_time_feature', label: 'Tempo restante' },
        { key: 'android_full_bleed', label: 'Ocupar a tela inteira (sem bordas)' },
        { key: 'android_video_fill', label: 'Vídeo preenchendo a tela (corte)' },
        { key: 'android_reload_on_feed_change', label: 'Recarregar ao mudar opções de feed' }
    ]

    function writeConfig(key, value) {
        var patch = {}
        patch[key] = value
        try {
            require('/vt/src/preload/config.js').set(patch) // keeps the modules' shared config live
        } catch (err) {
            try {
                VT.sendSync('set-config', JSON.stringify(patch))
            } catch (inner) { /* ignore */ }
        }
    }

    function closeFallbackSettings() {
        var existing = document.getElementById(FALLBACK_ID)
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        fallbackOpen = false
    }

    function openFallbackSettings() {
        if (fallbackOpen) return true
        if (!document.body) return false

        var root = document.createElement('div')
        root.id = FALLBACK_ID
        root.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;'
            + 'background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;'
            + 'font-family:Roboto,Arial,sans-serif;color:#fff'

        var card = document.createElement('div')
        card.style.cssText = 'width:92vw;max-width:760px;max-height:88vh;overflow:auto;background:#202124;'
            + 'border-radius:14px;padding:18px 22px;box-shadow:0 10px 44px rgba(0,0,0,.65)'

        var title = document.createElement('div')
        title.textContent = 'Configurações do VacuumTube'
        title.style.cssText = 'font-size:22px;font-weight:700'

        var hint = document.createElement('div')
        hint.textContent = 'Painel alternativo — o overlay original não iniciou nesta tela. Toque para ligar/desligar.'
        hint.style.cssText = 'font-size:14px;opacity:.72;margin:6px 0 14px'

        card.appendChild(title)
        card.appendChild(hint)

        fallbackRows.forEach(function (row) {
            var line = document.createElement('div')
            line.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;'
                + 'padding:13px 4px;border-top:1px solid #34363a'

            var label = document.createElement('div')
            label.textContent = row.label
            label.style.cssText = 'font-size:17px;line-height:1.3'

            var pill = document.createElement('div')
            pill.style.cssText = 'flex:0 0 auto;min-width:78px;text-align:center;padding:8px 14px;'
                + 'border-radius:999px;font-weight:700;font-size:15px'

            function paint() {
                var on = currentConfig()[row.key] !== false
                pill.textContent = on ? 'ON' : 'OFF'
                pill.style.background = on ? '#2ba640' : '#45484d'
                pill.style.color = on ? '#06240c' : '#e6e6e6'
            }
            paint()

            line.addEventListener('click', function () {
                var next = currentConfig()[row.key] === false
                writeConfig(row.key, next)
                paint()
                if (VT && VT.toast) VT.toast(row.label + ': ' + (next ? 'ON' : 'OFF'))
            })

            line.appendChild(label)
            line.appendChild(pill)
            card.appendChild(line)
        })

        var close = document.createElement('div')
        close.textContent = 'Fechar'
        close.style.cssText = 'margin-top:18px;padding:13px 20px;background:#3d4046;border-radius:10px;'
            + 'text-align:center;font-weight:700;font-size:17px'
        close.addEventListener('click', closeFallbackSettings)
        card.appendChild(close)

        root.addEventListener('click', function (event) {
            if (event.target === root) closeFallbackSettings()
        })
        root.appendChild(card)

        document.body.appendChild(root)
        fallbackOpen = true
        return true
    }

    /** Explicit entry point (long-press the native button, or tests). */
    window.__vtFallbackSettings = function () { return openFallbackSettings() }

    window.__vtOpenSettings = function () {
        if (openOverlay()) return true
        if (openFallbackSettings()) return true
        overlayPending = 'open'
        return false
    }

    window.__vtToggleSettings = function () {
        // While the fallback panel is up it owns the toggle, even if the ported overlay became ready
        // in the meantime — otherwise it could never be closed.
        if (fallbackOpen) {
            closeFallbackSettings()
            return true
        }
        if (toggleOverlay()) return true
        if (openFallbackSettings()) return true
        overlayPending = 'toggle'
        return false
    }

    var overlayProxyOpen = function () { return window.__vtOpenSettings() }
    var overlayProxyToggle = function () { return window.__vtToggleSettings() }

    // Installed before the ported module runs, so even its own lookups go through the queue.
    window.vtOpenSettingsOverlay = overlayProxyOpen
    window.vtToggleSettingsOverlay = overlayProxyToggle

    setInterval(function () {
        // Capture each implementation ONCE, then keep the proxy in front of it forever. Re-capturing
        // would be able to pick up a wrapper of this very proxy and recurse.
        if (!overlayCaptured.open && typeof window.vtOpenSettingsOverlay === 'function' && window.vtOpenSettingsOverlay !== overlayProxyOpen) {
            overlayImpl.open = window.vtOpenSettingsOverlay
            overlayCaptured.open = true
        }
        if (!overlayCaptured.toggle && typeof window.vtToggleSettingsOverlay === 'function' && window.vtToggleSettingsOverlay !== overlayProxyToggle) {
            overlayImpl.toggle = window.vtToggleSettingsOverlay
            overlayCaptured.toggle = true
        }
        if (window.vtOpenSettingsOverlay !== overlayProxyOpen) window.vtOpenSettingsOverlay = overlayProxyOpen
        if (window.vtToggleSettingsOverlay !== overlayProxyToggle) window.vtToggleSettingsOverlay = overlayProxyToggle
        if (overlayPending && overlayReady()) {
            var pending = overlayPending
            overlayPending = null
            if (pending === 'open') openOverlay()
            else toggleOverlay()
        }
    }, 200)

    /** The injected row is matched by its own localised label, so no false positives elsewhere. */
    var overlayRowLabel = null

    function settingsEntryLabel() {
        if (overlayRowLabel) return overlayRowLabel
        try {
            var localeProvider = require('/vt/src/preload/util/localeProvider.js')
            var locale = localeProvider.getLocale && localeProvider.getLocale()
            if (locale && locale.settings && locale.settings.generic && locale.settings.generic.button_label) {
                overlayRowLabel = String(locale.settings.generic.button_label)
            }
        } catch (err) { /* locale not ready yet */ }
        return overlayRowLabel
    }

    function looksLikeOverlayEntry(node) {
        if (!node) return false
        var text = (node.textContent || '').trim()
        if (!text || text.length > 200) return false
        var label = settingsEntryLabel()
        if (label && text.indexOf(label) >= 0) return true
        var lower = text.toLowerCase()
        return lower.indexOf('vacuumtube') >= 0 && /(settings|configura|ajustes|einstellung|param|impostaz)/.test(lower)
    }

    function activateOverlayRow() {
        var opened = window.__vtOpenSettings()
        if (VT && VT.toast) VT.toast(opened ? 'VacuumTube' : 'Configurações do VacuumTube ainda carregando…')
    }

    /** Runtime diagnostics, shown by long-pressing the ABC button, so device issues are reportable. */
    window.__vtDiagnostics = function () {
        var stage = document.querySelector('div#container')
        var width = stage ? Math.round(stage.getBoundingClientRect().width) : -1
        var overlayState = fallbackOpen ? 'fallback' : (overlayReady() ? 'ready' : 'pending')
        return 'v=' + (VT && VT.appVersion ? VT.appVersion() : '?')
            + ' stage=' + width + '/' + window.innerWidth
            + ' bleed=' + (document.getElementById(FULL_BLEED_ID) ? 'on' : 'off')
            + ' video=' + (document.getElementById(VIDEO_FILL_ID) ? 'on' : 'off')
            + (videoGeometry ? ' vid=' + videoGeometry : '')
            + ' overlay=' + overlayState
            + ' updates=' + configUpdateCount
            + ' errors=' + (pageErrors.length ? pageErrors[pageErrors.length - 1].slice(0, 90) : 'none')
    }

    window.__vtShowDiagnostics = function () {
        var text = window.__vtDiagnostics()
        if (VT && VT.toast) VT.toast(text)
        try {
            if (VT && VT.log) VT.log('diagnostics', text)
        } catch (err) { /* ignore */ }
        return text
    }

    /* 4b) Settings that only take effect when the page re-fetches its data --------------------
     * Modules such as hide-shorts.js, adblock.js and dearrow.js are XHR/JSON *response* modifiers:
     * they filter what arrives next, so flipping the switch in the settings overlay changes nothing
     * on the already rendered feed — which reads as "the option does nothing". Reloading once after
     * such a change makes the switch visibly effective.
     */
    var RELOAD_KEYS = [
        'adblock',
        'hide_shorts',
        'dearrow',
        'dislikes',
        'remove_super_resolution',
        'block_continue_watching',
        'disabled_tabs',
        'h264ify',
        'features_enabled',
        'remaining_time_feature'
    ]
    var reloadTimer = null
    var configUpdateCount = 0

    function reloadOnFeedChangeEnabled() {
        try {
            return currentConfig().android_reload_on_feed_change !== false
        } catch (err) {
            return true
        }
    }

    function scheduleReload(changed) {
        if (reloadTimer) clearTimeout(reloadTimer)
        if (VT && VT.toast) VT.toast('Aplicando ' + changed.join(', ') + ' — recarregando…')
        reloadTimer = setTimeout(function () {
            reloadTimer = null
            try {
                require('electron').ipcRenderer.invoke('reload') // same path modules/fix-reloads.js uses
            } catch (err) {
                try { location.reload() } catch (inner) { /* ignore */ }
            }
        }, 1500)
    }

    function watchSettingsThatNeedReload() {
        try {
            var ipcRenderer = require('electron').ipcRenderer
            if (!ipcRenderer || typeof ipcRenderer.on !== 'function') return
            var previous = null
            ipcRenderer.on('config-update', function (event, config) {
                configUpdateCount++
                if (!config) return
                var snapshot = {}
                for (var i = 0; i < RELOAD_KEYS.length; i++) {
                    var key = RELOAD_KEYS[i]
                    snapshot[key] = JSON.stringify(config[key])
                }
                if (previous === null) {
                    previous = snapshot
                    return
                }
                var changed = []
                for (var j = 0; j < RELOAD_KEYS.length; j++) {
                    var name = RELOAD_KEYS[j]
                    if (snapshot[name] !== previous[name]) changed.push(name)
                }
                previous = snapshot
                if (!changed.length || !reloadOnFeedChangeEnabled()) return
                scheduleReload(changed)
            })
        } catch (err) {
            console.error('[vt-android] could not watch the settings that need a reload', err)
        }
    }

    function cornerButton(id, glyph, top, label, onTap, onLongPress) {
        if (document.getElementById(id)) return
        if (!document.body) return

        var button = document.createElement('div')
        button.id = id
        button.setAttribute('role', 'button')
        button.setAttribute('aria-label', label)
        button.textContent = glyph
        button.style.cssText = [
            'position:fixed',
            'top:' + top,
            'right:2.5vh',
            'width:7vh',
            'height:7vh',
            'min-width:34px',
            'min-height:34px',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'border-radius:50%',
            'background:rgba(24,24,24,0.55)',
            'color:#fff',
            'font-family:"YouTube Icons Outlined","YouTube Sans",Roboto,Arial,sans-serif',
            'font-size:' + (glyph.length > 1 ? '2.1vh' : '3.4vh'),
            'font-weight:700',
            'letter-spacing:0.05em',
            'opacity:0.4',
            'z-index:99998',
            'touch-action:none',
            'user-select:none',
            '-webkit-user-select:none',
            'transition:opacity .2s'
        ].join(';')

        var pressTimer = null
        var longPressFired = false
        var lastActivation = 0

        function show() { button.style.opacity = '0.95' }
        function hide() { button.style.opacity = '0.4' }

        // A tap on Android also produces compatibility mouse events; without this guard the action
        // would run twice and a toggle would open and immediately close.
        function activate() {
            var now = Date.now()
            if (now - lastActivation < 350) return
            lastActivation = now
            onTap()
        }

        button.addEventListener('touchstart', function (event) {
            event.preventDefault()
            event.stopPropagation()
            show()
            longPressFired = false
            if (!onLongPress) return
            pressTimer = setTimeout(function () {
                longPressFired = true
                onLongPress()
            }, 1200)
        }, true)
        button.addEventListener('touchend', function (event) {
            event.preventDefault()
            event.stopPropagation()
            clearTimeout(pressTimer)
            hide()
            if (!longPressFired) activate()
        }, true)
        button.addEventListener('mouseup', function (event) {
            event.stopPropagation()
            hide()
            activate()
        })
        button.addEventListener('click', function (event) {
            event.stopPropagation()
            activate()
        })

        document.body.appendChild(button)
    }

    function installButtons() {
        cornerButton('vt-android-settings-button', '\ue8b8', '2.5vh', 'VacuumTube settings',
            function () { window.__vtToggleSettings() },
            function () {
                // escape hatch: toggle the Starboard key translation at runtime
                starboardInput = !starboardInput
                if (VT && VT.setStarboardInput) VT.setStarboardInput(String(starboardInput))
                if (VT && VT.toast) VT.toast(starboardInput ? 'Starboard input: on' : 'Starboard input: off')
            })

        cornerButton('vt-android-keyboard-button', 'ABC', '11vh', 'Type with the Android keyboard',
            function () {
                var result = window.__vtOpenIme()
                if (result === 'none' && VT && VT.toast) VT.toast('Nenhum campo de texto nesta tela')
            },
            function () {
                // long-press: report what the page currently sees (used to debug device reports)
                if (window.__vtShowDiagnostics) window.__vtShowDiagnostics()
            })
    }

    if (isLeanbackPage) {
        if (document.body) installButtons()
        else document.addEventListener('DOMContentLoaded', installButtons, { once: true })
        window.addEventListener('load', installButtons, { once: true })
    }

    console.log('[vt-android] glue installed (leanback=' + isLeanbackPage + ')')
})()
