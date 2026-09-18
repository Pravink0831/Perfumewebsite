/* ==========================================================================
   P K | Fragrance After Dark
   Scroll-driven cinematic hero
   --------------------------------------------------------------------------
   PERFORMANCE MODEL

   Scroll events never touch the video and never touch the DOM. They only
   record a target value. A single requestAnimationFrame loop owns every read,
   every write and every media seek.

     Scroll  ->  record target only (cached geometry, no forced layout)
     rAF     ->  ease playhead toward target, issue at most one seek,
                 write styles once, dirty-checked

   Video time is eased (LERP) rather than set directly, so the decoder is never
   asked to service more seeks than it can sustain. This is what converts
   stutter into glide.
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

        var prefersReducedMotion =
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        /* fastSeek() snaps to the nearest keyframe instead of decoding to an
           exact frame. With an all-intra encode every frame IS a keyframe, so
           this is lossless in practice and cheaper. Chromium does not
           implement it; the fallback is a normal currentTime assignment. */
        var hasFastSeek = !!(video && typeof video.fastSeek === 'function');

        /* requestVideoFrameCallback fires when a frame has actually been
           presented to the compositor — a more accurate "seek finished"
           signal than the 'seeked' event, which can fire early. */
        var hasRVFC =
            !!(video && typeof video.requestVideoFrameCallback === 'function');

        initScrollVideo();
        initSceneReveal();
        initMobileMenu();
        initAnchorScroll();

        /* ==================================================================
           1. Scroll-driven video scrubbing
           ================================================================== */
        function initScrollVideo() {
            if (!video || !heroSection || !overlay) return;

            if (prefersReducedMotion) {
                setupReducedMotion();
                return;
            }

            /* ---- Tunables -------------------------------------------------
               SMOOTHING       0-1. Lower = smoother and heavier, higher =
                               snappier and closer to the scroll. 0.12 gives an
                               inertial, luxury feel. Try 0.18 if it feels laggy
                               or 0.08 if it feels twitchy.
               SEEK_DEADZONE   Seconds. Below this delta we issue no seek at
                               all, which kills pointless sub-frame churn.
               SETTLE_EPSILON  Seconds. Within this, snap and idle the loop.
               ---------------------------------------------------------------- */
            var SMOOTHING = 0.12;
            var SEEK_DEADZONE = 0.015;
            var SETTLE_EPSILON = 0.002;

            var videoDuration = 0;
            var isVideoReady = false;

            var targetTime = 0;    // where scroll says the playhead should be
            var currentTime = 0;   // where the eased playhead actually is
            var lastSeekIssued = -1;

            var targetOpacity = 0;
            var appliedOpacity = -1; // -1 forces the first write

            var isSeeking = false;
            var rafId = null;

            /* Geometry is cached and recomputed only on resize. It is never
               measured inside the scroll handler — that was the layout thrash
               in the original implementation. */
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

            /* ---- Media readiness ------------------------------------------ */
            function onVideoReady() {
                if (isVideoReady) return;
                if (isNaN(video.duration) || video.duration <= 0) return;

                videoDuration = video.duration;
                isVideoReady = true;

                /* Some engines will not render the first frame until playback
                   has been kicked at least once. play()/pause() forces it and
                   is permitted because the element is muted. */
                var kick = video.play();
                if (kick && typeof kick.then === 'function') {
                    kick.then(function () {
                        video.pause();
                    }).catch(function () {
                        /* muted autoplay blocked — harmless, poster shows */
                    });
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

            /* ---- Buffered-range guard --------------------------------------
               Seeking into an unbuffered region stalls the decoder with no
               'seeked' event for an unbounded period, which reads as a freeze.
               Clamp the request into territory we actually hold. */
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

            /* ---- Seek execution --------------------------------------------
               At most one seek is ever in flight. Anything requested while a
               seek is pending is simply dropped — the rAF loop will re-request
               the latest position on the next frame anyway, so nothing is lost
               and no queue can build up. */
            function markSeekComplete() {
                isSeeking = false;
            }

            video.addEventListener('seeked', markSeekComplete);

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

            /* ---- Scroll handler: pure measurement, zero side effects -------- */
            function onScroll() {
                var scrolled = window.scrollY - heroTop;
                var p = scrolled / scrollRange;
                p = p < 0 ? 0 : p > 1 ? 1 : p;

                targetTime = p * videoDuration;
                targetOpacity = p > 0.8 ? (p - 0.8) / 0.2 : 0;

                requestLoop();
            }

            /* ---- The single rAF loop ---------------------------------------- */
            function requestLoop() {
                if (rafId === null) rafId = requestAnimationFrame(tick);
            }

            function tick() {
                rafId = null;

                /* Ease the playhead toward the scroll target. */
                var delta = targetTime - currentTime;
                if (Math.abs(delta) < SETTLE_EPSILON) {
                    currentTime = targetTime;
                } else {
                    currentTime += delta * SMOOTHING;
                }

                /* Media write. */
                issueSeek(currentTime);

                /* Style write, dirty-checked so we never touch the DOM
                   unless the value genuinely changed. */
                var next = Math.round(targetOpacity * 1000) / 1000;
                var opacityDirty = next !== appliedOpacity;
                if (opacityDirty) {
                    appliedOpacity = next;
                    overlay.style.opacity = next;
                }

                /* Keep spinning only while there is work left. */
                var settled =
                    currentTime === targetTime && !opacityDirty && !isSeeking;

                if (!settled) rafId = requestAnimationFrame(tick);
            }

            /* ---- Listeners --------------------------------------------------- */
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
               which invalidates our cached geometry. Re-measure on both. */
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
           3. Mobile menu
           Class toggles rather than inline display writes — fewer style
           recalcs per tap and CSS stays the single source of truth.
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
