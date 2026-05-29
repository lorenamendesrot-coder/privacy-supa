// netlify/functions/syncpay-cashin.js
// Gera uma cobrança PIX via SyncPayments API
// POST /api/syncpay-cashin
// Body: { amount, client_id, client_secret, site_url }

const SYNCPAY_BASE = "https://app.syncpayments.com.br";

async function getBearerToken(client_id, client_secret) {
  const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/auth-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, client_secret }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SyncPayments auth falhou (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const { amount, client_id, client_secret, site_url } = body;

  if (!amount) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: "Campo obrigatório: amount" }) };
  }
  if (!client_id || !client_secret) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: "Credenciais SyncPayments não configuradas no painel admin." }) };
  }

  try {
    const token = await getBearerToken(client_id, client_secret);

    const webhookUrl = site_url ? `${site_url}/api/pix-webhook` : null;

    const payload = {
      amount: parseFloat(amount),
      description: "Acesso ao conteúdo",
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
