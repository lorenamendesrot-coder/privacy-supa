// netlify/functions/get-content.js
// ============================================================
// Valida o token e retorna as mídias desbloqueadas
// Chamado pelo frontend: GET /api/get-content?token=xxx
// ============================================================

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": process.env.SITE_URL || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const token = event.queryStringParameters?.token;

  if (!token) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Token ausente" }),
    };
  }

  // Valida token no banco
  const { data: accessToken, error: tokenError } = await supabase
    .from("access_tokens")
    .select("id, expires_at, used_at, payer_name")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !accessToken) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "Token inválido" }),
    };
  }

  // Verifica expiração
  if (new Date(accessToken.expires_at) < new Date()) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: "Token expirado" }),
    };
  }

  // Marca como usado na primeira vez
  if (!accessToken.used_at) {
    await supabase
      .from("access_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("id", accessToken.id);
  }

  // Busca todas as mídias (livres + pagas)
  const { data: medias, error: mediaError } = await supabase
    .from("medias")
    .select("id, title, url, thumbnail, type, is_free")
    .order("created_at", { ascending: false });

  if (mediaError) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Erro ao buscar mídias" }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      payerName: accessToken.payer_name,
      medias,
    }),
  };
};
