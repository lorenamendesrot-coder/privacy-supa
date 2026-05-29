// supabase/functions/pix-cashin/index.ts
// Gera cobrança PIX via SyncPayments
// POST /functions/v1/pix-cashin
// Body: { amount }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const SYNCPAY_BASE = "https://api.syncpayments.com.br";

let _tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) return _tokenCache.token!;

  const r = await fetch(`${SYNCPAY_BASE}/api/partner/v1/auth-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error(`SyncPayments auth falhou (${r.status}): ${await r.text()}`);
  const d = await r.json();
  _tokenCache = { token: d.access_token, expiresAt: now + (d.expires_in ?? 3600) * 1000 };
  return _tokenCache.token!;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const amount = parseFloat(String(body.amount || "0").replace(",", "."));
  if (!amount || amount <= 0) return json({ error: "Informe um valor válido" }, 422);

  // Lê credenciais do gateway_config no Supabase
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: cfgRow } = await supabase
    .from("site_config")
    .select("value")
    .eq("key", "gateway_config")
    .maybeSingle();

  const cfg = cfgRow?.value as Record<string, string> | null;
  const clientId     = cfg?.syncpay_client_id;
  const clientSecret = cfg?.syncpay_client_secret;
  const siteUrl      = (cfg?.site_url || "").replace(/\/$/, "");

  if (!clientId || !clientSecret) {
    return json({ error: "Credenciais SyncPayments não configuradas no painel admin" }, 500);
  }

  try {
    const token = await getToken(clientId, clientSecret);
    const webhookUrl = siteUrl ? `${siteUrl}/functions/v1/pix-webhook` : null;

    const payload: any = {
      amount,
      description: "Acesso ao conteúdo",
      client: { name: "Cliente", cpf: "00000000000", email: "cliente@privacidade.com", phone: "00000000000" },
    };
    if (webhookUrl) payload.webhook_url = webhookUrl;

    const r = await fetch(`${SYNCPAY_BASE}/api/partner/v1/cash-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) return json({ error: data.message || "Erro ao gerar cobrança", details: data.errors }, r.status);

    return json({ ok: true, pix_code: data.pix_code, identifier: data.identifier });
  } catch (err: any) {
    console.error("[pix-cashin]", err);
    return json({ error: err.message }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
