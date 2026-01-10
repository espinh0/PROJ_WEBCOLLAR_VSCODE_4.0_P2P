<script>
// Controle de visibilidade para elementos exclusivos do host
(function () {
  const HOST_CLASS = 'host-only';
  const HIDDEN_CLASS = 'd-none';
  const HOST_FLAG_CLASS = 'host-on';

  // CSS de seguran├ºa: esconde host-only por padr├úo at├® confirmarmos host
  (function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .${HOST_CLASS} { display: none !important; }
      .${HOST_FLAG_CLASS} .${HOST_CLASS} { display: initial !important; }
    `;
    document.head.appendChild(style);
  })();

  function isHost() {
    try {
      const peer = (window.Flowgate && window.Flowgate.localPeer) ? window.Flowgate.localPeer : window.__TRYSTERO_PEER__;
      const tags = (peer && typeof peer.getLocalTags === 'function') ? peer.getLocalTags() : [];
      return Array.isArray(tags) && tags.map((t) => String(t || '').toLowerCase()).includes('host');
    } catch {
      return false;
    }
  }

  function applyVisibility(root = document) {
    const host = isHost();
    document.documentElement.classList.toggle(HOST_FLAG_CLASS, host);

    const hostOnlyNodes = Array.from(root.querySelectorAll(`.${HOST_CLASS}`));
    hostOnlyNodes.forEach((el) => {
      if (host) {
        el.classList.remove(HIDDEN_CLASS);
      } else {
        el.classList.add(HIDDEN_CLASS);
      }
    });
  }

  // Observa novas inser├º├Áes no DOM (widgets carregados depois)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.classList.contains(HOST_CLASS) || node.querySelector(`.${HOST_CLASS}`)) {
          applyVisibility(node);
        }
      });
    }
  });

  function init() {
    applyVisibility();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('flowgate:local_tags_changed', () => applyVisibility());
  window.addEventListener('trystero:localTags', () => applyVisibility());
})();
</script>
