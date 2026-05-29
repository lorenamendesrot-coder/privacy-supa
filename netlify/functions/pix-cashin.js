// netlify/functions/pix-cashin.js
const SYNCPAY = "https://api.syncpayments.com.br";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  const { amount, client_id, client_secret, site_url } = body;

  if (!amount) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: "amount obrigatório" }) };
  }
  if (!client_id || !client_secret) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: "Credenciais SyncPay não configuradas no painel admin." }) };
  }

  // 1. Autenticação
  let access_token;
  try {
    const authRes = await fetch(`${SYNCPAY}/api/partner/v1/auth-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret }),
    });

    const authText = await authRes.text();
    let authData;
    try {
      authData = JSON.parse(authText);
    } catch {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "SyncPay retornou resposta inválida na autenticação: " + authText.substring(0, 100) }) };
    }

    if (!authRes.ok || !authData.access_token) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Auth falhou: " + (authData.message || JSON.stringify(authData)) }) };
    }

    access_token = authData.access_token;
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Erro ao conectar com SyncPay (auth): " + e.message }) };
  }

  // 2. Gerar PIX
  try {
    const payload = {
      amount: parseFloat(amount),
      description: "Acesso ao conteúdo",
    };
    if (site_url) payload.webhook_url = site_url + "/api/pix-webhook";

    const cashinRes = await fetch(`${SYNCPAY}/api/partner/v1/cash-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${access_token}`,
      },
      body: JSON.stringify(payload),
    });

    const cashinText = await cashinRes.text();
    let cashinData;
    try {
      cashinData = JSON.parse(cashinText);
    } catch {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "SyncPay retornou resposta inválida no cash-in: " + cashinText.substring(0, 100) }) };
    }

    if (!cashinRes.ok) {
      return { statusCode: cashinRes.status, headers, body: JSON.stringify({ error: cashinData.message || "Erro ao gerar cobrança", details: cashinData }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, pix_code: cashinData.pix_code, identifier: cashinData.identifier }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Erro ao gerar PIX: " + e.message }) };
  }
};
