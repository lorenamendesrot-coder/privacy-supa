// netlify/functions/admin-profile.js
// GET  /api/admin-profile          → leitura pública (frontend usa para carregar config)
// GET  /api/admin-profile?secret=  → mesma coisa (compatível)
// POST /api/admin-profile?secret=  → salva config (requer autenticação)

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async (event) => {
  // GET → leitura pública (sem auth — o frontend da página principal usa isso)
  if (event.httpMethod === "GET") {
    const { data, error } = await supabase
      .from("site_config")
      .select("value")
      .eq("key", "profile")
      .single();

    if (error && error.code !== "PGRST116") {
      return { statusCode: 500, headers, body: JSON.stringify({ error }) };
    }

    const config = data?.value || {};
    return { statusCode: 200, headers, body: JSON.stringify(config) };
  }

  // POST → requer autenticação
  if (event.httpMethod === "POST") {
    const secret =
      event.headers["x-admin-secret"] ||
      event.queryStringParameters?.secret;

    if (secret !== process.env.ADMIN_SECRET) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Não autorizado" }) };
    }

    let body;
    try { body = JSON.parse(event.body); } catch {
      return { statusCode: 400, headers, body: '{"error":"JSON inválido"}' };
    }

    // Tenta UPDATE primeiro; se não existir a row, faz INSERT
    const { data: existing } = await supabase
      .from("site_config")
      .select("key")
      .eq("key", "profile")
      .maybeSingle();

    let dbError;
    if (existing) {
      const { error } = await supabase
        .from("site_config")
        .update({ value: body })
        .eq("key", "profile");
      dbError = error;
    } else {
      const { error } = await supabase
        .from("site_config")
        .insert({ key: "profile", value: body });
      dbError = error;
    }

    if (dbError) {
      console.error("Supabase write error:", JSON.stringify(dbError));
      return { statusCode: 500, headers, body: JSON.stringify({ error: dbError }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
