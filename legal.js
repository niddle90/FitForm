/* Progressive enhancement for the legal pages: highlights the current section
   in the table of contents and folds the mobile contents list after a tap.
   The pages read fine without it. */
(function () {
  var sections = document.querySelectorAll('.doc section[id]');
  var links = document.querySelectorAll('.toc a, .toc-m a');
  if (!sections.length || !links.length) return;

  function setCurrent(id) {
    links.forEach(function (a) {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
  }

  if ('IntersectionObserver' in window) {
    var visible = new Set();

    function update() {
      // The last sections are shorter than the reading band, so once the page
      // is scrolled to its end, pin the final entry instead.
      var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atEnd) return setCurrent(sections[sections.length - 1].id);
      // Otherwise the topmost section currently in the reading band wins.
      for (var i = 0; i < sections.length; i++) {
        if (visible.has(sections[i].id)) return setCurrent(sections[i].id);
      }
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        });
        update();
      },
      { rootMargin: '-15% 0px -70% 0px' }
    );
    sections.forEach(function (s) { io.observe(s); });
    window.addEventListener('scroll', update, { passive: true });
  }

  document.querySelectorAll('.toc-m a').forEach(function (a) {
    a.addEventListener('click', function () {
      var d = a.closest('details');
      if (d) d.removeAttribute('open');
    });
  });
})();
