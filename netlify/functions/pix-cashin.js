// netlify/functions/pix-cashin.js
// Proxy para SyncPay API - lê credenciais do body (vindas do Supabase)

const SYNCPAY = "https://app.syncpayments.com.br";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method Not Allowed" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "JSON inválido" }) }; }

  const { amount, client_id, client_secret, site_url } = body;

  if (!amount)                        return { statusCode: 422, headers: cors, body: JSON.stringify({ error: "amount obrigatório" }) };
  if (!client_id || !client_secret)   return { statusCode: 422, headers: cors, body: JSON.stringify({ error: "Credenciais SyncPay não configuradas no painel admin." }) };

  try {
    // 1. Auth
    const authRes = await fetch(`${SYNCPAY}/api/partner/v1/auth-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret }),
    });
    const authData = await authRes.json();
    if (!authRes.ok || !authData.access_token) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Auth SyncPay falhou: " + (authData.message || authRes.status) }) };
    }

    // 2. Cash-in
    const payload = { amount: parseFloat(amount), description: "Acesso ao conteúdo" };
    if (site_url) payload.webhook_url = site_url + "/api/pix-webhook";

    const cashinRes = await fetch(`${SYNCPAY}/api/partner/v1/cash-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${authData.access_token}` },
      body: JSON.stringify(payload),
    });
    const cashinData = await cashinRes.json();

    if (!cashinRes.ok) return { statusCode: cashinRes.status, headers: cors, body: JSON.stringify({ error: cashinData.message || "Erro ao gerar cobrança" }) };

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, pix_code: cashinData.pix_code, identifier: cashinData.identifier }) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
