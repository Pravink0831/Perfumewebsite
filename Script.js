document.addEventListener('DOMContentLoaded', () => {
    /* ======================================================================
       1. Cinematic Scroll-Driven Video
       ====================================================================== */
    const video = document.getElementById('hero-video');
    const heroSection = document.getElementById('scroll-hero');
    const overlay = document.querySelector('.video-fade-overlay');

    let videoDuration = 0;
    let isVideoReady = false;
    let scrollProgress = 0;

    // Seek throttle state — prevents overlapping blocking seeks
    let isSeeking = false;
    let pendingSeek = null;

    video.addEventListener('seeked', () => {
        isSeeking = false;
        // If user scrolled during seek, chase to latest position
        if (pendingSeek !== null) {
            const t = pendingSeek;
            pendingSeek = null;
            performSeek(t);
        }
    });

    video.addEventListener('error', () => {
        isSeeking = false;
        pendingSeek = null;
    });

    function performSeek(time) {
        if (!isVideoReady) return;
        try {
            isSeeking = true;
            video.currentTime = time;
        } catch (e) {
            isSeeking = false;
        }
    }

    // Wait for video metadata
    const onVideoReady = () => {
        if (!isNaN(video.duration) && video.duration > 0 && !isVideoReady) {
            videoDuration = video.duration;
            isVideoReady = true;
            video.currentTime = 0;
            video.play().then(() => {
                video.pause();
            }).catch(() => {});
        }
    };

    video.addEventListener('loadedmetadata', onVideoReady);
    if (video.readyState >= 1) onVideoReady();
    video.addEventListener('canplay', () => {
        if (!isVideoReady) onVideoReady();
    });

    // Scroll handler — only computes target time, no seeking here
    const handleScroll = () => {
        const rect = heroSection.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const totalScrollDistance = rect.height - viewportHeight;
        const scrollPosition = -rect.top;

        let progress = scrollPosition / totalScrollDistance;
        progress = Math.max(0, Math.min(1, progress));
        scrollProgress = progress;

        // Ending transition: Fade overlay in last 20%
        if (progress > 0.8) {
            overlay.style.opacity = (progress - 0.8) / 0.2;
        } else {
            overlay.style.opacity = 0;
        }

        // Throttle seeks: only queue if not already seeking
        if (isVideoReady) {
            const targetTime = progress * videoDuration;
            if (!isSeeking) {
                performSeek(targetTime);
            } else {
                // Store latest position — will chase after current seek finishes
                pendingSeek = targetTime;
            }
        }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    /* ======================================================================
       2. Intersection Observer for Text Scenes Reveal
       ====================================================================== */
    const scenes = document.querySelectorAll('.scene-content');
    
    const sceneObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
            } else {
                entry.target.classList.remove('is-visible');
            }
        });
    }, {
        root: null,
        rootMargin: '-10% 0px -10% 0px',
        threshold: [0.1, 0.3, 0.5]
    });

    scenes.forEach(scene => sceneObserver.observe(scene));

    /* ======================================================================
       3. Mobile Menu Toggle
       ====================================================================== */
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const headerNav = document.querySelector('.header-nav');
    const btnDiscover = document.querySelector('.btn-discover');
    
    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', () => {
            const isOpen = mobileMenuToggle.classList.toggle('is-open');
            if (headerNav) headerNav.style.display = isOpen ? 'flex' : 'none';
            if (btnDiscover) btnDiscover.style.display = isOpen ? 'inline-block' : 'none';
        });
    }

    /* ======================================================================
       4. Smooth Scroll for Anchor Links
       ====================================================================== */
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                
                // Close mobile menu if open
                if (mobileMenuToggle?.classList.contains('is-open')) {
                    mobileMenuToggle.classList.remove('is-open');
                    if (headerNav) headerNav.style.display = 'none';
                    if (btnDiscover) btnDiscover.style.display = 'none';
                }
            }
        });
    });

    /* ======================================================================
       5. Reduced Motion Support
       ====================================================================== */
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    
    if (prefersReducedMotion.matches) {
        document.documentElement.style.scrollBehavior = 'auto';
        video.style.display = 'none';
        overlay.style.display = 'none';
        scenes.forEach(scene => scene.classList.add('is-visible'));
    }
});