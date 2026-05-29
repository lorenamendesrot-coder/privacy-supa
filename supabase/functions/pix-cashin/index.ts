// supabase/functions/pix-cashin/index.ts
// ============================================================
// Gera cobrança PIX — suporta todos os gateways configurados
// POST https://<project>.supabase.co/functions/v1/pix-cashin
// Body: { amount, name, cpf, email, phone }
// As credenciais são lidas do gateway_config no Supabase —
// nenhuma env var de gateway é necessária.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Cache de token SyncPayments (memória, por invocação) ─────
let _syncTokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

// ── Entry point ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  let body: any;
  try { body = await req.json(); } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const { amount, name, cpf, email, phone } = body;
  if (!amount || !name || !email) {
    return json({ error: "Campos obrigatórios: amount, name, email" }, 422);
  }

  const amountNum  = parseFloat(String(amount).replace(",", "."));
  const cpfClean   = String(cpf   || "").replace(/\D/g, "");
  const phoneClean = String(phone || "").replace(/\D/g, "");

  // ── Carrega gateway_config do Supabase ───────────────────
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
  if (!cfg || !cfg.gateway) {
    return json({ error: "Gateway de pagamento não configurado no painel admin" }, 500);
  }

  const siteUrl    = (cfg.site_url || "").replace(/\/$/, "");
  const webhookUrl = siteUrl ? `${siteUrl}/functions/v1/pix-webhook` : null;

  const ctx = { amountNum, name: String(name).trim(), cpfClean, email: String(email).trim(), phoneClean, webhookUrl, cfg };

  try {
    switch (cfg.gateway) {
      case "syncpay":     return await handleSyncpay(ctx);
      case "asaas":       return await handleAsaas(ctx);
      case "efibank":     return await handleEfibank(ctx);
      case "mercadopago": return await handleMercadoPago(ctx);
      case "primepag":    return await handlePrimepag(ctx);
      case "generic":     return handleGeneric(ctx);
      default:
        return json({ error: `Gateway desconhecido: ${cfg.gateway}` }, 422);
    }
  } catch (err: any) {
    console.error(`[pix-cashin][${cfg.gateway}]`, err);
    return json({ error: err.message || "Erro interno" }, 500);
  }
});

// ── SYNCPAYMENTS ─────────────────────────────────────────────
async function handleSyncpay({ amountNum, name, cpfClean, email, phoneClean, webhookUrl, cfg }: any) {
  const { syncpay_client_id: clientId, syncpay_client_secret: clientSecret } = cfg;
  if (!clientId || !clientSecret) throw new Error("Credenciais SyncPayments não configuradas");

  const now = Date.now();
  if (!_syncTokenCache.token || now >= _syncTokenCache.expiresAt - 60_000) {
    const r = await fetch("https://app.syncpayments.com.br/api/partner/v1/auth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    if (!r.ok) throw new Error(`SyncPayments auth falhou (${r.status})`);
    const d = await r.json();
    _syncTokenCache = { token: d.access_token, expiresAt: now + (d.expires_in ?? 3600) * 1000 };
  }

  const payload: any = {
    amount: amountNum,
    description: "Acesso ao conteúdo",
    client: { name, cpf: cpfClean, email, phone: phoneClean },
  };
  if (webhookUrl) payload.webhook_url = webhookUrl;

  const res = await fetch("https://app.syncpayments.com.br/api/partner/v1/cash-in", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${_syncTokenCache.token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) return json({ error: data.message || "Erro ao gerar cobrança", details: data.errors }, res.status);
  return json({ ok: true, pix_code: data.pix_code, identifier: data.identifier });
}

// ── ASAAS ─────────────────────────────────────────────────────
async function handleAsaas({ amountNum, name, cpfClean, email, phoneClean, cfg }: any) {
  const apiKey = cfg.asaas_key;
  if (!apiKey) throw new Error("API Key do Asaas não configurada");

  const baseUrl = "https://api.asaas.com/api/v3";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "access_token": apiKey,
  };

  // Busca ou cria cliente
  let customerId: string;
  if (cpfClean) {
    const searchRes = await fetch(`${baseUrl}/customers?cpfCnpj=${cpfClean}`, { headers });
    const searchData = await searchRes.json();
    if (searchData.data?.length > 0) {
      customerId = searchData.data[0].id;
    } else {
      const createRes = await fetch(`${baseUrl}/customers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, cpfCnpj: cpfClean, email, mobilePhone: phoneClean }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.errors?.[0]?.description || "Erro ao criar cliente Asaas");
      customerId = createData.id;
    }
  } else {
    // Sem CPF — cria cliente só com nome/email
    const createRes = await fetch(`${baseUrl}/customers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, email }),
    });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData.errors?.[0]?.description || "Erro ao criar cliente Asaas");
    customerId = createData.id;
  }

  // Cria cobrança PIX
  const dueDate = new Date(Date.now() + 30 * 60 * 1000).toISOString().split("T")[0];
  const chargeRes = await fetch(`${baseUrl}/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      customer: customerId,
      billingType: "PIX",
      value: amountNum,
      dueDate,
      description: "Acesso ao conteúdo",
    }),
  });
  const chargeData = await chargeRes.json();
  if (!chargeRes.ok) throw new Error(chargeData.errors?.[0]?.description || "Erro ao criar cobrança Asaas");

  // Busca QR Code
  const qrRes = await fetch(`${baseUrl}/payments/${chargeData.id}/pixQrCode`, { headers });
  const qrData = await qrRes.json();

  return json({
    ok: true,
    pix_code: qrData.payload,
    qr_code_image: qrData.encodedImage ? `data:image/png;base64,${qrData.encodedImage}` : null,
    identifier: chargeData.id,
  });
}

// ── EFIBANK ───────────────────────────────────────────────────
async function handleEfibank({ amountNum, name, cpfClean, email, webhookUrl, cfg }: any) {
  const clientId     = cfg.efi_client_id;
  const clientSecret = cfg.efi_client_secret;
  if (!clientId || !clientSecret) throw new Error("Credenciais EfiBank não configuradas");

  const credentials = btoa(`${clientId}:${clientSecret}`);

  // Auth
  const authRes = await fetch("https://pix.api.efipay.com.br/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  if (!authRes.ok) throw new Error(`EfiBank auth falhou (${authRes.status})`);
  const { access_token } = await authRes.json();

  const efiHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${access_token}`,
  };

  // Cria cobrança imediata
  const txid = `priv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const cobPayload: any = {
    calendario: { expiracao: 1800 },
    valor: { original: amountNum.toFixed(2) },
    chave: cfg.efi_pix_key || email,
    solicitacaoPagador: "Acesso ao conteúdo",
  };
  if (cpfClean) cobPayload.devedor = { cpf: cpfClean, nome: name };
  if (webhookUrl) cobPayload.webhookUrl = webhookUrl;

  const cobRes = await fetch(`https://pix.api.efipay.com.br/v2/cob/${txid}`, {
    method: "PUT",
    headers: efiHeaders,
    body: JSON.stringify(cobPayload),
  });
  if (!cobRes.ok) {
    const err = await cobRes.json();
    throw new Error(err.detail || "Erro ao criar cobrança EfiBank");
  }
  const cobData = await cobRes.json();

  // Gera QR Code
  const qrRes  = await fetch(`https://pix.api.efipay.com.br/v2/loc/${cobData.loc.id}/qrcode`, { headers: efiHeaders });
  const qrData = await qrRes.json();

  return json({
    ok: true,
    pix_code: qrData.qrcode,
    qr_code_image: qrData.imagemQrcode || null,
    identifier: txid,
  });
}

// ── MERCADO PAGO ──────────────────────────────────────────────
async function handleMercadoPago({ amountNum, name, cpfClean, email, phoneClean, cfg }: any) {
  const accessToken = cfg.mp_token;
  if (!accessToken) throw new Error("Access Token do Mercado Pago não configurado");

  const idempotencyKey = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: any = {
    transaction_amount: amountNum,
    description: "Acesso ao conteúdo",
    payment_method_id: "pix",
    payer: {
      email,
      first_name: name.split(" ")[0],
      last_name: name.split(" ").slice(1).join(" ") || name,
    },
    date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  if (cpfClean) payload.payer.identification = { type: "CPF", number: cpfClean };
  if (phoneClean) payload.payer.phone = { area_code: phoneClean.slice(0, 2), number: phoneClean.slice(2) };

  const res = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "Erro ao criar cobrança MercadoPago");

  const txInfo = data.point_of_interaction?.transaction_data;
  return json({
    ok: true,
    pix_code: txInfo?.qr_code,
    qr_code_image: txInfo?.qr_code_base64 ? `data:image/png;base64,${txInfo.qr_code_base64}` : null,
    identifier: String(data.id),
  });
}

// ── PRIMEPAG ──────────────────────────────────────────────────
async function handlePrimepag({ amountNum, name, cpfClean, email, phoneClean, webhookUrl, cfg }: any) {
  const apiKey    = cfg.primepag_key;
  const apiSecret = cfg.primepag_secret;
  if (!apiKey || !apiSecret) throw new Error("Credenciais PrimePag não configuradas");

  const credentials = btoa(`${apiKey}:${apiSecret}`);
  const payload: any = {
    amount: Math.round(amountNum * 100), // centavos
    description: "Acesso ao conteúdo",
    expiration: 1800,
    customer: { name, email },
  };
  if (cpfClean)   payload.customer.document = cpfClean;
  if (phoneClean) payload.customer.phone    = phoneClean;
  if (webhookUrl) payload.callback_url      = webhookUrl;

  const res = await fetch("https://api.primepag.com.br/v1/charges/pix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Erro ao criar cobrança PrimePag");

  return json({
    ok: true,
    pix_code: data.pix?.emv || data.qr_code,
    qr_code_image: data.pix?.image ? `data:image/png;base64,${data.pix.image}` : null,
    identifier: data.id || data.transactionId,
  });
}

// ── GENÉRICO ─────────────────────────────────────────────────
function handleGeneric({ cfg }: any) {
  const pixKey = cfg.generic_pix_key;
  if (!pixKey) return json({ error: "Chave PIX genérica não configurada no painel admin" }, 422);
  return json({ ok: true, generic: true, pix_key: pixKey });
}

// ── HELPER ───────────────────────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
