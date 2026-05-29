// pix-modal.js
// ============================================================
// Lógica do modal de pagamento PIX
// Carrega gateway_config do Supabase e dispara a cobrança
// Inclua APÓS content-unlock.js no index.html:
//   <script src="pix-modal.js"></script>
// ============================================================

(function () {
  // ── CONFIG ── deve coincidir com o index.html ──────────────
  var SUPABASE_URL  = window.SUPABASE_URL  || '';
  var SUPABASE_ANON = window.SUPABASE_ANON || '';
  // URL base das Supabase Edge Functions
  var API_BASE = (window.SUPABASE_URL || '').replace(/\/$/, '');

  // Cache do gateway_config carregado do Supabase
  var _gwConfig = null;

  // Plano selecionado pelo usuário (preenchido quando abre o modal)
  var _selectedPlan = { code: null, price: null, label: null };

  // ── CARREGA gateway_config do Supabase (uma vez) ───────────
  function loadGatewayConfig() {
    if (_gwConfig) return Promise.resolve(_gwConfig);
    if (!SUPABASE_URL || !SUPABASE_ANON) {
      console.warn('[pix-modal] SUPABASE_URL / SUPABASE_ANON não definidos');
      return Promise.resolve(null);
    }
    return fetch(SUPABASE_URL + '/rest/v1/site_config?key=eq.gateway_config&select=value', {
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        _gwConfig = (rows && rows[0] && rows[0].value) || {};
        return _gwConfig;
      })
      .catch(function (e) {
        console.warn('[pix-modal] Falha ao carregar gateway_config:', e);
        return {};
      });
  }

  // ── OPEN MODAL ─────────────────────────────────────────────
  // Chamado pelos botões de assinar: openPayModal('PLAN_1M', 'R$ 29,90', '1 mês')
  window.openPayModal = function (planCode, priceStr, planLabel) {
    _selectedPlan = { code: planCode, price: priceStr, label: planLabel || planCode };

    var modal = document.getElementById('payModal');
    if (!modal) return;

    // Atualiza valor exibido
    setElText('payPriceSummary', priceStr || '—');

    // Reset estado anterior
    resetPixState();

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Pré-carrega config em background
    loadGatewayConfig();
  };

  // ── CLOSE MODAL ────────────────────────────────────────────
  function closePayModal() {
    var modal = document.getElementById('payModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    resetPixState();
  }

  function resetPixState() {
    setElText('awaitingPrice', 'Aguardando geração do Pix');
    setElDisplay('awaitingPrice', '');
    setElDisplay('qrcode', 'none');
    setElDisplay('pixKey', 'none');
    setElDisplay('copyPix', 'none');
    setElDisplay('pixCopyPasteBlock', 'none');
    setElDisplay('pixGenericMsg', 'none');
    setElDisplay('payFormBlock', '');
    setElDisplay('generatePixBtn', '');
    var qrEl = document.getElementById('qrcode');
    if (qrEl) qrEl.innerHTML = '';
    var cpImg = document.getElementById('pixCopyPasteBlock');
    if (cpImg) cpImg.innerHTML = '';
  }

  // ── BIND EVENTOS ───────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Fecha modal
    var closeBtn = document.getElementById('payClose');
    var backdrop = document.getElementById('payBackdrop');
    if (closeBtn) closeBtn.addEventListener('click', closePayModal);
    if (backdrop) backdrop.addEventListener('click', closePayModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePayModal();
    });

    // Botão "Gerar Pix"
    var genBtn = document.getElementById('generatePixBtn');
    if (genBtn) genBtn.addEventListener('click', onGeneratePix);

    // Botão copiar chave
    var copyBtn = document.getElementById('copyPix');
    if (copyBtn) copyBtn.addEventListener('click', onCopyPix);

    // Injetar formulário de dados do pagador no modal (se não existir)
    injectPayerForm();

    // Bind dos botões de plano existentes na página
    bindPlanButtons();
  });

  // ── INJETA FORMULÁRIO ──────────────────────────────────────
  function injectPayerForm() {
    var body = document.querySelector('.pm-body');
    var genBtn = document.getElementById('generatePixBtn');
    if (!body || !genBtn || document.getElementById('payFormBlock')) return;

    var form = document.createElement('div');
    form.id = 'payFormBlock';
    form.innerHTML = [
      '<div class="pm-divider"></div>',
      '<div class="pm-form-row">',
      '  <label class="pm-form-label" for="payerName">Nome completo</label>',
      '  <input class="pm-form-input" id="payerName" type="text" placeholder="João da Silva" autocomplete="name">',
      '</div>',
      '<div class="pm-form-row">',
      '  <label class="pm-form-label" for="payerEmail">E-mail</label>',
      '  <input class="pm-form-input" id="payerEmail" type="email" placeholder="joao@email.com" autocomplete="email">',
      '</div>',
      '<div class="pm-form-row">',
      '  <label class="pm-form-label" for="payerCpf">CPF <span style="color:var(--text-dim);font-size:.85em">(obrigatório em alguns gateways)</span></label>',
      '  <input class="pm-form-input" id="payerCpf" type="text" placeholder="000.000.000-00" maxlength="14" autocomplete="off" inputmode="numeric">',
      '</div>',
      '<div class="pm-form-row">',
      '  <label class="pm-form-label" for="payerPhone">Telefone <span style="color:var(--text-dim);font-size:.85em">(opcional)</span></label>',
      '  <input class="pm-form-input" id="payerPhone" type="tel" placeholder="(11) 91234-5678" autocomplete="tel">',
      '</div>',
    ].join('');

    // Injeta antes do botão gerar
    body.insertBefore(form, genBtn);

    // Máscara CPF
    var cpfInput = document.getElementById('payerCpf');
    if (cpfInput) {
      cpfInput.addEventListener('input', function () {
        var v = this.value.replace(/\D/g, '').slice(0, 11);
        if (v.length > 9) v = v.replace(/^(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
        else if (v.length > 6) v = v.replace(/^(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
        else if (v.length > 3) v = v.replace(/^(\d{3})(\d{0,3})/, '$1.$2');
        this.value = v;
      });
    }

    // Injeta bloco de resultado do PIX (copia e cola + qr)
    var resultBlock = document.createElement('div');
    resultBlock.id = 'pixCopyPasteBlock';
    resultBlock.style.display = 'none';
    body.insertBefore(resultBlock, genBtn);

    // Mensagem genérica
    var genericMsg = document.createElement('div');
    genericMsg.id = 'pixGenericMsg';
    genericMsg.style.cssText = 'display:none;margin:12px 0;padding:14px;background:var(--surface2,#1a1a1a);border-radius:10px;font-size:13px;line-height:1.6;color:var(--text-dim,#aaa)';
    body.insertBefore(genericMsg, genBtn);

    // Estilos inline para o formulário
    injectFormStyles();
  }

  function injectFormStyles() {
    if (document.getElementById('pmFormStyles')) return;
    var style = document.createElement('style');
    style.id = 'pmFormStyles';
    style.textContent = [
      '.pm-form-row{margin-bottom:12px}',
      '.pm-form-label{display:block;font-size:12px;font-weight:600;color:var(--text-dim,#aaa);margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}',
      '.pm-form-input{width:100%;box-sizing:border-box;background:var(--surface2,#1a1a1a);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px 12px;color:var(--text,#fff);font-size:14px;outline:none;transition:border-color .2s}',
      '.pm-form-input:focus{border-color:var(--accent,#e91e8c)}',
      '.pm-form-input::placeholder{color:var(--text-dim,#555)}',
      '#pixCopyPasteBlock .pcp-label{font-size:11px;color:var(--text-dim,#888);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}',
      '#pixCopyPasteBlock .pcp-input{width:100%;box-sizing:border-box;background:var(--surface2,#111);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px 12px;color:var(--accent2,#4fc3f7);font-size:12px;word-break:break-all;cursor:text;outline:none;resize:none;font-family:monospace;min-height:60px}',
      '#pixCopyPasteBlock .pcp-copy{display:block;width:100%;margin-top:8px;padding:11px;background:var(--accent,#e91e8c);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;text-align:center}',
      '#pixCopyPasteBlock .pcp-copy:active{opacity:.8}',
      '#pixCopyPasteBlock .pcp-qr{display:block;margin:16px auto 0;max-width:200px;border-radius:12px}',
      '#pixCopyPasteBlock .pcp-timer{text-align:center;font-size:12px;color:var(--text-dim,#888);margin-top:8px}',
      '#pixGenericMsg .pgm-key-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);margin-bottom:4px}',
      '#pixGenericMsg .pgm-key-val{font-size:15px;font-weight:700;color:var(--text,#fff);word-break:break-all;margin-bottom:10px}',
      '#pixGenericMsg .pgm-copy{display:block;width:100%;padding:11px;background:var(--accent,#e91e8c);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;text-align:center}',
    ].join('');
    document.head.appendChild(style);
  }

  // ── GERA PIX ───────────────────────────────────────────────
  function onGeneratePix() {
    var name  = (document.getElementById('payerName')  || {}).value || '';
    var email = (document.getElementById('payerEmail') || {}).value || '';
    var cpf   = (document.getElementById('payerCpf')   || {}).value || '';
    var phone = (document.getElementById('payerPhone') || {}).value || '';

    if (!name.trim()) { showFormError('payerName', 'Informe seu nome completo'); return; }
    if (!email.trim() || !email.includes('@')) { showFormError('payerEmail', 'Informe um e-mail válido'); return; }

    // Extrai valor numérico do preço (ex: "R$ 29,90" → 29.90)
    var amountRaw = (_selectedPlan.price || '0').replace(/[^\d,\.]/g, '').replace(',', '.');
    var amount = parseFloat(amountRaw);
    if (!amount || amount <= 0) {
      showPixStatus('Valor inválido. Feche e tente novamente.', 'err');
      return;
    }

    loadGatewayConfig().then(function (cfg) {
      if (!cfg || !cfg.gateway) {
        showPixStatus('Gateway de pagamento não configurado. Entre em contato com o administrador.', 'err');
        return;
      }

      // Esconde formulário, mostra loading
      setElDisplay('payFormBlock', 'none');
      setElDisplay('generatePixBtn', 'none');
      setElDisplay('awaitingPrice', '');
      setElText('awaitingPrice', '⏳ Gerando PIX, aguarde...');

      var body = JSON.stringify({
        gateway: cfg.gateway,
        amount: amount,
        name: name.trim(),
        email: email.trim(),
        cpf: cpf.trim(),
        phone: phone.trim(),
      });

      fetch(API_BASE + '/functions/v1/pix-cashin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_ANON,
        },
        body: body,
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.data.ok) {
            var msg = (res.data && res.data.error) || 'Erro ao gerar PIX. Tente novamente.';
            showPixStatus('❌ ' + msg, 'err');
            setElDisplay('payFormBlock', '');
            setElDisplay('generatePixBtn', '');
            return;
          }
          setElDisplay('awaitingPrice', 'none');
          if (res.data.generic) {
            renderGenericPix(res.data.pix_key, cfg);
          } else {
            renderPixResult(res.data, cfg.gateway);
          }
        })
        .catch(function (e) {
          showPixStatus('❌ Falha de conexão. Tente novamente.', 'err');
          setElDisplay('payFormBlock', '');
          setElDisplay('generatePixBtn', '');
          console.error('[pix-modal] fetch error:', e);
        });
    });
  }

  // ── RENDERIZA RESULTADO ────────────────────────────────────
  function renderPixResult(data, gateway) {
    var block = document.getElementById('pixCopyPasteBlock');
    if (!block) return;

    var html = '';

    // QR Code image (se disponível)
    if (data.qr_code_image) {
      html += '<img class="pcp-qr" src="' + escHtml(data.qr_code_image) + '" alt="QR Code PIX">';
    }

    // Copia e cola
    if (data.pix_code) {
      html += '<div class="pcp-label">Pix Copia e Cola</div>';
      html += '<textarea class="pcp-input" readonly>' + escHtml(data.pix_code) + '</textarea>';
      html += '<button class="pcp-copy" onclick="pixModalCopyCodigo()">📋 Copiar código PIX</button>';
    }

    html += '<div class="pcp-timer" id="pixTimer">⏱ O código expira em <strong>30:00</strong></div>';

    block.innerHTML = html;
    block.style.display = '';

    // Salva código para função de cópia
    window._pixCodeToCopy = data.pix_code || '';

    // Countdown de 30 min
    startPixTimer('pixTimer', 30 * 60);
  }

  function renderGenericPix(pixKey, cfg) {
    var block = document.getElementById('pixGenericMsg');
    if (!block) return;

    var html = [
      '<p style="margin:0 0 10px;font-size:13px">Faça a transferência via Pix para a chave abaixo:</p>',
      '<div class="pgm-key-label">Chave PIX</div>',
      '<div class="pgm-key-val">' + escHtml(pixKey) + '</div>',
      '<button class="pgm-copy" onclick="pixModalCopyGenericKey(\'' + escHtml(pixKey) + '\')">📋 Copiar chave PIX</button>',
      '<p style="margin:12px 0 0;font-size:11px;color:var(--text-dim,#888)">Após o pagamento, envie o comprovante para confirmar seu acesso.</p>',
    ].join('');

    block.innerHTML = html;
    block.style.display = '';
  }

  // ── COPY HELPERS ───────────────────────────────────────────
  window.pixModalCopyCodigo = function () {
    copyToClipboard(window._pixCodeToCopy || '', 'Código PIX copiado!');
  };

  window.pixModalCopyGenericKey = function (key) {
    copyToClipboard(key, 'Chave PIX copiada!');
  };

  function onCopyPix() {
    var input = document.getElementById('pixKey');
    if (input) copyToClipboard(input.value, 'Chave PIX copiada!');
  }

  function copyToClipboard(text, msg) {
    if (!text) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { showToast(msg); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(msg);
    }
  }

  // ── TIMER ──────────────────────────────────────────────────
  function startPixTimer(elId, seconds) {
    var remaining = seconds;
    var interval = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        var el = document.getElementById(elId);
        if (el) el.innerHTML = '⚠️ Código expirado. <a href="#" onclick="location.reload();return false">Recarregue a página</a> para tentar novamente.';
        return;
      }
      var m = String(Math.floor(remaining / 60)).padStart(2, '0');
      var s = String(remaining % 60).padStart(2, '0');
      var el = document.getElementById(elId);
      if (el) el.innerHTML = '⏱ O código expira em <strong>' + m + ':' + s + '</strong>';
    }, 1000);
  }

  // ── BIND BOTÕES DE PLANO ───────────────────────────────────
  function bindPlanButtons() {
    document.querySelectorAll('[data-plan-code]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code  = this.dataset.planCode;
        var price = this.dataset.price || this.textContent;
        var label = this.dataset.planLabel || code;
        openPayModal(code, price, label);
      });
    });
  }

  // ── UI HELPERS ─────────────────────────────────────────────
  function showPixStatus(msg, type) {
    var el = document.getElementById('awaitingPrice');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'err' ? '#f44336' : '';
    el.style.display = '';
  }

  function showFormError(fieldId, msg) {
    var el = document.getElementById(fieldId);
    if (el) {
      el.style.borderColor = '#f44336';
      el.focus();
      setTimeout(function () { if (el) el.style.borderColor = ''; }, 2500);
    }
    showToast('⚠️ ' + msg);
  }

  function showToast(msg) {
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);',
      'background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:12px;',
      'font-size:14px;z-index:99999;box-shadow:0 4px 24px rgba(0,0,0,.4);',
      'pointer-events:none;white-space:nowrap;',
    ].join('');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 2800);
  }

  function setElText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function setElDisplay(id, val) {
    var el = document.getElementById(id);
    if (el) el.style.display = val;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
