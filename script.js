/* ==========================================================================
   P K | Fragrance After Dark
   Scroll-driven cinematic hero
   --------------------------------------------------------------------------
   PERFORMANCE MODEL

   (A) DELIVERY
   The hero video is fetched in full via fetch() and handed to the <video>
   element as a blob: URL. Only then is scrubbing enabled.

   Why: progressive streaming means video.buffered lags the scroll position,
   so seeks either stall the decoder or get clamped to the buffered edge. Both
   read as jank. This is why the page feels smooth locally (whole file on disk)
   but not on GitHub Pages (file arriving over the network). Once the blob is
   resident in memory, seeks are instant in both environments.

   (B) SCRUBBING
   Scroll events never touch the video and never touch the DOM. They only
   record a target. A single requestAnimationFrame loop owns every read, every
   write and every media seek.

     Scroll  ->  record target only (cached geometry, no forced layout)
     rAF     ->  ease playhead toward target, issue at most one seek,
                 write styles once, dirty-checked

   Video time is eased (LERP) rather than assigned directly, so the decoder is
   never asked to service more seeks than it can sustain.
   ========================================================================== */
(function () {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        var video = document.getElementById('hero-video');
        var heroSection = document.getElementById('scroll-hero');
        var overlay = document.querySelector('.video-fade-overlay');
        var loader = document.querySelector('.hero-loader');
        var loaderBar = document.querySelector('.hero-loader__bar');

        var prefersReducedMotion =
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        /* fastSeek() snaps to the nearest keyframe rather than decoding to an
           exact frame. With an all-intra encode every frame IS a keyframe, so
           this is lossless in practice and cheaper. Chromium does not
           implement it; the fallback is a normal currentTime assignment. */
        var hasFastSeek = !!(video && typeof video.fastSeek === 'function');

        /* requestVideoFrameCallback fires when a frame has actually been
           presented to the compositor — a more accurate "seek finished" signal
           than the 'seeked' event, which can fire before presentation. */
        var hasRVFC =
            !!(video && typeof video.requestVideoFrameCallback === 'function');

        var blobUrl = null;

        initSceneReveal();
        initMobileMenu();
        initAnchorScroll();
        startVideoPipeline();

        /* ==================================================================
           0. Delivery pipeline — preload fully, then enable scrubbing
           ================================================================== */
        function startVideoPipeline() {
            if (!video || !heroSection || !overlay) return;

            if (prefersReducedMotion) {
                video.src = pickSource();
                setupReducedMotion();
                hideLoader();
                return;
            }

            var src = pickSource();

            /* No fetch support, or a cross-origin situation we can't read:
               fall back to plain streaming. Scrubbing still works, it just
               degrades on slow connections the way it did before. */
            if (!window.fetch || !window.URL || !window.URL.createObjectURL) {
                video.src = src;
                enableScrubbing();
                hideLoader();
                return;
            }

            showLoader();

            fetchWithProgress(src, onProgress)
                .then(function (blob) {
                    blobUrl = URL.createObjectURL(blob);
                    video.src = blobUrl;
                    enableScrubbing();
                    hideLoader();
                })
                .catch(function () {
                    /* Network error, CORS, or out of memory. Degrade to
                       streaming rather than showing nothing at all. */
                    video.src = src;
                    enableScrubbing();
                    hideLoader();
                });
        }

        /* Mobile decoders are weaker and mobile connections slower, so small
           screens get the lighter encode. Chosen here rather than in HTML so
           the browser never begins downloading the wrong file. */
        function pickSource() {
            var small = window.matchMedia('(max-width: 768px)').matches;
            return 'assets/elan-noir-scrub' + (small ? '-mobile' : '') + '.mp4';
        }

        function fetchWithProgress(url, onChunk) {
            return fetch(url, { cache: 'force-cache' }).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);

                var total = parseInt(
                    res.headers.get('Content-Length') || '0',
                    10
                );

                /* Streams API unavailable — still works, just no progress. */
                if (!res.body || !res.body.getReader) {
                    return res.blob();
                }

                var reader = res.body.getReader();
                var chunks = [];
                var received = 0;

                return (function pump() {
                    return reader.read().then(function (result) {
                        if (result.done) {
                            return new Blob(chunks, { type: 'video/mp4' });
                        }
                        chunks.push(result.value);
                        received += result.value.length;
                        if (total > 0) onChunk(received / total);
                        return pump();
                    });
                })();
            });
        }

        function onProgress(ratio) {
            if (loaderBar) {
                loaderBar.style.transform =
                    'scaleX(' + Math.max(0, Math.min(1, ratio)) + ')';
            }
        }

        function showLoader() {
            if (loader) loader.classList.add('is-active');
        }

        function hideLoader() {
            if (loader) {
                loader.classList.remove('is-active');
                loader.classList.add('is-done');
            }
        }

        /* Release the blob when the page unloads so memory is reclaimed. */
        window.addEventListener('pagehide', function () {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        });

        /* ==================================================================
           1. Scroll-driven video scrubbing
           ================================================================== */
        function enableScrubbing() {
            /* ---- Tunables -------------------------------------------------
               SMOOTHING       0-1. Lower = smoother and heavier, higher =
                               snappier. 0.12 gives an inertial, luxury feel.
                               Try 0.18 if it trails too much, 0.08 if twitchy.
               SEEK_DEADZONE   Seconds. Below this delta, issue no seek at all.
                               Kills pointless sub-frame churn.
               SETTLE_EPSILON  Seconds. Within this, snap and idle the loop.
               ---------------------------------------------------------------- */
            var SMOOTHING = 0.12;
            var SEEK_DEADZONE = 0.015;
            var SETTLE_EPSILON = 0.002;

            var videoDuration = 0;
            var isVideoReady = false;

            var targetTime = 0;   // where scroll says the playhead should be
            var currentTime = 0;  // where the eased playhead actually is
            var lastSeekIssued = -1;

            var targetOpacity = 0;
            var appliedOpacity = -1; // -1 forces the first write

            var isSeeking = false;
            var rafId = null;

            /* Geometry cached, recomputed only on resize. Never measured
               inside the scroll handler — that was the original layout thrash. */
            var heroTop = 0;
            var scrollRange = 1;

            function measure() {
                var rect = heroSection.getBoundingClientRect();
                heroTop = rect.top + window.scrollY;
                scrollRange = Math.max(
                    1,
                    heroSection.offsetHeight - window.innerHeight
                );
                onScroll();
            }

            function onVideoReady() {
                if (isVideoReady) return;
                if (isNaN(video.duration) || video.duration <= 0) return;

                videoDuration = video.duration;
                isVideoReady = true;

                /* Some engines will not render the first frame until playback
                   has been kicked once. Permitted because the element is muted. */
                var kick = video.play();
                if (kick && typeof kick.then === 'function') {
                    kick.then(function () {
                        video.pause();
                    }).catch(function () {});
                } else {
                    video.pause();
                }

                measure();
                requestLoop();
            }

            video.addEventListener('loadedmetadata', onVideoReady);
            video.addEventListener('loadeddata', onVideoReady);
            video.addEventListener('canplay', onVideoReady);
            if (video.readyState >= 1) onVideoReady();

            video.addEventListener('error', function () {
                isSeeking = false;
                isVideoReady = false;
            });

            /* Buffered-range guard. With the blob path this is effectively a
               no-op because the whole file is resident, but it still protects
               the streaming fallback from stalling the decoder indefinitely. */
            function clampToBuffered(time) {
                var r = video.buffered;
                if (!r || r.length === 0) return 0;

                var i;
                for (i = 0; i < r.length; i++) {
                    if (time >= r.start(i) && time <= r.end(i)) return time;
                }

                var best = r.end(0);
                for (i = 0; i < r.length; i++) {
                    if (r.start(i) <= time) best = r.end(i);
                }
                return Math.max(0, Math.min(best - 0.05, videoDuration));
            }

            function markSeekComplete() {
                isSeeking = false;
            }

            video.addEventListener('seeked', markSeekComplete);

            /* At most one seek in flight. Requests arriving while one is
               pending are dropped — the rAF loop re-requests the latest
               position next frame, so nothing is lost and no queue builds. */
            function issueSeek(time) {
                if (!isVideoReady || isSeeking) return;

                var safe = clampToBuffered(time);
                if (Math.abs(safe - lastSeekIssued) < SEEK_DEADZONE) return;

                isSeeking = true;
                lastSeekIssued = safe;

                try {
                    if (hasFastSeek) {
                        video.fastSeek(safe);
                    } else {
                        video.currentTime = safe;
                    }
                    if (hasRVFC) {
                        video.requestVideoFrameCallback(markSeekComplete);
                    }
                } catch (err) {
                    isSeeking = false;
                }
            }

            /* Scroll handler: pure measurement, zero side effects. */
            function onScroll() {
                var scrolled = window.scrollY - heroTop;
                var p = scrolled / scrollRange;
                p = p < 0 ? 0 : p > 1 ? 1 : p;

                targetTime = p * videoDuration;
                targetOpacity = p > 0.8 ? (p - 0.8) / 0.2 : 0;

                requestLoop();
            }

            function requestLoop() {
                if (rafId === null) rafId = requestAnimationFrame(tick);
            }

            function tick() {
                rafId = null;

                var delta = targetTime - currentTime;
                if (Math.abs(delta) < SETTLE_EPSILON) {
                    currentTime = targetTime;
                } else {
                    currentTime += delta * SMOOTHING;
                }

                issueSeek(currentTime);

                var next = Math.round(targetOpacity * 1000) / 1000;
                var opacityDirty = next !== appliedOpacity;
                if (opacityDirty) {
                    appliedOpacity = next;
                    overlay.style.opacity = next;
                }

                var settled =
                    currentTime === targetTime && !opacityDirty && !isSeeking;

                if (!settled) rafId = requestAnimationFrame(tick);
            }

            window.addEventListener('scroll', onScroll, { passive: true });

            var resizeTimer = null;
            window.addEventListener('resize', function () {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(measure, 120);
            }, { passive: true });

            window.addEventListener('orientationchange', function () {
                setTimeout(measure, 250);
            }, { passive: true });

            /* Web fonts and lazy images shift layout after DOMContentLoaded,
               invalidating cached geometry. Re-measure on both. */
            window.addEventListener('load', measure);
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(measure).catch(function () {});
            }

            /* Release decoder pressure when the tab is hidden. */
            document.addEventListener('visibilitychange', function () {
                if (document.hidden && rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                } else if (!document.hidden) {
                    requestLoop();
                }
            });

            measure();
        }

        /* ---- Reduced motion: hold a still frame, no scrubbing -------------- */
        function setupReducedMotion() {
            document.documentElement.style.scrollBehavior = 'auto';

            function showStill() {
                if (!isNaN(video.duration) && video.duration > 0) {
                    try {
                        video.currentTime = video.duration * 0.15;
                    } catch (e) {}
                }
                video.pause();
            }

            video.addEventListener('loadeddata', showStill, { once: true });
            if (video.readyState >= 2) showStill();

            overlay.style.opacity = 0;

            var scenes = document.querySelectorAll('.scene-content');
            for (var i = 0; i < scenes.length; i++) {
                scenes[i].classList.add('is-visible');
            }
        }

        /* ==================================================================
           2. Scene reveal
           ================================================================== */
        function initSceneReveal() {
            var scenes = document.querySelectorAll('.scene-content');
            if (!scenes.length || prefersReducedMotion) return;

            var observer = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    entry.target.classList.toggle(
                        'is-visible',
                        entry.isIntersecting
                    );
                });
            }, {
                root: null,
                rootMargin: '-12% 0px -12% 0px',
                threshold: 0.25
            });

            scenes.forEach(function (s) {
                observer.observe(s);
            });
        }

        /* ==================================================================
           3. Mobile menu — class toggles, not inline display writes
           ================================================================== */
        function initMobileMenu() {
            var toggle = document.querySelector('.mobile-menu-toggle');
            var nav = document.querySelector('.header-nav');
            var cta = document.querySelector('.btn-discover');
            if (!toggle) return;

            toggle.addEventListener('click', function () {
                var isOpen = toggle.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', String(isOpen));
                if (nav) nav.classList.toggle('is-open', isOpen);
                if (cta) cta.classList.toggle('is-open', isOpen);
                document.body.style.overflow = isOpen ? 'hidden' : '';
            });
        }

        /* ==================================================================
           4. Anchor scrolling
           ================================================================== */
        function initAnchorScroll() {
            var toggle = document.querySelector('.mobile-menu-toggle');
            var nav = document.querySelector('.header-nav');
            var cta = document.querySelector('.btn-discover');

            document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
                anchor.addEventListener('click', function (e) {
                    var id = this.getAttribute('href');
                    if (!id || id === '#') return;

                    var target = document.querySelector(id);
                    if (!target) return;

                    e.preventDefault();
                    target.scrollIntoView({
                        behavior: prefersReducedMotion ? 'auto' : 'smooth',
                        block: 'start'
                    });

                    if (toggle && toggle.classList.contains('is-open')) {
                        toggle.classList.remove('is-open');
                        toggle.setAttribute('aria-expanded', 'false');
                        if (nav) nav.classList.remove('is-open');
                        if (cta) cta.classList.remove('is-open');
                        document.body.style.overflow = '';
                    }
                });
            });
        }
    }
})();
