// netlify/functions/syncpay-cashin.js
// ============================================================
// Gera uma cobrança PIX via SyncPayments API
// POST /api/syncpay-cashin
// Body: { amount, name, cpf, email, phone }
// ============================================================

const SYNCPAY_BASE = "https://app.syncpayments.com.br";

// Cache simples em memória para o Bearer Token (válido 1h)
let _tokenCache = { token: null, expiresAt: 0 };

async function getBearerToken() {
  const now = Date.now();
  // Reutiliza token se ainda válido (com margem de 60s)
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/auth-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SYNCPAY_CLIENT_ID,
      client_secret: process.env.SYNCPAY_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SyncPayments auth falhou (${res.status}): ${err}`);
  }

  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    // expires_in é em segundos
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };

  return _tokenCache.token;
}

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const { amount, name, cpf, email, phone } = body;

  if (!amount || !name || !cpf || !email || !phone) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ error: "Campos obrigatórios: amount, name, cpf, email, phone" }),
    };
  }

  // Remove formatação do CPF (111.222.333-44 → 11122233344)
  const cpfClean = String(cpf).replace(/\D/g, "");
  // Remove formatação do telefone
  const phoneClean = String(phone).replace(/\D/g, "");

  try {
    const token = await getBearerToken();

    const webhookUrl = process.env.SITE_URL
      ? `${process.env.SITE_URL}/api/pix-webhook`
      : null;

    const payload = {
      amount: parseFloat(amount),
      description: "Acesso ao conteúdo",
      client: {
        name: String(name),
        cpf: cpfClean,
        email: String(email),
        phone: phoneClean,
      },
      ...(webhookUrl && { webhook_url: webhookUrl }),
    };

    const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/cash-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("SyncPayments cashin error:", data);
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: data.message || "Erro ao gerar cobrança", details: data.errors }),
      };
    }

    // Retorna pix_code (copia e cola / QR Code) e identifier da transação
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        pix_code: data.pix_code,
        identifier: data.identifier,
      }),
    };
  } catch (err) {
    console.error("syncpay-cashin error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
