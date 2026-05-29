// pix-modal.js — SyncPayments, sem formulário
// Inclua após content-unlock.js no index.html

(function () {
  var SUPABASE_URL  = window.SUPABASE_URL  || '';
  var SUPABASE_ANON = window.SUPABASE_ANON || '';

  var _gwConfig = null;
  var _selectedPrice = 0;
  var _timerInterval = null;
  var _pixLoading = false; // guard contra chamadas duplicadas

  // ── Carrega gateway_config uma vez ──────────────────────
  function loadGwConfig() {
    if (_gwConfig) return Promise.resolve(_gwConfig);
    return fetch(SUPABASE_URL + '/rest/v1/site_config?key=eq.gateway_config&select=value', {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON }
    })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { _gwConfig = (rows[0] && rows[0].value) || {}; return _gwConfig; })
      .catch(function () { return {}; });
  }

  // ── Abre modal e já dispara geração do PIX ──────────────
  window.openPayModal = function (planCode, priceStr) {
    // Bloqueia double-click / double-tap / eventos duplicados
    if (_pixLoading) return;

    var raw = (priceStr || '0').replace(/[^\d,\.]/g, '').replace(',', '.');
    _selectedPrice = parseFloat(raw) || 0;

    var modal = document.getElementById('payModal');
    if (!modal) return;

    setElText('payPriceSummary', priceStr || '—');
    resetModal();
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Gera o PIX imediatamente
    gerarPix();
  };

  // ── Fecha modal ─────────────────────────────────────────
  function fecharModal() {
    var modal = document.getElementById('payModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _pixLoading = false;
    _gwConfig = null; // limpa cache para sempre buscar config atualizada
  }

  // ── Reset visual (NÃO toca em _pixLoading) ──────────────
  function resetModal() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    var result = document.getElementById('pixResult');
    if (result) result.innerHTML = '';
    setElText('pixStatus', '⏳ Gerando PIX...');
    setElDisplay('pixStatus', '');
    setElDisplay('generatePixBtn', 'none');
  }

  // ── Gera PIX via Netlify Function ───────────────────────
  function gerarPix() {
    if (_pixLoading) return;
    if (!_selectedPrice) { setElText('pixStatus', '❌ Valor inválido.'); return; }

    _pixLoading = true;

    loadGwConfig().then(function (cfg) {
      var gw = cfg.gateway || 'syncpay';

      // Valida campos obrigatórios por gateway
      var missing = false;
      if (gw === 'syncpay'  && (!cfg.syncpay_client_id || !cfg.syncpay_client_secret)) missing = true;
      if (gw === 'nexuspag' && !cfg.nexuspag_api_key)                                   missing = true;
      if (gw === 'asaas'    && !cfg.asaas_api_key)                                      missing = true;
      if (gw === 'efibank'  && (!cfg.efibank_client_id || !cfg.efibank_client_secret))  missing = true;
      if (gw === 'primepag' && (!cfg.primepag_client_id || !cfg.primepag_client_secret)) missing = true;

      if (missing) {
        setElText('pixStatus', '❌ Credenciais do gateway não configuradas no painel admin.');
        _pixLoading = false;
        return;
      }

      fetch('/api/pix-cashin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(
          { amount: _selectedPrice, gateway: cfg.gateway || 'syncpay', site_url: cfg.site_url || '' },
          cfg // passa todas as credenciais da config (client_id, api_key, etc.)
        )),
      })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          _pixLoading = false;
          if (!res.ok || !res.data.ok) {
            setElText('pixStatus', '❌ ' + (res.data.error || 'Erro ao gerar PIX.'));
            setElDisplay('generatePixBtn', '');
            return;
          }
          setElDisplay('pixStatus', 'none');
          renderResult(res.data);
        })
        .catch(function() {
          _pixLoading = false;
          setElText('pixStatus', '❌ Falha de conexão. Tente novamente.');
          setElDisplay('generatePixBtn', '');
        });
    });
  }

  // ── Renderiza QR + copia e cola ─────────────────────────
  function renderResult(data) {
    var result = document.getElementById('pixResult');
    if (!result) return;

    var html = '';

    if (data.pix_code) {
      var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(data.pix_code);
      html += '<img id="pixQrImg" src="' + qrUrl + '" alt="QR Code PIX" style="display:block;margin:8px auto;width:160px;height:160px;border-radius:12px;">';
      html += '<p style="font-size:11px;color:var(--text-dim,#888);text-align:center;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em">Pix Copia e Cola</p>';
      html += '<textarea id="pixCodigo" readonly style="width:100%;box-sizing:border-box;background:var(--surface2,#111);border:1px solid var(--border,#222);border-radius:8px;padding:10px;color:var(--accent2,#4fc3f7);font-size:11px;font-family:monospace;resize:none;min-height:56px;word-break:break-all;outline:none">' + escHtml(data.pix_code) + '</textarea>';
      html += '<button onclick="pixCopiar()" style="display:block;width:100%;margin-top:10px;padding:13px;background:var(--accent,#e91e8c);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;">📋 Copiar código PIX</button>';
    }

    html += '<p id="pixTimer" style="text-align:center;font-size:12px;color:var(--text-dim,#888);margin-top:14px">⏱ Expira em <strong>30:00</strong></p>';

    result.innerHTML = html;
    window._pixCode = data.pix_code || '';
    startTimer('pixTimer', 30 * 60);
  }

  // ── Copiar código ───────────────────────────────────────
  window.pixCopiar = function () {
    var code = window._pixCode || '';
    if (!code) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(function () { toast('✅ Código copiado!'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta); toast('✅ Código copiado!');
    }
  };

  // ── Timer countdown ─────────────────────────────────────
  function startTimer(elId, seconds) {
    var rem = seconds;
    _timerInterval = setInterval(function () {
      rem--;
      var el = document.getElementById(elId);
      if (rem <= 0) {
        clearInterval(_timerInterval);
        if (el) el.innerHTML = '⚠️ Código expirado. Feche e clique no plano novamente.';
        return;
      }
      var m = String(Math.floor(rem / 60)).padStart(2, '0');
      var s = String(rem % 60).padStart(2, '0');
      if (el) el.innerHTML = '⏱ Expira em <strong>' + m + ':' + s + '</strong>';
    }, 1000);
  }

  // ── Bind eventos ────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var closeBtn = document.getElementById('payClose');
    var backdrop = document.getElementById('payBackdrop');
    if (closeBtn) closeBtn.addEventListener('click', fecharModal);
    if (backdrop) backdrop.addEventListener('click', fecharModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fecharModal(); });

    // Botão "Tentar novamente"
    var genBtn = document.getElementById('generatePixBtn');
    if (genBtn) {
      genBtn.textContent = '🔄 Tentar novamente';
      genBtn.addEventListener('click', function () {
        _pixLoading = false; // permite nova tentativa explícita
        setElDisplay('generatePixBtn', 'none');
        resetModal();
        gerarPix();
      });
    }

    // Injeta #pixResult e #pixStatus no modal se não existirem
    injectModalStructure();

    // Bind botões de plano removido — onclick já definido inline no HTML
  });

  // ── Injeta estrutura no .pm-body ────────────────────────
  function injectModalStructure() {
    var body = document.querySelector('.pm-body');
    if (!body || document.getElementById('pixResult')) return;

    ['pixKey','copyPix','qrcode','awaitingPrice'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    var genBtn = document.getElementById('generatePixBtn');

    var status = document.createElement('p');
    status.id = 'pixStatus';
    status.style.cssText = 'text-align:center;font-size:13px;color:var(--text-dim,#aaa);margin:16px 0 4px';
    status.textContent = '';

    var result = document.createElement('div');
    result.id = 'pixResult';
    result.style.marginTop = '8px';

    if (genBtn) {
      body.insertBefore(status, genBtn);
      body.insertBefore(result, genBtn);
      genBtn.style.display = 'none';
    } else {
      body.appendChild(status);
      body.appendChild(result);
    }
  }

  // ── Helpers ─────────────────────────────────────────────
  function setElText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
  function setElDisplay(id, v) { var e = document.getElementById(id); if (e) e.style.display = v; }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:12px;font-size:14px;z-index:99999;box-shadow:0 4px 24px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  }
})();
