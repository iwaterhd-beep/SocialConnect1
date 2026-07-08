/**
 * Landing — header al scroll, menú móvil y animaciones reveal.
 */
(function () {
  const header = document.getElementById('landing-header');
  const menuBtn = document.getElementById('landing-menu-btn');
  const mobileNav = document.getElementById('landing-mobile-nav');
  const authPage = document.getElementById('auth-page');

  function onScroll() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 12);
  }

  function closeMobileNav() {
    if (!mobileNav || !menuBtn) return;
    mobileNav.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('landing-menu-open');
  }

  function openMobileNav() {
    if (!mobileNav || !menuBtn) return;
    mobileNav.classList.add('is-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('landing-menu-open');
  }

  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', () => {
      if (mobileNav.classList.contains('is-open')) closeMobileNav();
      else openMobileNav();
    });

    mobileNav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeMobileNav);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMobileNav();
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth >= 900) closeMobileNav();
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  let revealStarted = false;

  function startRevealAnimations() {
    if (revealStarted) return;
    if (!authPage || authPage.classList.contains('auth-page--splash-hidden')) return;
    revealStarted = true;

    const revealEls = document.querySelectorAll('[data-reveal]');
    if (!revealEls.length) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      revealEls.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { root: null, rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );

    revealEls.forEach((el, i) => {
      const delay = el.getAttribute('data-reveal-delay');
      if (!delay) {
        const parent = el.closest('[data-reveal-stagger]');
        if (parent) {
          const siblings = [...parent.querySelectorAll('[data-reveal]')];
          const idx = siblings.indexOf(el);
          if (idx >= 0) el.style.setProperty('--reveal-delay', `${idx * 80}ms`);
        } else if (i < 12) {
          el.style.setProperty('--reveal-delay', `${Math.min(i, 6) * 60}ms`);
        }
      } else {
        el.style.setProperty('--reveal-delay', delay);
      }
      observer.observe(el);
    });

    window.requestAnimationFrame(() => {
      revealEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.92) {
          el.classList.add('is-visible');
          observer.unobserve(el);
        }
      });
    });
  }

  window.addEventListener('socialconnect:landing-ready', startRevealAnimations);
  startRevealAnimations();
})();
