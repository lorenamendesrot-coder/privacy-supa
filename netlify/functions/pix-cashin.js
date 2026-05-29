// netlify/functions/pix-cashin.js
// Para trocar de gateway: mude gateway_config.gateway no painel admin
// Valores aceitos: "syncpay" | "asaas" | "efibank" | "primepag"

const { GATEWAYS } = require("./gateways");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method Not Allowed" }) };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "JSON inválido" }) }; }

  const { amount, site_url, gateway: gatewayName = "syncpay", ...cfg } = body;

  if (!amount) return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: "amount obrigatório" }) };

  const gateway = GATEWAYS[gatewayName];
  if (!gateway) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: `Gateway desconhecido: "${gatewayName}". Use: ${Object.keys(GATEWAYS).join(", ")}` }) };
  }

  // Valida campos obrigatórios do gateway escolhido
  const missing = gateway.requiredFields.filter(f => !cfg[f]);
  if (missing.length) {
    return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: `Campos obrigatórios para ${gateway.label}: ${missing.join(", ")}` }) };
  }

  try {
    const webhookUrl = site_url ? `${site_url}/api/pix-webhook` : null;
    const result = await gateway.cashin(cfg, amount, webhookUrl);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    console.error(`[pix-cashin:${gatewayName}]`, err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
