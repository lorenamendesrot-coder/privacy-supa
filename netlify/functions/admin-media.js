// netlify/functions/admin-media.js
// ============================================================
// Painel simples para adicionar/remover mídias via API
// Protegido por ADMIN_SECRET nas variáveis de ambiente
// ============================================================

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function unauthorized() {
  return { statusCode: 401, body: JSON.stringify({ error: "Não autorizado" }) };
}

exports.handler = async (event) => {
  // Autenticação via header ou query param
  const secret =
    event.headers["x-admin-secret"] ||
    event.queryStringParameters?.secret;

  if (secret !== process.env.ADMIN_SECRET) {
    return unauthorized();
  }

  const headers = { "Content-Type": "application/json" };

  // GET → lista todas as mídias
  if (event.httpMethod === "GET") {
    const { data, error } = await supabase
      .from("medias")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST → adiciona uma mídia
  // Body: { url, thumbnail, type, title, is_free }
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: '{"error":"JSON inválido"}' }; }

    const { url, thumbnail, type, title, is_free } = body;
    if (!url || !type) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "url e type são obrigatórios" }) };
    }

    const { data, error } = await supabase
      .from("medias")
      .insert({ url, thumbnail: thumbnail || null, type, title: title || null, is_free: !!is_free })
      .select()
      .single();

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error }) };
    return { statusCode: 201, headers, body: JSON.stringify(data) };
  }

  // DELETE → remove uma mídia por ID
  // Query: ?id=uuid&secret=xxx
  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return { statusCode: 400, headers, body: '{"error":"id ausente"}' };

    const { error } = await supabase.from("medias").delete().eq("id", id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error }) };
    return { statusCode: 200, headers, body: JSON.stringify({ deleted: true }) };
  }

  return { statusCode: 405, body: "Method Not Allowed" };
};
