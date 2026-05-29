// netlify/functions/pix-webhook.js
// Para adicionar novo gateway: vá em gateways.js e adicione um parser em PARSERS

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { PARSERS, detectGateway } = require("./gateways");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  const gateway = detectGateway(body, event.headers);
  const parser  = PARSERS[gateway] || PARSERS.generic;
  const parsed  = parser(body);

  if (!parsed || parsed.status !== "approved") {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, gateway }) };
  }

  // Evita duplicata
  const { data: existing } = await supabase
    .from("access_tokens").select("id, token")
    .eq("payment_id", parsed.paymentId).maybeSingle();

  if (existing) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, token: existing.token, duplicate: true }) };
  }

  const token = generateToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);

  const { error } = await supabase.from("access_tokens").insert({
    token,
    payment_id:  parsed.paymentId,
    payer_email: parsed.payerEmail || null,
    payer_name:  parsed.payerName  || null,
    amount:      parsed.amount     || null,
    expires_at:  expiresAt.toISOString(),
  });

  if (error) {
    console.error("Supabase insert error:", error);
    return { statusCode: 500, body: "DB error" };
  }

  const siteUrl  = process.env.SITE_URL || "";
  const accessUrl = `${siteUrl}?token=${token}`;
  console.log(`✅ Acesso liberado | gateway: ${gateway} | payment: ${parsed.paymentId} | url: ${accessUrl}`);

  return { statusCode: 200, body: JSON.stringify({ ok: true, token, accessUrl }) };
};
