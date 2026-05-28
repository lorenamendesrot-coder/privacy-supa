// netlify/functions/create-token.js
// Gera um token de acesso manualmente (para o dono ou testes)
// GET /api/create-token?secret=SUA_SENHA&days=365

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };

  const secret = event.queryStringParameters?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Não autorizado" }) };
  }

  const days = parseInt(event.queryStringParameters?.days || "36500"); // padrão: 100 anos (permanente)
  const label = event.queryStringParameters?.label || "acesso-manual";

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  const { error } = await supabase.from("access_tokens").insert({
    token,
    payment_id: label,
    payer_name: label,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error }) };
  }

  const accessUrl = `${process.env.SITE_URL}?token=${token}`;
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, token, accessUrl, expiresAt }),
  };
};
