// netlify/functions/gateways.js
// ═══════════════════════════════════════════════════════════════
// Para adicionar um novo gateway:
//   1. Crie uma entrada em GATEWAYS com as funções getToken e cashin
//   2. Adicione o parser em PARSERS
//   3. No painel admin, selecione o gateway e salve
// ═══════════════════════════════════════════════════════════════

const _tokenCache = {};

const GATEWAYS = {

  // ── SyncPayments ────────────────────────────────────────────
  syncpay: {
    label: "SyncPayments",
    requiredFields: ["syncpay_client_id", "syncpay_client_secret"],

    async getToken(cfg) {
      const cache = _tokenCache.syncpay || {};
      if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
      const res = await fetch("https://api.syncpayments.com.br/api/partner/v1/auth-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cfg.syncpay_client_id, client_secret: cfg.syncpay_client_secret }),
      });
      if (!res.ok) throw new Error("SyncPay auth falhou (" + res.status + "): " + await res.text());
      const data = await res.json();
      _tokenCache.syncpay = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
      return data.access_token;
    },

    async cashin(cfg, amount, webhookUrl) {
      const token = await GATEWAYS.syncpay.getToken(cfg);
      const payload = { amount: parseFloat(amount), description: "Acesso ao conteúdo" };
      if (webhookUrl) payload.webhook_url = webhookUrl;
      const res = await fetch("https://api.syncpayments.com.br/api/partner/v1/cash-in", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao gerar cobrança SyncPay");
      return { pix_code: data.pix_code, identifier: data.identifier };
    },
  },

  // ── NexusPag ────────────────────────────────────────────────
  // Autenticação: x-api-key no header (sem OAuth)
  // Webhook: header X-Nexuspag-Signature (HMAC-SHA256)
  // Evento confirmado: payment.confirmed
  nexuspag: {
    label: "NexusPag",
    requiredFields: ["nexuspag_api_key"],

    async getToken(cfg) {
      return cfg.nexuspag_api_key;
    },

    async cashin(cfg, amount, webhookUrl) {
      const base = cfg.nexuspag_sandbox
        ? "https://sandbox.api.nexuspag.com"
        : "https://api.nexuspag.com";
      const payload = { amount: parseFloat(amount), description: "Acesso ao conteúdo" };
      if (webhookUrl) payload.webhook_url = webhookUrl;
      const res = await fetch(base + "/v1/pix/cashin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cfg.nexuspag_api_key },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Erro ao gerar cobrança NexusPag");
      return {
        pix_code: data.pix_code || data.qr_code || data.payload,
        identifier: data.id || data.transaction_id,
      };
    },
  },

  // ── Asaas ───────────────────────────────────────────────────
  asaas: {
    label: "Asaas",
    requiredFields: ["asaas_api_key"],

    async getToken(cfg) {
      return cfg.asaas_api_key;
    },

    async cashin(cfg, amount, webhookUrl) {
      const base = cfg.asaas_sandbox
        ? "https://sandbox.asaas.com/api/v3"
        : "https://api.asaas.com/api/v3";
      const headers = { "Content-Type": "application/json", "access_token": cfg.asaas_api_key };
      const dueDate = new Date(Date.now() + 30 * 60 * 1000).toISOString().split("T")[0];
      const res = await fetch(base + "/payments", {
        method: "POST",
        headers,
        body: JSON.stringify({ billingType: "PIX", value: parseFloat(amount), dueDate, description: "Acesso ao conteúdo" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.errors && data.errors[0] && data.errors[0].description) || "Erro ao gerar cobrança Asaas");
      const qrRes = await fetch(base + "/payments/" + data.id + "/pixQrCode", { headers });
      const qrData = await qrRes.json();
      return { pix_code: qrData.payload, identifier: data.id };
    },
  },

  // ── EfiBank ─────────────────────────────────────────────────
  efibank: {
    label: "EfiBank",
    requiredFields: ["efibank_client_id", "efibank_client_secret", "efibank_pix_key"],

    async getToken(cfg) {
      const cache = _tokenCache.efibank || {};
      if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
      const base64 = Buffer.from(cfg.efibank_client_id + ":" + cfg.efibank_client_secret).toString("base64");
      const base = cfg.efibank_sandbox ? "https://pix-h.api.efipay.com.br" : "https://pix.api.efipay.com.br";
      const res = await fetch(base + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + base64 },
        body: JSON.stringify({ grant_type: "client_credentials" }),
      });
      if (!res.ok) throw new Error("EfiBank auth falhou (" + res.status + ")");
      const data = await res.json();
      _tokenCache.efibank = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
      return data.access_token;
    },

    async cashin(cfg, amount, webhookUrl) {
      const token = await GATEWAYS.efibank.getToken(cfg);
      const base = cfg.efibank_sandbox ? "https://pix-h.api.efipay.com.br" : "https://pix.api.efipay.com.br";
      const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + token };
      const res = await fetch(base + "/v2/cob", {
        method: "POST",
        headers,
        body: JSON.stringify({
          calendario: { expiracao: 1800 },
          valor: { original: parseFloat(amount).toFixed(2) },
          chave: cfg.efibank_pix_key,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.mensagem || "Erro ao gerar cobrança EfiBank");
      const qrRes = await fetch(base + "/v2/loc/" + data.loc.id + "/qrcode", { headers });
      const qrData = await qrRes.json();
      return { pix_code: qrData.qrcode, identifier: data.txid };
    },
  },

  // ── PrimePag ────────────────────────────────────────────────
  primepag: {
    label: "PrimePag",
    requiredFields: ["primepag_client_id", "primepag_client_secret"],

    async getToken(cfg) {
      const cache = _tokenCache.primepag || {};
      if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
      const res = await fetch("https://api.primepag.com.br/auth/generate_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cfg.primepag_client_id, client_secret: cfg.primepag_client_secret }),
      });
      if (!res.ok) throw new Error("PrimePag auth falhou (" + res.status + ")");
      const data = await res.json();
      _tokenCache.primepag = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
      return data.access_token;
    },

    async cashin(cfg, amount, webhookUrl) {
      const token = await GATEWAYS.primepag.getToken(cfg);
      const payload = { amount: Math.round(parseFloat(amount) * 100), description: "Acesso ao conteúdo" };
      if (webhookUrl) payload.notification_url = webhookUrl;
      const res = await fetch("https://api.primepag.com.br/v1/pix/qrcode/static", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao gerar cobrança PrimePag");
      return { pix_code: data.qr_code || data.pix_code, identifier: data.transactionId || data.id };
    },
  },
};

// ════════════════════════════════════════════════════════════
// PARSERS — interpreta o webhook recebido por gateway
// ════════════════════════════════════════════════════════════
const PARSERS = {
  syncpay: function(body) {
    const d = body.data;
    if (!d || d.status !== "completed") return null;
    return { paymentId: d.id, status: "approved", amount: d.final_amount || d.amount, payerEmail: d.client && d.client.email, payerName: (d.debtor_account && d.debtor_account.name) || (d.client && d.client.name) };
  },
  nexuspag: function(body) {
    if (body.event !== "payment.confirmed") return null;
    const d = body.data || {};
    return { paymentId: d.id || d.transaction_id, status: "approved", amount: d.amount, payerEmail: d.payer && d.payer.email, payerName: d.payer && d.payer.name };
  },
  asaas: function(body) {
    if (!["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(body.event)) return null;
    return { paymentId: body.payment && body.payment.id, status: "approved", amount: body.payment && body.payment.value, payerName: body.payment && body.payment.customer };
  },
  efibank: function(body) {
    const pix = body.pix && body.pix[0];
    if (!pix) return null;
    return { paymentId: pix.endToEndId || pix.txid, status: "approved", amount: parseFloat(pix.valor), payerName: pix.infoPagador };
  },
  primepag: function(body) {
    if (body.status !== "PAID") return null;
    return { paymentId: body.transactionId, status: "approved", amount: body.amount / 100, payerEmail: body.customer && body.customer.email, payerName: body.customer && body.customer.name };
  },
  mercadopago: function(body) {
    if (body.action !== "payment.updated") return null;
    return { paymentId: String(body.data && body.data.id), status: "approved" };
  },
  generic: function(body) {
    if (body.status === "approved" && body.paymentId) return body;
    return null;
  },
};

function detectGateway(body, headers) {
  const h = (headers && (headers["x-gateway"] || (headers.get && headers.get("x-gateway"))));
  if (h) return h;
  if (body.action && body.action.startsWith("payment")) return "mercadopago";
  if (body.event && body.event.startsWith("PAYMENT_")) return "asaas";
  if (body.event === "payment.confirmed" && body.data && body.data.id) return "nexuspag";
  if (body.pix) return "efibank";
  if (body.transactionId && body.status === "PAID") return "primepag";
  if (body.data && body.data.id && body.data.status) return "syncpay";
  return "generic";
}

module.exports = { GATEWAYS, PARSERS, detectGateway };
